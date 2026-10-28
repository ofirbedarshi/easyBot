#!/usr/bin/env node
/**
 * Live handleMessage replay of owner review-chats: report, follow-up,
 * (a) teach a missing price, (b) unclear teach then a number. Uses the real
 * review-chats and Builder models. Not part of the default test suite.
 *
 *   OPENAI_MODEL=gpt-6-luna node scripts/replay-review-chats.js
 *
 * Costs a few cents. Isolated memory store; does not touch data/business-profile.json.
 */
import 'dotenv/config';
import { attachCostTracker } from './lib/modelCost.js';
import { CHATS_FOOTER, REVIEW, businessDetailsAck } from '../src/copy.js';
import { emptyProfile } from '../src/profile.js';
import { createSenderSession, handleMessage } from '../src/session.js';
import { menuActive, renderMenu } from '../src/ownerNav.js';
import { ownerPhase } from '../src/ownerPhase.js';
import { createMemoryStore } from '../src/store/memoryStore.js';

process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-6-luna';
process.env.OPENAI_BUILDER_MODEL = process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';

const MODEL = process.env.OPENAI_MODEL;
const SENDER = 'whatsapp:+15551239999';
const UNANSWERED = 'haircut price';
const FOLLOW_UP = 'what exactly did she ask about the price?';
const TEACH_A = 'The price is 8 dollar';
const TEACH_UNCLEAR = "it's cheaper now";
const TEACH_NUMBER = '6';

const cost = attachCostTracker(MODEL);

function draft() {
  return {
    name: 'Scissors and Sage Salon',
    whatWeDo: 'Hair salon in Columbus, Ohio',
    services: [
      { name: "Women's cut", price: null, notes: null },
      { name: "Men's cut", price: '$30', notes: null },
    ],
    hours: 'Tue–Sat 9–6, closed Sunday and Monday',
    locationOrArea: 'Columbus, Ohio',
    commonQuestions: [],
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

function serviceSnapshot(profile) {
  return (profile?.services || []).map((s) => ({
    name: s.name,
    price: s.price ?? null,
  }));
}

function womensPrice(profile) {
  const row = (profile?.services || []).find((s) => /women/i.test(s.name || ''));
  return row?.price ?? null;
}

function priceLooksLike(value, n) {
  const s = String(value || '');
  return new RegExp(`\\$?\\s*${n}\\b`).test(s);
}

function claimsRemembered(text) {
  return /\b(i(?:['’]ll| will)? remember|i(?:['’]ve| have) (?:remembered|saved|added|noted)|saved that|i(?:['’]ll| will) (?:save|add|know))\b/i.test(
    String(text || '')
  );
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
      {
        direction: 'outbound',
        body: "I don't have the haircut price here, so I can't answer that yet. What's your name and preferred time?",
      },
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

  const profileBefore = await store.loadProfile(SENDER);

  const reportRes = await handleMessage(session, '3');
  if (reportRes.event !== 'enter_chats') {
    fail(`expected enter_chats, got ${reportRes.event}`, reportRes.reply);
  }
  if (!reportRes.reply?.includes(CHATS_FOOTER)) {
    fail('report missing footer', reportRes.reply);
  }
  if (!/price|haircut|women'?s cut/i.test(reportRes.reply)) {
    fail('report did not name the unanswered haircut price', reportRes.reply);
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
  if (!/price|cut|how much/i.test(followRes.reply)) {
    fail('follow-up did not stay on the price question', followRes.reply);
  }
  if (!followRes.reply?.includes(CHATS_FOOTER)) {
    fail('follow-up missing footer', followRes.reply);
  }

  const teachA = await handleMessage(session, TEACH_A);
  if (teachA.event !== 'chats_turn') {
    fail(`expected chats_turn on teach (a), got ${teachA.event}`, teachA.reply);
  }
  if (ownerPhase(session) !== 'chats') {
    fail(`expected chats phase after teach (a), got ${ownerPhase(session)}`);
  }
  if (!teachA.reply?.includes(CHATS_FOOTER)) {
    fail('teach (a) missing footer', teachA.reply);
  }
  if (!teachA.reply?.includes(businessDetailsAck('Dana'))) {
    fail('teach (a) missing save ack', teachA.reply);
  }
  if (!teachA.reply?.includes(REVIEW.changesIntro)) {
    fail('teach (a) missing change card', teachA.reply);
  }
  const afterA = await store.loadProfile(SENDER);
  if (!priceLooksLike(womensPrice(afterA), 8)) {
    fail(`(a) expected women's cut price 8, got ${JSON.stringify(serviceSnapshot(afterA))}`);
  }

  const teachB = await handleMessage(session, TEACH_UNCLEAR);
  if (teachB.event !== 'chats_turn') {
    fail(`expected chats_turn on teach (b), got ${teachB.event}`, teachB.reply);
  }
  if (ownerPhase(session) !== 'chats') {
    fail(`expected chats phase after unclear teach, got ${ownerPhase(session)}`);
  }
  if (!teachB.reply?.includes(CHATS_FOOTER)) {
    fail('unclear teach missing footer', teachB.reply);
  }
  if (teachB.reply?.includes(REVIEW.changesIntro) || teachB.reply?.includes(businessDetailsAck('Dana'))) {
    fail('unclear teach must not show a save card', teachB.reply);
  }
  if (claimsRemembered(teachB.reply)) {
    fail('unclear teach claimed it remembered or saved', teachB.reply);
  }
  if (!/\?/.test(teachB.reply || '')) {
    fail('unclear teach did not ask a clarifying question', teachB.reply);
  }
  const afterB = await store.loadProfile(SENDER);
  if (JSON.stringify(serviceSnapshot(afterB)) !== JSON.stringify(serviceSnapshot(afterA))) {
    fail(
      '(b) services changed on unclear teach',
      JSON.stringify({ before: serviceSnapshot(afterA), after: serviceSnapshot(afterB) })
    );
  }

  const teachC = await handleMessage(session, TEACH_NUMBER);
  if (teachC.event !== 'chats_turn') {
    fail(`expected chats_turn on number, got ${teachC.event}`, teachC.reply);
  }
  if (ownerPhase(session) !== 'chats') {
    fail(`expected chats phase after number, got ${ownerPhase(session)}`);
  }
  if (!teachC.reply?.includes(CHATS_FOOTER)) {
    fail('number teach missing footer', teachC.reply);
  }
  if (!teachC.reply?.includes(businessDetailsAck('Dana'))) {
    fail('number teach missing save ack', teachC.reply);
  }
  if (!teachC.reply?.includes(REVIEW.changesIntro)) {
    fail('number teach missing change card', teachC.reply);
  }
  const afterC = await store.loadProfile(SENDER);
  if (!priceLooksLike(womensPrice(afterC), 6)) {
    fail(`(b) expected women's cut price 6 after the number, got ${JSON.stringify(serviceSnapshot(afterC))}`);
  }

  const keratinStillMissing = session.reviewChats?.snapshot
    ?.flat()
    .some((m) => /don't have information about keratin/i.test(m.body || ''));
  if (!keratinStillMissing) {
    fail('snapshot was rewritten; keratin gap should stay in the historical chats');
  }

  const menuRes = await handleMessage(session, 'menu');
  if (menuRes.event !== 'menu' || !menuActive(session.buildHistory)) {
    fail('menu did not exit review-chats', menuRes.reply);
  }

  console.log('\n======== PROFILE BEFORE ========');
  console.log(JSON.stringify(serviceSnapshot(profileBefore), null, 2));
  console.log('\n======== LIVE REVIEW-CHATS REPORT ========');
  console.log(reportRes.reply);
  console.log('\n======== FOLLOW-UP ========');
  console.log(`Q: ${FOLLOW_UP}`);
  console.log(`A:\n${followRes.reply}`);
  console.log('\n======== TEACH (a) ========');
  console.log(`Q: ${TEACH_A}`);
  console.log(`A:\n${teachA.reply}`);
  console.log('PROFILE AFTER (a):');
  console.log(JSON.stringify(serviceSnapshot(afterA), null, 2));
  console.log('\n======== TEACH (b) UNCLEAR ========');
  console.log(`Q: ${TEACH_UNCLEAR}`);
  console.log(`A:\n${teachB.reply}`);
  console.log('PROFILE AFTER (b) unclear:');
  console.log(JSON.stringify(serviceSnapshot(afterB), null, 2));
  console.log('\n======== TEACH (b) NUMBER ========');
  console.log(`Q: ${TEACH_NUMBER}`);
  console.log(`A:\n${teachC.reply}`);
  console.log('PROFILE AFTER (b) number:');
  console.log(JSON.stringify(serviceSnapshot(afterC), null, 2));
  console.log('\nPASS review-chats replay');
  console.log(`unanswered=${UNANSWERED}`);
  cost.print();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
