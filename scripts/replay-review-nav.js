#!/usr/bin/env node
/**
 * Live handleMessage replay of review-option handling after intervening turns.
 * Uses the real Builder. Not part of the default test suite.
 *
 *   OPENAI_BUILDER_MODEL=gpt-6-luna node scripts/replay-review-nav.js
 *
 * Costs a few cents. Isolated profile file; does not touch data/business-profile.json.
 */
import 'dotenv/config';
import fs from 'fs';
import { attachCostTracker } from './lib/modelCost.js';
import { createSession, handleMessage } from '../src/session.js';
import {
  emptyProfile,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import {
  interveningBuilderQuestion,
  lastAssistant,
  lastShownNav,
  menuActive,
  renderReadyFirst,
  reviewActive,
} from '../src/ownerNav.js';

process.env.OPENAI_BUILDER_MODEL = process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';

const PROFILE = testProfilePath('replay-review-nav');
const MODEL = process.env.OPENAI_BUILDER_MODEL;

function draft() {
  return {
    name: 'Scissors and Sage Salon',
    whatWeDo: 'Hair salon in Columbus, Ohio',
    services: [
      { name: "Women's cut", price: '$45', notes: null },
      { name: "Men's cut", price: '$30', notes: null },
      { name: "Kids' cut (under 10)", price: '$25', notes: null },
      { name: 'Blowout', price: '$35', notes: null },
    ],
    hours: 'Tue–Sat 9–6, closed Sunday and Monday',
    locationOrArea: 'Columbus, Ohio',
    commonQuestions: [
      { question: "How much is a women's cut?", answer: "A women's cut is $45." },
    ],
    informationToCollect: ['name', 'phone', 'preferred time'],
    unknowns: [],
    otherFacts: [
      'The salon does not offer nail services.',
      'The salon does not offer braids or extensions.',
    ],
    tone: null,
    priceDisclosure: null,
    assistantName: null,
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
    draft: d,
  };
}

function seedSession() {
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
  const profile = seededProfile();
  saveProfile(profile, PROFILE);
  const session = createSession({ profilePath: PROFILE });
  session.buildHistory.push({
    role: 'assistant',
    content: 'Hi! Tell me a little about your business.',
  });
  session.buildHistory.push({
    role: 'user',
    content: 'hair salon in columbus ohio, Scissors and Sage Salon',
  });
  session.buildHistory.push({
    role: 'assistant',
    content: renderReadyFirst({ leadOption: false }),
    nav: 'menu',
  });
  return { session, profile };
}

function line(role, text) {
  const body = String(text || '').trim();
  const clipped = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  return `[${role}] ${clipped}`;
}

function flagLine(session, extra) {
  const last = lastAssistant(session.buildHistory);
  return [
    `reviewActive=${reviewActive(session.buildHistory)}`,
    `menuActive=${menuActive(session.buildHistory)}`,
    `lastNav=${lastShownNav(session.buildHistory)}`,
    `asksQuestion=${last?.asksQuestion === true}`,
    `intervening=${interveningBuilderQuestion(session.buildHistory)}`,
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }

  const cost = attachCostTracker(MODEL);
  const transcript = [];
  const results = [];

  transcript.push(`model=${MODEL}`);

  // Case A: customer-style answer restores the editing menu; Try my bot still works.
  const courtesy = seedSession();
  transcript.push('');
  transcript.push('--- courtesy / answer (menu comes back; Try my bot still works) ---');
  transcript.push(flagLine(courtesy.session));
  transcript.push(line('APP', courtesy.session.buildHistory.at(-1).content));
  const priceQ = 'how much is a womens haircut?';
  transcript.push(line('OWNER', priceQ));
  const mid = await handleMessage(courtesy.session, priceQ);
  transcript.push(`event=${mid.event} source=${mid.source} mode=${courtesy.session.mode} ${flagLine(courtesy.session)}`);
  transcript.push(line('APP', mid.reply));
  const tryA = await handleMessage(courtesy.session, 'chat with me like a customer');
  transcript.push(line('OWNER', 'chat with me like a customer'));
  transcript.push(`event=${tryA.event} source=${tryA.source} mode=${courtesy.session.mode}`);
  transcript.push(line('APP', tryA.reply));
  const menuRestored = menuActive(courtesy.session.buildHistory) || lastShownNav(courtesy.session.buildHistory) === 'menu';
  const okCourtesy =
    mid.event === 'build_turn' &&
    !interveningBuilderQuestion(courtesy.session.buildHistory) &&
    (menuRestored || reviewActive(courtesy.session.buildHistory)) &&
    tryA.event === 'enter_test' &&
    courtesy.session.mode === 'TEST' &&
    /\*Test mode is on\*/.test(tryA.reply);
  results.push(
    okCourtesy
      ? 'PASS courtesy/answer restored next-step UI and Try my bot entered TEST'
      : 'FAIL courtesy/answer then Try my bot did not enter TEST'
  );

  // Case B: after ready, a Builder turn attaches the menu; 1 is Chat.
  const question = seedSession();
  transcript.push('');
  transcript.push('--- real question (1 is Chat with me like a customer) ---');
  const staffQ =
    'I have not given you our stylist count. Ask me how many stylists we have before you store anything about staffing — I will answer with a number next.';
  transcript.push(line('OWNER', staffQ));
  const asked = await handleMessage(question.session, staffQ);
  transcript.push(`event=${asked.event} source=${asked.source} mode=${question.session.mode} ${flagLine(question.session)}`);
  transcript.push(line('APP', asked.reply));
  const questionFlag = lastAssistant(question.session.buildHistory)?.asksQuestion === true;
  const oneB = await handleMessage(question.session, '1');
  transcript.push(line('OWNER', '1'));
  transcript.push(`event=${oneB.event} source=${oneB.source} mode=${question.session.mode}`);
  transcript.push(line('APP', oneB.reply));
  const okQuestionTurn =
    asked.event === 'build_turn' &&
    lastShownNav(question.session.buildHistory) !== 'review' &&
    !questionFlag &&
    oneB.event === 'enter_test' &&
    question.session.mode === 'TEST' &&
    /\*Test mode is on\*/.test(oneB.reply);
  results.push(
    okQuestionTurn
      ? 'PASS real question then 1 entered TEST (Chat is menu item 1)'
      : `FAIL real question then 1 event=${oneB.event} mode=${question.session.mode} asksQuestion=${questionFlag}`
  );

  // Same-draft re-present: model text plus the editing menu.
  const second = seedSession();
  const show = 'please show the current bot';
  transcript.push('');
  transcript.push('--- same-draft re-present ---');
  transcript.push(line('OWNER', show));
  const shown = await handleMessage(second.session, show);
  transcript.push(`event=${shown.event} nav=${lastShownNav(second.session.buildHistory)} presentStarts=${JSON.stringify(String(shown.reply || '').slice(0, 80))}`);
  transcript.push(line('APP', shown.reply));
  const okShown =
    shown.event === 'build_turn' &&
    lastShownNav(second.session.buildHistory) === 'menu' &&
    /Pick a number/.test(shown.reply) &&
    !String(shown.reply || '').startsWith("Here's your bot for");
  results.push(
    okShown
      ? 'PASS same-draft show-bot is model text plus menu'
      : 'FAIL same-draft show-bot was not model-plus-menu'
  );

  const text = transcript.join('\n');
  console.log(text);
  console.log('');
  for (const r of results) console.log(r);

  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
  cost.print();
  if (!okCourtesy || !okQuestionTurn || !okShown) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
