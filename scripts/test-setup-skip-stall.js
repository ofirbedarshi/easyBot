/**
 * Setup interview after the owner skips tell-me-more: the app presents
 * ready even when the model echoes a fragment of the previous message
 * and does not set wrap-up flags.
 *
 * No network. Stubbed Builder turn.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { applyReviewGate } from '../src/builder.js';
import {
  BUSINESS_DETAILS_ACK,
  businessDetailsQuestion,
  topicByKey,
} from '../src/builderTopics.js';
import { composeReply } from '../src/composeReply.js';
import { createSession, handleMessage } from '../src/session.js';
import { lastShownNav } from '../src/ownerNav.js';

const PROFILE = testProfilePath('setup-skip-stall');
const DETAILS = topicByKey('businessDetails');
const ECHO = 'Ofir Garage is your garage ✨';
const NAME = 'Ofir garage';
const WHAT = 'Garage';

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function nameWhatDraft(overrides = {}) {
  return {
    name: NAME,
    whatWeDo: WHAT,
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

/** Profile + draft as stored just before the owner said Skip. */
function preSkipProfile() {
  const facts = nameWhatDraft();
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
    topicResponse: 'skipped',
    source: 'stub-builder',
    ...overrides,
  };
}

function expectedReadyFirst() {
  return composeReply({ kind: 'ready_first', menuOpts: { leadOption: false } }).reply;
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

function assertPresentsReady(gated, label) {
  assert.equal(gated.presentReview, true, `${label}: presentReview`);
  assert.equal(gated.asksQuestion, false, `${label}: asksQuestion`);
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails'], `${label}: askedTopics`);
}

function testGateProductionEchoAsksQuestion() {
  const gated = applyReviewGate(preSkipProfile(), productionModelTurn(), 'Skip', {
    justAsked: DETAILS,
  });
  assertPresentsReady(gated, 'applyReviewGate production flags');
}

function testGateEchoWithoutAsksQuestion() {
  const gated = applyReviewGate(
    preSkipProfile(),
    productionModelTurn({ asksQuestion: false }),
    'Skip',
    { justAsked: DETAILS }
  );
  assertPresentsReady(gated, 'applyReviewGate asksQuestion=false');
}

function testGateEchoWithAskingTopicNoQuestionMark() {
  const gated = applyReviewGate(
    preSkipProfile(),
    productionModelTurn({ askingTopic: 'informationToCollect' }),
    'Skip',
    { justAsked: DETAILS }
  );
  assertPresentsReady(gated, 'applyReviewGate askingTopic without ?');
}

async function testHandleBuildProductionSkip() {
  const draft = nameWhatDraft();
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
    {
      role: 'assistant',
      content: `${BUSINESS_DETAILS_ACK}\n\n${businessDetailsQuestion(draft)}`,
      asksQuestion: true,
    },
  ];

  const out = await handleMessage(session, 'Skip');
  assert.equal(out.ok, true);
  assert.equal(out.event, 'build_turn');
  assert.equal(out.reply, expectedReadyFirst(), 'handleBuild production skip');

  const last = session.buildHistory.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.content, expectedReadyFirst());
  assert.equal(last.asksQuestion, false);
  assert.equal(lastShownNav(session.buildHistory), 'menu');

  const stored = loadProfile(PROFILE);
  assert.ok(stored.approvedAt, 'approvedAt must be written on handleBuild skip');
  assert.deepEqual(stored.draft.askedTopics, ['businessDetails']);
}

await test('gate: production echo + asksQuestion=true presents ready', async () => {
  testGateProductionEchoAsksQuestion();
});
await test('gate: same echo with asksQuestion=false still presents ready', async () => {
  testGateEchoWithoutAsksQuestion();
});
await test('gate: askingTopic set but no ? still presents ready', async () => {
  testGateEchoWithAskingTopicNoQuestionMark();
});
await test('handleBuild: production skip writes approvedAt and ready_first', async () => {
  await testHandleBuildProductionSkip();
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
