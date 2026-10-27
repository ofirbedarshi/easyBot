/**
 * Setup interview after the owner skips FAQ: the app continues the
 * required-topic sequence (intake) even when the model echoes a fragment
 * of Adam's previous message and does not set a wrap-up flag.
 *
 * No network. Stubbed Builder turn.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { applyReviewGate } from '../src/builder.js';
import { topicByKey } from '../src/builderTopics.js';
import { createSession, handleMessage } from '../src/session.js';

const PROFILE = testProfilePath('setup-skip-stall');
const INTAKE = topicByKey('informationToCollect');
const FAQ = topicByKey('commonQuestions');
const ECHO = 'Ofir Garage is your garage ✨';
const EXPECTED_SKIP_REPLY = `${ECHO}\n\n${INTAKE.question}`;
const PREVIOUS =
  "I've got it—Ofir Garage is your garage ✨\n\nWhat would you most like me to help with? 🌟";

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

/** Profile + draft as stored just before the owner said Skip. */
function preSkipProfile() {
  const facts = {
    name: 'Ofir garage',
    whatWeDo: 'Garage',
    ownerGoal: 'answer_questions',
    ownerGoalRequested: 'Answer customer question',
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    askedTopics: ['commonQuestions'],
  };
  return {
    ...emptyProfile(),
    ...facts,
    approvedAt: null,
    draft: { ...facts },
  };
}

function productionModelTurn(overrides = {}) {
  const draft = preSkipProfile().draft;
  return {
    message: ECHO,
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

function assertIntakeAsked(reply, label) {
  assert.equal(reply, EXPECTED_SKIP_REPLY, label);
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

function testGateProductionEchoAsksQuestion() {
  const gated = applyReviewGate(preSkipProfile(), productionModelTurn(), 'Skip');
  assertIntakeAsked(gated.message, 'applyReviewGate production flags');
  assert.equal(gated.asksQuestion, true);
  assert.equal(gated.presentReview, false);
  assert.deepEqual(gated.draft.askedTopics, ['commonQuestions', 'informationToCollect']);
}

function testGateEchoWithoutAsksQuestion() {
  const gated = applyReviewGate(
    preSkipProfile(),
    productionModelTurn({ asksQuestion: false }),
    'Skip'
  );
  assertIntakeAsked(gated.message, 'applyReviewGate asksQuestion=false');
}

function testGateEchoWithAskingTopicNoQuestionMark() {
  const gated = applyReviewGate(
    preSkipProfile(),
    productionModelTurn({ askingTopic: 'informationToCollect' }),
    'Skip'
  );
  assertIntakeAsked(gated.message, 'applyReviewGate askingTopic without ?');
}

async function testHandleBuildProductionSkip() {
  clean();
  saveProfile(preSkipProfile(), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () => productionModelTurn(),
    },
  });
  session.mode = 'BUILD';
  session.buildHistory = [
    { role: 'assistant', content: PREVIOUS },
    { role: 'user', content: 'Answer customer question?' },
    { role: 'assistant', content: FAQ.ack + '\n\n' + FAQ.question, asksQuestion: true },
  ];

  const out = await handleMessage(session, 'Skip');
  assert.equal(out.ok, true);
  assert.equal(out.event, 'build_turn');
  assertIntakeAsked(out.reply, 'handleBuild production skip');

  const last = session.buildHistory.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, EXPECTED_SKIP_REPLY);
  assert.equal(last.asksQuestion, true);

  const stored = loadProfile(PROFILE);
  assert.equal(stored.approvedAt, null);
  assert.deepEqual(stored.draft.askedTopics, ['commonQuestions', 'informationToCollect']);
}

await test('gate: production echo + asksQuestion=true appends intake', async () => {
  testGateProductionEchoAsksQuestion();
});
await test('gate: same echo with asksQuestion=false still appends intake', async () => {
  testGateEchoWithoutAsksQuestion();
});
await test('gate: askingTopic set but no ? still appends intake', async () => {
  testGateEchoWithAskingTopicNoQuestionMark();
});
await test('handleBuild: production skip state asks the last scripted question', async () => {
  await testHandleBuildProductionSkip();
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
