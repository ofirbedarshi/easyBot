#!/usr/bin/env node
/**
 * Live handleMessage replay: a stored fact is corrected, then the owner asks
 * to see the summary. The old value must leave every stored copy, and the
 * summary must be renderReview with nav 'review'.
 *
 *   OPENAI_BUILDER_MODEL=gpt-6-luna node scripts/replay-stale-facts.js
 *
 * Costs a few cents. Isolated profile file; does not touch data/business-profile.json.
 */
import 'dotenv/config';
import fs from 'fs';
import { attachCostTracker } from './lib/modelCost.js';
import { createSession, handleMessage } from '../src/session.js';
import {
  draftReviewKey,
  emptyProfile,
  saveProfile,
  loadProfile,
  testProfilePath,
} from '../src/profile.js';
import { lastShownNav, renderReview } from '../src/ownerNav.js';

process.env.OPENAI_BUILDER_MODEL = process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';

const PROFILE = testProfilePath('replay-stale-facts');
const MODEL = process.env.OPENAI_BUILDER_MODEL;
const OLD = '$41 per visit';
const NEW_TOKEN = '$47';

function draft() {
  return {
    name: 'Oak Street Repair',
    whatWeDo: 'Home repair visits in Dayton, Ohio',
    ownerGoal: 'answer_questions',
    ownerGoalRequested: 'answer customer questions',
    services: [
      { name: 'Standard visit', price: OLD, notes: null },
      { name: 'Electrical visit', price: '$110 per visit', notes: null },
    ],
    hours: 'Monday–Friday, 8 AM–5 PM',
    locationOrArea: 'Dayton and Kettering',
    commonQuestions: [
      {
        question: 'What are your prices?',
        answer: `A standard visit is ${OLD}; an electrical visit is $110 per visit.`,
      },
    ],
    informationToCollect: [],
    unknowns: [],
    otherFacts: [`A standard visit is ${OLD} on weekdays.`],
    tone: null,
    responseLength: null,
    priceDisclosure: null,
    assistantName: null,
    openingMessage: `Welcome — a standard visit starts at ${OLD}.`,
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
    content: 'home repair in dayton ohio, Oak Street Repair',
  });
  session.buildHistory.push({
    role: 'assistant',
    content: renderReview(profile),
    nav: 'review',
  });
  return session;
}

function storedBlob(profile) {
  const d = profile?.draft || {};
  return JSON.stringify({
    name: d.name,
    whatWeDo: d.whatWeDo,
    services: d.services,
    hours: d.hours,
    locationOrArea: d.locationOrArea,
    commonQuestions: d.commonQuestions,
    otherFacts: d.otherFacts,
    openingMessage: d.openingMessage,
  });
}

function clip(text) {
  const body = String(text || '').trim();
  return body.length > 900 ? `${body.slice(0, 900)}…` : body;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }

  const cost = attachCostTracker(MODEL);
  const session = seedSession();
  const lines = [`model=${MODEL}`, ''];
  const results = [];

  const correction = 'wait, a standard visit is 47 not 41. keep the electrical visit as it is.';
  lines.push(`[OWNER] ${correction}`);
  const corrected = await handleMessage(session, correction);
  lines.push(
    `event=${corrected.event} consistencyRan=${corrected.consistencyRan} consistencyMs=${corrected.consistencyMs}`
  );
  lines.push(`[APP] ${clip(corrected.reply)}`);

  const afterCorrection = loadProfile(PROFILE);
  const blob = storedBlob(afterCorrection);
  const stale = blob.includes(OLD) || blob.includes('$41');
  const hasNew = blob.includes(NEW_TOKEN) || blob.includes('47');
  results.push(
    stale
      ? `FAIL stored copy still has ${OLD}`
      : `PASS no stored copy of ${OLD}`
  );
  results.push(hasNew ? `PASS stored draft has ${NEW_TOKEN}` : `FAIL stored draft missing ${NEW_TOKEN}`);
  results.push(
    `consistency pass: ran=${!!corrected.consistencyRan} latencyMs=${corrected.consistencyMs ?? 0}`
  );

  const show = 'show me the updated summary';
  lines.push('');
  lines.push(`[OWNER] ${show}`);
  const shown = await handleMessage(session, show);
  const profile = loadProfile(PROFILE);
  const review = renderReview(profile);
  const nav = lastShownNav(session.buildHistory);
  lines.push(`event=${shown.event} nav=${nav} wantsReview=${shown.wantsReview}`);
  lines.push(`[APP] ${clip(shown.reply)}`);

  const isReview = nav === 'review' && String(shown.reply || '').includes(review);
  results.push(isReview ? 'PASS reply is renderReview with nav review' : 'FAIL reply was not renderReview/nav review');
  results.push(
    /\nQ&A: \d+ answers?\n/.test(shown.reply)
      ? 'PASS Q&A line is a count'
      : 'FAIL Q&A line is not the review count'
  );

  console.log(lines.join('\n'));
  console.log('');
  for (const r of results) console.log(r);
  console.log(`\nconsistencyMs=${corrected.consistencyMs ?? 0}`);

  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
  cost.print();

  const failed = results.some((r) => r.startsWith('FAIL'));
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
  process.exit(1);
});
