/**
 * Setup interview: wrap-up starts once the goal is set, a no-question
 * reply cannot dead-end, and "ok" after the first card is the editing
 * menu (model text kept) — not the leftover Here's-your-bot card.
 *
 * No network. Stubbed Builder turns.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { applyReviewGate } from '../src/builder.js';
import { IDENTITY_FALLBACK_QUESTION } from '../src/setupAgenda.js';
import { topicByKey } from '../src/builderTopics.js';
import { createSession, handleMessage } from '../src/session.js';
import { lastShownNav } from '../src/ownerNav.js';

const PROFILE = testProfilePath('setup-deadend');
const FAQ = topicByKey('commonQuestions');
const INTAKE = topicByKey('informationToCollect');
const MODEL_INTAKE_Q = 'What details should I ask customers for?';

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function pixelDraft(overrides = {}) {
  return {
    name: 'Pixel Fix',
    whatWeDo: 'We repair phones and laptops',
    ownerGoal: 'answer_and_collect',
    ownerGoalRequested: 'answer questions and take customer details',
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    askedTopics: ['businessDetails'],
    ...overrides,
  };
}

function setupProfile(draft, extras = {}) {
  return {
    ...emptyProfile(),
    ...draft,
    approvedAt: null,
    draft: { ...draft },
    ...extras,
  };
}

function modelTurn(draft, overrides = {}) {
  return {
    message: 'Answering questions and collecting details will help ✨',
    draft,
    readyForReview: false,
    wantsReview: false,
    asksQuestion: true,
    askingTopic: null,
    onPurpose: true,
    source: 'stub-builder',
    ...overrides,
  };
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

await test('goal set + model intake question → scripted FAQ', () => {
  const draft = pixelDraft();
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, { message: MODEL_INTAKE_Q }),
    'answer questions and take customer details'
  );
  assert.equal(gated.message, `${FAQ.ack}\n\n${FAQ.question}`);
  assert.equal(gated.asksQuestion, true);
  assert.equal(gated.presentReview, false);
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails', 'commonQuestions']);
  assert.ok(!gated.message.includes(MODEL_INTAKE_Q));
  assert.ok(!gated.message.includes(INTAKE.question));
});

await test('goal set + model intake question does not show the card', () => {
  const draft = pixelDraft();
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, { message: MODEL_INTAKE_Q, readyForReview: true }),
    'answer questions and take customer details'
  );
  assert.equal(gated.presentReview, false);
  assert.match(gated.message, /^Got it! 💛\n\nWhat do customers usually ask you/);
});

await test('FAQ asked + intake array + no-? ack → first-approval card', async () => {
  const draft = pixelDraft({
    askedTopics: ['businessDetails', 'commonQuestions'],
    informationToCollect: ['name', 'phone', 'what device is broken'],
  });
  clean();
  saveProfile(setupProfile(draft), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, {
          message: 'Pixel Fix repairs phones and laptops ✨',
          asksQuestion: false,
          topicResponse: 'skipped',
        }),
    },
  });
  session.mode = 'BUILD';
  session.buildHistory = [
    { role: 'assistant', content: FAQ.ack + '\n\n' + FAQ.question, asksQuestion: true },
  ];

  const out = await handleMessage(session, 'skip');
  assert.equal(out.ok, true);
  assert.ok(out.reply.startsWith("🎉 I'm all set! This is what I know about your business:"), out.reply);
  assert.match(out.reply, /\*Name:\* Pixel Fix/);
  assert.ok(loadProfile(PROFILE).approvedAt, 'approvedAt must be written on the card turn');
  assert.equal(lastShownNav(session.buildHistory), 'review');
});

await test('FAQ asked + intake still null + no-? ack → scripted intake', () => {
  const draft = pixelDraft({
    askedTopics: ['businessDetails', 'commonQuestions'],
    informationToCollect: null,
  });
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, {
      message: 'Pixel Fix repairs phones and laptops ✨',
      asksQuestion: false,
      topicResponse: 'skipped',
    }),
    'skip',
    { justAsked: FAQ }
  );
  assert.equal(
    gated.message,
    `Pixel Fix repairs phones and laptops ✨\n\n${INTAKE.question}`
  );
  assert.equal(gated.asksQuestion, true);
  assert.equal(gated.presentReview, false);
  assert.deepEqual(gated.draft.askedTopics, [
    'businessDetails',
    'commonQuestions',
    'informationToCollect',
  ]);
});

await test('no-? ack before name/goal attaches identity fallback, not FAQ', () => {
  const draft = {
    name: null,
    whatWeDo: 'A small coffee shop with pastries',
    ownerGoal: null,
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    askedTopics: [],
  };
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, { message: 'A cozy coffee shop with pastries sounds lovely ✨', asksQuestion: false }),
    'Cafe Noam, a small coffee shop with pastries'
  );
  assert.equal(
    gated.message,
    `A cozy coffee shop with pastries sounds lovely ✨\n\n${IDENTITY_FALLBACK_QUESTION}`
  );
  assert.equal(gated.presentReview, false);
  assert.ok(!gated.draft.askedTopics.includes('commonQuestions'));
  assert.ok(!String(gated.message).includes(FAQ.question));
});

await test('ok after first card is the editing menu, not the old card', async () => {
  const draft = pixelDraft({
    askedTopics: ['businessDetails', 'commonQuestions'],
    informationToCollect: ['name', 'phone'],
    commonQuestions: [{ question: 'Do you repair tablets?', answer: 'Yes.' }],
  });
  clean();
  saveProfile(setupProfile(draft), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, { message: 'Got it, thanks!', readyForReview: true, asksQuestion: false }),
    },
  });
  session.mode = 'BUILD';
  session.buildHistory = [{ role: 'assistant', content: '(opened)' }];

  const first = await handleMessage(session, 'name and phone');
  assert.ok(first.reply.startsWith("🎉 I'm all set!"), first.reply);
  assert.ok(loadProfile(PROFILE).approvedAt);

  const session2 = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, {
          message: 'Here is your bot again.',
        }),
    },
  });
  session2.mode = 'BUILD';
  session2.buildHistory = [
    { role: 'assistant', content: first.reply, nav: 'review' },
  ];

  const ok = await handleMessage(session2, 'ok');
  assert.equal(ok.ok, true);
  assert.ok(ok.reply.startsWith('Here is your bot again.'), ok.reply);
  assert.match(ok.reply, /🏪 Tell me more about your business/);
  assert.doesNotMatch(ok.reply, /Here's your bot for/);
  assert.doesNotMatch(ok.reply, /Business info:/);
  assert.doesNotMatch(ok.reply, /How I talk: default/);
  assert.equal(lastShownNav(session2.buildHistory), 'menu');
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
