/**
 * Setup interview: after name + what they do, the app asks one scripted
 * tell-me-more question, then skip / partial / dump-ahead present ready.
 * No network. Stubbed Builder.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { applyReviewGate } from '../src/builder.js';
import {
  BUSINESS_DETAILS_ACK,
  BUSINESS_DETAILS_MARKER,
  businessDetailsQuestion,
  topicByKey,
} from '../src/builderTopics.js';
import { businessDetailsQuestionText } from '../src/copy.js';
import { composeReply } from '../src/composeReply.js';
import { createSession, handleMessage } from '../src/session.js';
import { lastShownNav } from '../src/ownerNav.js';

const PROFILE = testProfilePath('setup-tell-more');
const DETAILS = topicByKey('businessDetails');
const NAME = 'Ofir garage';

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function nameWhatDraft(overrides = {}) {
  return {
    name: NAME,
    whatWeDo: 'Garage',
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

function expectedReadyFirst() {
  return composeReply({ kind: 'ready_first', menuOpts: { leadOption: false } }).reply;
}

function expectedTellMore(draft = nameWhatDraft()) {
  return `${BUSINESS_DETAILS_ACK}\n\n${businessDetailsQuestion(draft)}`;
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

await test('name+what only → tell-me-more with the two-line copy', () => {
  const draft = nameWhatDraft();
  const gated = applyReviewGate(setupProfile(draft), modelTurn(draft), 'Ofir garage, a garage');
  const expected = expectedTellMore(draft);
  assert.equal(gated.message, expected);
  assert.equal(gated.asksQuestion, true);
  assert.equal(gated.presentReview, false);
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails']);
  assert.equal(businessDetailsQuestion(draft), businessDetailsQuestionText(NAME));
  assert.equal(
    businessDetailsQuestion(draft),
    [
      `Tell me a bit more about ${NAME} (services and prices, opening hours, location, or anything else you'd like me to know).`,
      'Or say "skip" for now.',
    ].join('\n')
  );
  assert.ok(gated.message.includes(BUSINESS_DETAILS_MARKER));
  assert.ok(!gated.message.includes('🛠️'));
  assert.ok(!gated.message.includes('For example:'));
});

await test('skip → presentReview true (not a follow-up question)', () => {
  const draft = nameWhatDraft({ askedTopics: ['businessDetails'] });
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, {
      message: 'Ofir Garage is your garage ✨',
      readyForReview: true,
      topicResponse: 'skipped',
    }),
    'skip',
    { justAsked: DETAILS }
  );
  assert.equal(gated.presentReview, true);
  assert.equal(gated.asksQuestion, false);
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails']);
  assert.ok(!gated.message.includes(BUSINESS_DETAILS_MARKER));
  assert.ok(!gated.message.includes('What would you most like me to help with'));
});

await test('partial hours → presentReview true', () => {
  const draft = nameWhatDraft({
    askedTopics: ['businessDetails'],
    hours: 'Mon–Fri 8–18',
  });
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, { message: 'Noted the hours.', readyForReview: true }),
    'we are open weekdays 8 to 6'
  );
  assert.equal(gated.presentReview, true);
  assert.equal(gated.asksQuestion, false);
  assert.deepEqual(gated.draft.askedTopics, ['businessDetails']);
  assert.ok(!gated.message.includes(DETAILS.askedMarker), 'do not re-ask tell-me-more');
});

await test('dump-ahead all details → presentReview true, no businessDetails ask', () => {
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
  assert.equal(gated.presentReview, true);
  assert.equal(gated.asksQuestion, false);
  assert.ok(!gated.message.includes(DETAILS.askedMarker));
  assert.ok(!gated.draft.askedTopics.includes('businessDetails'));
});

await test('handleBuild skip after tell-me-more writes approvedAt and ready_first', async () => {
  const draft = nameWhatDraft({ askedTopics: ['businessDetails'] });
  clean();
  saveProfile(setupProfile(draft), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, { message: 'Ofir Garage is your garage ✨', topicResponse: 'skipped' }),
    },
  });
  session.mode = 'BUILD';
  session.buildHistory = [
    {
      role: 'assistant',
      content: expectedTellMore(draft),
      asksQuestion: true,
    },
  ];

  const out = await handleMessage(session, 'skip');
  assert.equal(out.ok, true);
  assert.equal(out.event, 'build_turn');
  assert.equal(out.reply, expectedReadyFirst());
  assert.equal(session.buildHistory.at(-1).asksQuestion, false);
  assert.equal(lastShownNav(session.buildHistory), 'menu');
  assert.deepEqual(loadProfile(PROFILE).draft.askedTopics, ['businessDetails']);
  assert.ok(loadProfile(PROFILE).approvedAt, 'approvedAt must be written on handleBuild skip');
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
