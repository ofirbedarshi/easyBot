#!/usr/bin/env node
/**
 * Live handleMessage replay of the owner review-chats report + one follow-up.
 * Uses the real review-chats model. Not part of the default test suite.
 *
 *   OPENAI_MODEL=gpt-6-luna node scripts/replay-review-chats.js
 *
 * Costs a few cents. Isolated memory store; does not touch data/business-profile.json.
 */
import 'dotenv/config';
import { attachCostTracker } from './lib/modelCost.js';
import { CHATS_FOOTER } from '../src/copy.js';
import { emptyProfile } from '../src/profile.js';
import { createSenderSession, handleMessage } from '../src/session.js';
import { menuActive, renderMenu } from '../src/ownerNav.js';
import { ownerPhase } from '../src/ownerPhase.js';
import { createMemoryStore } from '../src/store/memoryStore.js';

process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
process.env.OPENAI_BUILDER_MODEL = process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';

const MODEL = process.env.OPENAI_MODEL;
const SENDER = 'whatsapp:+15551239999';
const UNANSWERED = 'keratin treatments';
const FOLLOW_UP = 'what exactly did she ask about the keratin?';

const cost = attachCostTracker(MODEL);

function draft() {
  return {
    name: 'Scissors and Sage Salon',
    whatWeDo: 'Hair salon in Columbus, Ohio',
    services: [
      { name: "Women's cut", price: '$45', notes: null },
      { name: "Men's cut", price: '$30', notes: null },
    ],
    hours: 'Tue–Sat 9–6, closed Sunday and Monday',
    locationOrArea: 'Columbus, Ohio',
    commonQuestions: [
      { question: "How much is a women's cut?", answer: "A women's cut is $45." },
    ],
    informationToCollect: ['name', 'phone', 'preferred time'],
    unknowns: [],
    otherFacts: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    askedTopics: ['commonQuestions', 'informationToCollect'],
  };
}

function seededProfile() {
  const d = draft();
  return {
    ...emptyProfile(),
    ...d,
    approvedAt: '2026-01-01T00:00:00.000Z',
    firstTestedAt: '2026-01-02T00:00:00.000Z',
    draft: d,
  };
}

function isoMinutesAgo(mins) {
  return new Date(Date.now() - mins * 60 * 1000).toISOString();
}

async function seedChat(store, senderId, turns, createdAt) {
  for (const turn of turns) {
    await store.appendMessage({
      senderId,
      direction: turn.direction,
      body: turn.body,
      mode: turn.mode || 'test',
      createdAt,
    });
  }
}

function fail(message, extra) {
  console.error(`FAIL ${message}`);
  if (extra) console.error(extra);
  cost.print();
  process.exit(1);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }

  const store = createMemoryStore();
  const profile = seededProfile();
  await store.saveProfile(SENDER, profile);
  await store.saveSession(SENDER, {
    mode: 'BUILD',
    buildHistory: [
      {
        role: 'assistant',
        content: renderMenu({ leadOption: true, chatsOption: true }),
        nav: 'menu',
      },
    ],
    testHistory: [],
    testSessionId: 't',
    ownerName: 'Dana',
  });

  await store.appendMessage({
    senderId: SENDER,
    direction: 'inbound',
    body: 'Do you offer midnight moon yoga?',
    mode: 'test',
    createdAt: isoMinutesAgo(4 * 60 + 10),
  });
  await store.appendMessage({
    senderId: SENDER,
    direction: 'outbound',
    body: 'I do not have that on file.',
    mode: 'test',
    createdAt: isoMinutesAgo(4 * 60 + 9),
  });
  await store.appendMessage({
    senderId: SENDER,
    direction: 'inbound',
    body: '/test',
    mode: 'command',
    createdAt: isoMinutesAgo(40),
  });

  await seedChat(
    store,
    SENDER,
    [
      { direction: 'inbound', body: "How much is a women's cut?" },
      { direction: 'outbound', body: "A women's cut is $45. What's your name and preferred time?" },
      { direction: 'inbound', body: "I'm Maya, Saturday afternoon." },
      { direction: 'outbound', body: 'Thanks Maya — I have your name and Saturday afternoon.' },
    ],
    isoMinutesAgo(35)
  );

  await store.appendMessage({
    senderId: SENDER,
    direction: 'inbound',
    body: 'stop',
    mode: 'command',
    createdAt: isoMinutesAgo(20),
  });
  await store.appendMessage({
    senderId: SENDER,
    direction: 'inbound',
    body: '/test',
    mode: 'command',
    createdAt: isoMinutesAgo(15),
  });

  await seedChat(
    store,
    SENDER,
    [
      {
        direction: 'inbound',
        body: 'Hi, do you offer keratin treatments? I want to book one for next week.',
      },
      {
        direction: 'outbound',
        body: "I don't have information about keratin treatments here, so I can't answer that yet. I can help with cuts.",
      },
    ],
    isoMinutesAgo(12)
  );

  const session = await createSenderSession(store, SENDER);
  session.ownerName = 'Dana';

  const reportRes = await handleMessage(session, '3');
  if (reportRes.event !== 'enter_chats') {
    fail(`expected enter_chats, got ${reportRes.event}`, reportRes.reply);
  }
  if (!reportRes.reply?.includes(CHATS_FOOTER)) {
    fail('report missing footer', reportRes.reply);
  }
  if (!/keratin/i.test(reportRes.reply)) {
    fail('report did not name the unanswered keratin question', reportRes.reply);
  }
  if (!/teach me|next time|i'?ll know|know it next/i.test(reportRes.reply)) {
    fail('report did not invite the owner to teach Adam', reportRes.reply);
  }
  if (/moon yoga/i.test(reportRes.reply)) {
    fail('report included a chat older than 3 hours', reportRes.reply);
  }
  if (ownerPhase(session) !== 'chats') {
    fail(`expected chats phase, got ${ownerPhase(session)}`);
  }

  const followRes = await handleMessage(session, FOLLOW_UP);
  if (followRes.event !== 'chats_turn') {
    fail(`expected chats_turn, got ${followRes.event}`, followRes.reply);
  }
  if (!/keratin/i.test(followRes.reply)) {
    fail('follow-up did not stay on the keratin question', followRes.reply);
  }
  if (!followRes.reply?.includes(CHATS_FOOTER)) {
    fail('follow-up missing footer', followRes.reply);
  }

  const menuRes = await handleMessage(session, 'menu');
  if (menuRes.event !== 'menu' || !menuActive(session.buildHistory)) {
    fail('menu did not exit review-chats', menuRes.reply);
  }

  console.log('\n======== LIVE REVIEW-CHATS REPORT ========');
  console.log(reportRes.reply);
  console.log('\n======== FOLLOW-UP ========');
  console.log(`Q: ${FOLLOW_UP}`);
  console.log(`A:\n${followRes.reply}`);
  console.log('\nPASS review-chats replay');
  console.log(`unanswered=${UNANSWERED}`);
  cost.print();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
