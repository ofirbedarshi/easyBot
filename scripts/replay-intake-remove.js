#!/usr/bin/env node
/**
 * Live replay: remove one intake item after approval (real OpenAI).
 *
 * Seeds an approved garage profile that already collects name + phone, then
 * sends "stop asking for the phone number". Checks that phone is gone and
 * whether the model emitted ownerEdits action=remove.
 *
 *   OPENAI_BUILDER_MODEL=gpt-6-luna node scripts/replay-intake-remove.js
 *
 * Not part of the default test suite. A few cents at gpt-6-luna prices.
 */
import 'dotenv/config';
import { applyReviewGate, runBuilderTurn } from '../src/builder.js';
import { topicJustAsked } from '../src/builderTopics.js';
import { emptyProfile } from '../src/profile.js';
import { attachCostTracker } from './lib/modelCost.js';

const MODEL = process.env.OPENAI_BUILDER_MODEL || process.env.OPENAI_MODEL || 'gpt-6-luna';
const USER = 'stop asking for the phone number';

function approvedGarage() {
  const profile = emptyProfile();
  const draft = {
    name: 'Ofir garage',
    whatWeDo: 'Garage',
    ownerGoal: 'answer_and_collect',
    ownerGoalRequested: 'answer questions and take customer details',
    services: [{ name: 'Oil change', price: '200 ILS', notes: null }],
    hours: 'Mon–Fri 8–18',
    locationOrArea: 'Haifa',
    commonQuestions: [
      { question: 'Do you work on trucks?', answer: 'Yes, light trucks too.' },
    ],
    informationToCollect: ['name', 'phone'],
    unknowns: [],
    otherFacts: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
  };
  Object.assign(profile, draft, {
    askedTopics: undefined,
    approvedAt: '2026-01-01T00:00:00.000Z',
    draft: { ...draft },
  });
  return profile;
}

function phoneGone(list) {
  return (
    Array.isArray(list) &&
    list.some((x) => /^name$/i.test(String(x).trim())) &&
    !list.some((x) => /phone/i.test(String(x)))
  );
}

function emittedIntakeRemove(edits) {
  return (Array.isArray(edits) ? edits : []).some(
    (e) =>
      e &&
      e.action === 'remove' &&
      /informationToCollect|intake/i.test(String(e.field || '')) &&
      /phone/i.test(String(e.item || ''))
  );
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }
  const cost = attachCostTracker(MODEL);
  const profile = approvedGarage();
  const userMessage = USER;
  console.log(`Model: ${MODEL}`);
  console.log(`Owner: ${userMessage}`);
  console.log(`Before intake: ${JSON.stringify(profile.draft.informationToCollect)}`);

  const buildHistory = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: "Hi, I'm Adam" },
  ];
  const raw = await runBuilderTurn({
    buildHistory,
    profile,
    userMessage,
    model: MODEL,
  });
  const gated = applyReviewGate(profile, raw, userMessage, {
    justAsked: topicJustAsked(buildHistory),
  });
  const intake = gated.draft?.informationToCollect;
  const edits = raw.modelJson?.ownerEdits;
  const score = {
    emittedOwnerEditsRemove: emittedIntakeRemove(edits),
    phoneGone: phoneGone(intake),
    intake,
    ownerEdits: edits,
  };
  score.pass = score.phoneGone;

  console.log(`After intake: ${JSON.stringify(intake)}`);
  console.log(`ownerEdits: ${JSON.stringify(edits)}`);
  console.log(`message: ${String(gated.message || '').replace(/\s+/g, ' ').slice(0, 240)}`);
  console.log(JSON.stringify({ ...score, ownerEdits: edits }, null, 2));
  cost.print();

  if (!score.pass) {
    console.error('\nREPLAY FAIL: phone still on informationToCollect');
    if (!score.emittedOwnerEditsRemove) {
      console.error('Model did not emit ownerEdits remove for phone (prompt not grown).');
    }
    process.exit(1);
  }
  if (!score.emittedOwnerEditsRemove) {
    console.log(
      '\nREPLAY PASS (phone gone) but model did not emit ownerEdits remove — report that; do not grow the prompt.'
    );
  } else {
    console.log('\nREPLAY PASS');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
