/**
 * Setup interview: after name + what they do, the app asks one scripted
 * tell-me-more question (missing services / hours / location only), then
 * appends the fixed owner-goal question itself. No network. Stubbed Builder.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { applyReviewGate, OWNER_GOAL_QUESTION } from '../src/builder.js';
import {
  BUSINESS_DETAILS_ACK,
  businessDetailsQuestion,
  topicByKey,
} from '../src/builderTopics.js';
import { createSession, handleMessage } from '../src/session.js';

const PROFILE = testProfilePath('setup-tell-more');
const DETAILS = topicByKey('businessDetails');
const FAQ = topicByKey('commonQuestions');

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function nameWhatDraft(overrides = {}) {
  return {
    name: 'Ofir garage',
    whatWeDo: 'Garage',
    ownerGoal: null,
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    askedTopics: [],
    ...overrides,
  };
}

function setupProfile(draft) {
  return {
    ...emptyProfile(),
    ...draft,
    approvedAt: null,
    draft: { ...draft },
  };
}

function modelTurn(draft, overrides = {}) {
  return {
    message: 'Ofir Garage is your garage ✨',
    draft,
    readyForReview: false,
    wantsReview: false,
    asksQuestion: false,
    askingTopic: null,
    onPurpose: true,
    source: 'stub-builder',
    ...overrides,
  };
}

function assertEndsWithGoal(reply, label) {
  assert.ok(
    String(reply).endsWith(OWNER_GOAL_QUESTION),
    `${label}: expected reply to end with OWNER_GOAL_QUESTION`
  );
  assert.ok(
    !String(reply).includes(FAQ.question),
    `${label}: FAQ must not replace the goal question`
  );
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

await test('name+what only → tell-me-more with all three bullets', () => {
  const draft = nameWhatDraft();
  const gated = applyReviewGate(setupProfile(draft), modelTurn(draft), 'Ofir garage, a garage');
  const expected = `${BUSINESS_DETAILS_ACK}\n\n${businessDetailsQuestion(draft)}`;
  assert.equal(gated.message, expected);
  assert.equal(gated.asksQuestion, true);
  assert.equal(gated.presentReview, false);
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails']);
  assert.ok(gated.message.includes('🛠️ What services do you offer, and how much do they cost?'));
  assert.ok(gated.message.includes('🕒 What are your opening hours?'));
  assert.ok(gated.message.includes('📍 Where are you located?'));
  assert.equal(
    businessDetailsQuestion(draft),
    [
      'Tell me a bit more about Ofir garage, so I can answer your customers well 🏪',
      '',
      'For example:',
      '🛠️ What services do you offer, and how much do they cost?',
      '🕒 What are your opening hours?',
      '📍 Where are you located?',
      '',
      "Or anything else you'd like me to know ✨",
    ].join('\n')
  );
});

await test('name+what+hours → services and location bullets only', () => {
  const draft = nameWhatDraft({ hours: 'Mon–Fri 8–18' });
  const gated = applyReviewGate(setupProfile(draft), modelTurn(draft), 'we open 8 to 6');
  const expectedQ = businessDetailsQuestion(draft);
  assert.equal(gated.message, `${BUSINESS_DETAILS_ACK}\n\n${expectedQ}`);
  assert.ok(expectedQ.includes('🛠️ What services do you offer, and how much do they cost?'));
  assert.ok(!expectedQ.includes('🕒 What are your opening hours?'));
  assert.ok(expectedQ.includes('📍 Where are you located?'));
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails']);
  assert.equal(
    expectedQ,
    [
      'Tell me a bit more about Ofir garage, so I can answer your customers well 🏪',
      '',
      'For example:',
      '🛠️ What services do you offer, and how much do they cost?',
      '📍 Where are you located?',
      '',
      "Or anything else you'd like me to know ✨",
    ].join('\n')
  );
});

await test('everything present → no tell-me-more, app asks goal', () => {
  const draft = nameWhatDraft({
    services: [{ name: 'Oil change', price: '200 ILS', notes: null }],
    hours: 'Mon–Fri 8–18',
    locationOrArea: 'Haifa',
  });
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, { message: 'Got it, thanks!', readyForReview: true }),
    'full dump'
  );
  assert.ok(!gated.message.includes(DETAILS.askedMarker));
  assert.ok(!gated.draft.askedTopics.includes('businessDetails'));
  assertEndsWithGoal(gated.message, 'all details present');
  assert.equal(gated.asksQuestion, true);
  assert.equal(gated.presentReview, false);
});

await test('skip → goal question even when model text has no question', () => {
  const draft = nameWhatDraft({ askedTopics: ['businessDetails'] });
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, { message: 'Ofir Garage is your garage ✨', readyForReview: true }),
    'skip'
  );
  assertEndsWithGoal(gated.message, 'skip');
  assert.equal(
    gated.message,
    `Ofir Garage is your garage ✨\n\n${OWNER_GOAL_QUESTION}`
  );
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails']);
  assert.equal(gated.asksQuestion, true);
  assert.equal(gated.presentReview, false);
});

await test('partial answer → goal question even when model text has no question', () => {
  const draft = nameWhatDraft({
    askedTopics: ['businessDetails'],
    hours: 'Mon–Fri 8–18',
  });
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, { message: 'Noted the hours.', readyForReview: true }),
    'we are open weekdays 8 to 6'
  );
  assertEndsWithGoal(gated.message, 'partial');
  assert.equal(gated.message, `Noted the hours.\n\n${OWNER_GOAL_QUESTION}`);
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails']);
  assert.ok(!gated.message.includes(DETAILS.askedMarker), 'do not re-ask tell-me-more');
});

await test('handleBuild skip after tell-me-more asks the goal', async () => {
  const draft = nameWhatDraft({ askedTopics: ['businessDetails'] });
  clean();
  saveProfile(setupProfile(draft), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, { message: 'Ofir Garage is your garage ✨' }),
    },
  });
  session.mode = 'BUILD';
  session.buildHistory = [
    { role: 'assistant', content: BUSINESS_DETAILS_ACK + '\n\n' + businessDetailsQuestion(draft), asksQuestion: true },
  ];

  const out = await handleMessage(session, 'skip');
  assert.equal(out.ok, true);
  assert.equal(out.event, 'build_turn');
  assertEndsWithGoal(out.reply, 'handleBuild skip');
  assert.equal(session.buildHistory.at(-1).asksQuestion, true);
  assert.deepEqual(loadProfile(PROFILE).draft.askedTopics, ['businessDetails']);
  assert.equal(loadProfile(PROFILE).approvedAt, null);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
