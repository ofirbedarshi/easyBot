#!/usr/bin/env node
/**
 * Live handleMessage replay of review-option handling after intervening turns.
 * Uses the real Builder. Not part of the default test suite.
 *
 *   OPENAI_BUILDER_MODEL=gpt-6-luna node scripts/replay-review-nav.js
 *
 * Costs a few cents. Isolated profile file; does not touch data/business-profile.json.
 */
import fs from 'fs';
import { createSession, handleMessage, reviewPending } from '../src/session.js';
import {
  draftReviewKey,
  emptyProfile,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import { lastShownNav, renderReview, reviewActive } from '../src/ownerNav.js';

process.env.OPENAI_BUILDER_MODEL = process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';

const PROFILE = testProfilePath('replay-review-nav');
const MODEL = process.env.OPENAI_BUILDER_MODEL;

function draft() {
  return {
    name: 'Scissors and Sage Salon',
    whatWeDo: 'Hair salon in Columbus, Ohio',
    ownerGoal: 'answer_and_collect',
    ownerGoalRequested: 'answer questions and collect details',
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
    responseLength: null,
    priceDisclosure: null,
    assistantName: null,
    openingMessage: null,
    askedTopics: ['commonQuestions', 'informationToCollect'],
  };
}

function seededProfile() {
  const d = draft();
  const base = { ...emptyProfile(), draft: d };
  return {
    ...base,
    reviewedDraftKey: draftReviewKey(base, d),
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
    content: renderReview(profile),
    nav: 'review',
  });
  return { session, profile };
}

function line(role, text) {
  const body = String(text || '').trim();
  const clipped = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  return `[${role}] ${clipped}`;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }

  const transcript = [];
  const { session, profile } = seedSession();
  transcript.push(`model=${MODEL}`);
  transcript.push(`reviewActive=${reviewActive(session.buildHistory)} lastNav=${lastShownNav(session.buildHistory)}`);
  transcript.push(`reviewPending=${reviewPending(profile)}`);
  transcript.push(line('APP', session.buildHistory.at(-1).content));

  const q = 'how much is a womens haircut?';
  transcript.push(line('OWNER', q));
  const mid = await handleMessage(session, q);
  transcript.push(`event=${mid.event} source=${mid.source} mode=${session.mode} reviewActive=${reviewActive(session.buildHistory)}`);
  transcript.push(line('APP', mid.reply));

  const one = await handleMessage(session, '1');
  transcript.push(line('OWNER', '1'));
  transcript.push(`event=${one.event} source=${one.source} mode=${session.mode} approved=${!!one.approved}`);
  transcript.push(line('APP', one.reply));

  const okTry =
    one.event === 'approved_enter_test' &&
    session.mode === 'TEST' &&
    /TEST mode/.test(one.reply);

  // Second session: re-present the same draft; ack must not be prepended.
  const second = seedSession();
  const show = 'please show the current bot';
  transcript.push('');
  transcript.push('--- same-draft re-present ---');
  transcript.push(line('OWNER', show));
  const shown = await handleMessage(second.session, show);
  transcript.push(`event=${shown.event} readyForReview=${shown.readyForReview} presentStarts=${JSON.stringify(String(shown.reply || '').slice(0, 80))}`);
  transcript.push(line('APP', shown.reply));
  const cleanSummary =
    shown.readyForReview === true &&
    String(shown.reply || '').startsWith("Here's your bot for Scissors and Sage Salon:");

  const text = transcript.join('\n');
  console.log(text);
  console.log('');
  console.log(okTry ? 'PASS 1 after intervening turn entered Try my bot / TEST' : 'FAIL 1 did not enter TEST');
  if (shown.readyForReview) {
    console.log(cleanSummary ? 'PASS same-draft review has no prepended ack' : 'FAIL same-draft review prepended extra text');
  } else {
    console.log('SKIP same-draft review (model did not present a review)');
  }

  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
  if (!okTry) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
