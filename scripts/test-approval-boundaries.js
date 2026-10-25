/**
 * Deterministic approval-boundary tests through real handleMessage handlers
 * with mocked Flowise + stubbed Builder turns (no network).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  businessFactsView,
  DEFAULT_BEHAVIOR,
  draftDiffersFromLive,
  effectiveBehavior,
  emptyProfile,
  formatSummary,
  hasEnoughForFirstBot,
  loadProfile,
  mergeDraft,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import {
  applyReviewGate,
  enforceConfigRequests,
  isOwnerApproveMessage,
  reconcileDraft,
  shouldSoftApprove,
  withSingleQuestion,
} from '../src/builder.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import { buildFlowData } from '../src/flowise.js';
import { createSession, handleMessage } from '../src/session.js';
import { renderSection } from '../src/ownerNav.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = testProfilePath('approval-boundaries');

/** Review text minus the app's fixed "What would you like to do next?" line. */
function withoutOptionsPrompt(reply) {
  return String(reply).replace(/^What would you like to do next\?$/m, '');
}

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function baseApprovedLive() {
  const p = emptyProfile();
  p.name = 'Sunny Yoga';
  p.whatWeDo = 'Private yoga lessons';
  p.ownerGoal = 'answer_and_collect';
  p.services = [{ name: 'Private lesson', price: '$70 / 60 min', notes: null }];
  p.hours = 'Mon–Fri 9–5';
  p.locationOrArea = 'Austin';
  p.commonQuestions = [];
  p.informationToCollect = [];
  p.unknowns = [];
  p.tone = 'friendly';
  p.responseLength = null;
  p.priceDisclosure = null;
  p.approvedAt = '2026-01-01T00:00:00.000Z';
  p.chatflowId = 'cf-live';
  p.flowiseSyncOk = true;
  p.flowiseSyncedAt = '2026-01-01T00:00:00.000Z';
  p.draft = {
    name: p.name,
    whatWeDo: p.whatWeDo,
    ownerGoal: p.ownerGoal,
    services: p.services,
    hours: p.hours,
    locationOrArea: p.locationOrArea,
    commonQuestions: p.commonQuestions,
    informationToCollect: p.informationToCollect,
    unknowns: p.unknowns,
    tone: p.tone,
    responseLength: p.responseLength,
    priceDisclosure: p.priceDisclosure,
  };
  return p;
}

function makeSession(stubTurn, flowiseMock) {
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: stubTurn,
      pingFlowise: async () => true,
      wakeFlowise: async () => {},
      createOrUpdateChatflow: async (profile) => {
        flowiseMock.calls.push(JSON.parse(JSON.stringify(profile)));
        return profile.chatflowId || 'cf-mock';
      },
    },
  });
  // Past the wake/opening turn so stubs exercise Builder turns.
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  return session;
}

/** Change turn (app presents a review of the stub draft), then a bare approve. */
async function reviewThenApprove(session) {
  await handleMessage(session, 'Please apply this change.');
  return handleMessage(session, 'approve');
}

/** Stub Builder that returns queued turns in order (last one repeats). */
function queuedTurns(turns) {
  let i = 0;
  return async () => {
    const t = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return { source: 'stub-builder', ...t };
  };
}

function liveDraftWith(live, overrides) {
  return {
    name: live.name,
    whatWeDo: live.whatWeDo,
    ownerGoal: live.ownerGoal,
    services: live.services,
    hours: live.hours,
    locationOrArea: live.locationOrArea,
    commonQuestions: [],
    informationToCollect: [],
    unknowns: [],
    tone: live.tone,
    responseLength: null,
    priceDisclosure: null,
    ...overrides,
  };
}

/** Review gate 1+2: changed draft without a presented review cannot be approved; once presented, it can. */
async function testApproveRequiresPresentedReview() {
  clean();
  const live = baseApprovedLive();
  saveProfile(live, PROFILE);
  const flowiseMock = { calls: [] };
  const draft80 = liveDraftWith(live, {
    services: [{ name: 'Private lesson', price: '$80 / 60 min', notes: null }],
  });
  const session = makeSession(
    queuedTurns([
      // Model updates the draft but presents no review
      { message: 'Noted the new price.', draft: draft80, readyForReview: false, approved: false },
      // Model (wrongly) claims approval on the bare approve
      { message: 'Approved!', draft: draft80, readyForReview: true, approved: true },
    ]),
    flowiseMock
  );

  await handleMessage(session, 'Change private lessons to $80.');
  assert.equal(loadProfile(PROFILE).reviewedDraftKey, null);

  const r1 = await handleMessage(session, 'approve');
  assert.equal(r1.approved, false);
  assert.equal(r1.event, 'build_turn');
  assert.equal(flowiseMock.calls.length, 0, 'no sync without a presented review');
  assert.equal(loadProfile(PROFILE).services[0].price, '$70 / 60 min');
  assert.match(r1.reply, /review the current version/);
  assert.match(r1.reply, /what will change:\n\nServices: Private lesson — \$80 \/ 60 min \(was: Private lesson — \$70 \/ 60 min\)/);
  assert.match(r1.reply, /1\. Try my bot\n2\. Make changes/);
  assert.doesNotMatch(withoutOptionsPrompt(r1.reply), /\?/);
  assert.ok(loadProfile(PROFILE).reviewedDraftKey, 'review presented → key stored');

  const r2 = await handleMessage(session, 'approve');
  assert.equal(r2.approved, true);
  assert.equal(r2.event, 'approved_synced');
  assert.equal(flowiseMock.calls.length, 1);
  assert.equal(flowiseMock.calls[0].services[0].price, '$80 / 60 min');
  assert.equal(loadProfile(PROFILE).services[0].price, '$80 / 60 min');
  console.log('PASS approve_requires_presented_review');
}

/** Review gate 3: an edit after the review invalidates it; a new review is required. */
async function testEditAfterReviewRequiresNewReview() {
  clean();
  const live = baseApprovedLive();
  saveProfile(live, PROFILE);
  const flowiseMock = { calls: [] };
  const draft80 = liveDraftWith(live, {
    services: [{ name: 'Private lesson', price: '$80 / 60 min', notes: null }],
  });
  const draft90 = liveDraftWith(live, {
    services: [{ name: 'Private lesson', price: '$90 / 60 min', notes: null }],
  });
  const session = makeSession(
    queuedTurns([
      { message: 'Here is the change.', draft: draft80, readyForReview: true, approved: false },
      { message: 'Updated to $90 and approved.', draft: draft90, readyForReview: true, approved: true },
      { message: 'Approved.', draft: draft90, readyForReview: true, approved: true },
    ]),
    flowiseMock
  );

  const r1 = await handleMessage(session, 'Change private lessons to $80.');
  assert.match(r1.reply, /\$80 \/ 60 min/);
  const key80 = loadProfile(PROFILE).reviewedDraftKey;
  assert.ok(key80);

  const r2 = await handleMessage(session, 'Actually make it $90 — approve.');
  assert.equal(r2.approved, false, 'edit after review must not approve');
  assert.equal(flowiseMock.calls.length, 0);
  assert.equal(loadProfile(PROFILE).services[0].price, '$70 / 60 min');
  assert.match(r2.reply, /what will change[\s\S]*\$90 \/ 60 min/);
  assert.notEqual(loadProfile(PROFILE).reviewedDraftKey, key80);

  const r3 = await handleMessage(session, 'approve');
  assert.equal(r3.event, 'approved_synced');
  assert.equal(flowiseMock.calls[0].services[0].price, '$90 / 60 min');
  console.log('PASS edit_after_review_requires_new_review');
}

async function testDraftEditLeavesLiveUnchanged() {
  clean();
  saveProfile(baseApprovedLive(), PROFILE);
  const flowiseMock = { calls: [] };
  const pendingServices = [
    { name: 'Private lesson', price: '$80 / 60 min', notes: null },
  ];
  const pendingGoal = 'answer_questions';

  const session = makeSession(async () => ({
    message: 'Updated the draft price and goal — approve when ready.',
    draft: {
      name: 'Sunny Yoga',
      whatWeDo: 'Private yoga lessons',
      ownerGoal: pendingGoal,
      services: pendingServices,
      hours: 'Mon–Fri 9–5',
      locationOrArea: 'Austin',
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'friendly',
      responseLength: null,
      priceDisclosure: null,
    },
    readyForReview: true,
    approved: false,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await handleMessage(session, 'Change private lessons to $80 and update the goal.');
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');
  assert.equal(flowiseMock.calls.length, 0, 'Flowise must not sync on draft-only edit');

  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '$70 / 60 min');
  assert.equal(disk.ownerGoal, 'answer_and_collect');
  assert.equal(disk.approvedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(disk.chatflowId, 'cf-live');
  assert.equal(disk.draft.services[0].price, '$80 / 60 min');
  assert.equal(disk.draft.ownerGoal, pendingGoal);

  const summary = formatSummary(disk);
  assert.match(summary, /Live approved \(active customer bot\)/);
  assert.match(summary, /Pending \(not live until you approve\)/);
  assert.match(summary, /\$70 \/ 60 min/);
  assert.match(summary, /\$80 \/ 60 min/);
  assert.match(summary, /Bot goal:/);
  console.log('PASS draft_edit_leaves_live_unchanged');
}

async function testReapproveUpdatesFlowise() {
  clean();
  saveProfile(baseApprovedLive(), PROFILE);
  const flowiseMock = { calls: [] };
  const newServices = [
    { name: 'Private lesson', price: '$80 / 60 min', notes: null },
  ];
  const newGoal = 'collect_details';

  const session = makeSession(async () => ({
    message: 'Approved updates applied.',
    draft: {
      name: 'Sunny Yoga',
      whatWeDo: 'Private yoga lessons',
      ownerGoal: newGoal,
      services: newServices,
      hours: 'Mon–Fri 9–5',
      locationOrArea: 'Austin',
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'friendly',
    },
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await reviewThenApprove(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'approved_synced');
  assert.equal(flowiseMock.calls.length, 1, 'Flowise must sync on re-approve');

  const sent = flowiseMock.calls[0];
  assert.equal(sent.services[0].price, '$80 / 60 min');
  assert.equal(sent.ownerGoal, newGoal);

  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '$80 / 60 min');
  assert.equal(disk.ownerGoal, newGoal);
  assert.equal(disk.flowiseSyncOk, true);
  assert.ok(disk.approvedAt);
  console.log('PASS reapprove_updates_flowise_config');
}

function testHasEnoughForFirstBotRequiresName() {
  assert.equal(
    hasEnoughForFirstBot({ whatWeDo: 'Coffee shop' }),
    false,
    'description alone is not enough'
  );
  assert.equal(
    hasEnoughForFirstBot({ name: 'Cafe' }),
    false,
    'name alone is not enough'
  );
  assert.equal(
    hasEnoughForFirstBot({ name: '   ', whatWeDo: 'Coffee shop' }),
    false,
    'whitespace name is not enough'
  );
  assert.equal(
    hasEnoughForFirstBot({ name: 'Cafe', whatWeDo: 'Coffee shop' }),
    true,
    'name + whatWeDo is enough'
  );
  assert.equal(
    hasEnoughForFirstBot({
      name: 'Cafe',
      services: [{ name: 'Latte', price: '$4', notes: null }],
    }),
    true,
    'name + service is enough'
  );
  console.log('PASS has_enough_for_first_bot_requires_name');
}

async function testIntakeGateBlocksApprove() {
  clean();
  saveProfile(emptyProfile(), PROFILE);
  const flowiseMock = { calls: [] };

  const session = makeSession(async () => ({
    message: 'Looks ready to approve.',
    draft: {
      name: 'Cafe',
      whatWeDo: 'Coffee shop',
      ownerGoal: 'answer_questions',
      services: [{ name: 'Latte', price: '$4', notes: null }],
      hours: '7–3',
      locationOrArea: 'Downtown',
      commonQuestions: [],
      informationToCollect: null,
      unknowns: [],
      tone: 'warm',
    },
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);

  // Stub returns approved+ready but app gates on intake; builder soft-guard runs inside
  // real runBuilderTurn — here we stub the whole turn, so simulate gate in stub like app:
  // Actually handleBuild trusts result.approved from stub. Intake gate is inside runBuilderTurn.
  // For handler-level test of intake, stub must return what real runBuilderTurn would after gate.
  session.deps.runBuilderTurn = async () => ({
    message:
      'Looks ready.\n\nBefore we finalize: should the customer bot collect any information from the customer in chat (for example name, phone number, preferred time)? If yes, list what. If not, say none.',
    draft: {
      name: 'Cafe',
      whatWeDo: 'Coffee shop',
      ownerGoal: 'answer_questions',
      services: [{ name: 'Latte', price: '$4', notes: null }],
      hours: '7–3',
      locationOrArea: 'Downtown',
      commonQuestions: [],
      informationToCollect: null,
      unknowns: [],
      tone: 'warm',
    },
    readyForReview: false,
    approved: false,
    source: 'stub-builder',
  });

  // Required topics are asked by the app in order: FAQ first, then intake.
  const r = await handleMessage(session, 'approve');
  assert.equal(r.ok, true);
  assert.equal(r.approved, false);
  assert.equal(r.event, 'build_turn');
  assert.equal(flowiseMock.calls.length, 0);
  assert.equal(loadProfile(PROFILE).approvedAt, null);
  assert.match(r.reply, /questions do customers usually ask/i);
  assert.ok(!/collect any information/i.test(r.reply), 'one topic per turn');

  // Owner skips FAQ → settled (skippable); intake asked next, still no approval.
  const r2 = await handleMessage(session, 'skip');
  assert.equal(r2.approved, false);
  assert.match(r2.reply, /collect any information/i);
  assert.ok(!/questions do customers usually ask/i.test(r2.reply), 'FAQ asked once');

  // Intake still null after the owner replied → intake asked again (not skippable).
  const r3 = await handleMessage(session, 'hmm');
  assert.equal(r3.approved, false);
  assert.match(r3.reply, /collect any information/i);

  // Intake answered → review presented, not approved yet.
  session.deps.runBuilderTurn = async () => ({
    message: 'Got it, thanks!',
    draft: {
      name: 'Cafe',
      whatWeDo: 'Coffee shop',
      services: [{ name: 'Latte', price: '$4', notes: null }],
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
    },
    readyForReview: true,
    approved: false,
    source: 'stub-builder',
  });
  const r4 = await handleMessage(session, 'none');
  assert.equal(r4.approved, false);
  assert.match(r4.reply, /Try my bot/);
  assert.equal(flowiseMock.calls.length, 0);
  console.log('PASS required_topics_gate_blocks_approve');
}

function testGoalSupport() {
  const facts = {
    name: 'Waser',
    whatWeDo: 'Math tutoring',
    services: [{ name: 'Lesson', price: '$80 per hour', notes: null }],
    commonQuestions: [],
    informationToCollect: null,
  };
  const disclaimer =
    /Noted! book sessions isn't available yet, so I'll set the bot to answer questions and collect details for now\./;

  // Unsupported → fallback goal + fixed disclaimer before the next question.
  const u = applyReviewGate(
    emptyProfile(),
    {
      message: "I'll set the goal to booking sessions. Could you share common questions customers ask?",
      draft: { ...facts, ownerGoal: 'answer_questions', ownerGoalRequested: 'lead customers to book a session' },
      goalSupported: false,
      goalUnsupportedPart: 'book sessions',
      readyForReview: false,
    },
    'lead customers to book a session'
  );
  assert.equal(u.draft.ownerGoal, 'answer_and_collect');
  assert.equal(u.draft.ownerGoalRequested, 'lead customers to book a session');
  assert.match(u.message, disclaimer);
  assert.ok(u.message.startsWith('Noted!'), 'model ack replaced by disclaimer');
  assert.ok(
    u.message.indexOf("isn't available yet") < u.message.indexOf('What questions do customers'),
    'disclaimer before the question'
  );

  // Model forgot goalSupported=false: owner's wording still triggers the fallback.
  const missed = applyReviewGate(
    emptyProfile(),
    {
      message: "I'll set the goal to help customers book. Should the bot collect anything?",
      draft: { ...facts, ownerGoal: 'answer_questions' },
      goalSupported: null,
      readyForReview: false,
    },
    'lead customers to book a session with me'
  );
  assert.equal(missed.draft.ownerGoal, 'answer_and_collect');
  assert.match(missed.message, /^Noted! book appointments isn't available yet/);
  assert.doesNotMatch(missed.message, /help customers book/);

  // Supported → no disclaimer.
  const s = applyReviewGate(
    emptyProfile(),
    {
      message: 'Got it.',
      draft: { ...facts, ownerGoal: 'answer_questions' },
      goalSupported: true,
      readyForReview: false,
    },
    'answer questions'
  );
  assert.equal(s.draft.ownerGoal, 'answer_questions');
  assert.doesNotMatch(s.message, /Noted!/);

  // reconcileDraft: invalid/omitted goal keeps previous; free text never stored.
  assert.equal(reconcileDraft({ ownerGoal: 'sell more' }, { ownerGoal: 'collect_details' }).ownerGoal, 'collect_details');
  assert.equal(reconcileDraft({}, { ownerGoal: null }).ownerGoal, null);
  assert.equal(reconcileDraft({ ownerGoal: 'answer_questions' }, {}).ownerGoal, 'answer_questions');
  assert.equal(
    reconcileDraft({}, { ownerGoalRequested: 'book lessons' }).ownerGoalRequested,
    'book lessons'
  );
  console.log('PASS goal_support');
}

function testRequiredTopicsGate() {
  const facts = {
    name: 'Waser',
    whatWeDo: 'Math tutoring',
    services: [{ name: 'Lesson', price: '$80 per hour', notes: null }],
    commonQuestions: [],
    informationToCollect: [],
  };
  const turn = { message: 'Got it, thanks!', draft: facts, readyForReview: true, approved: false };

  // FAQ never asked → asked now, recorded, no review.
  const a = applyReviewGate(emptyProfile(), turn, 'no');
  assert.equal(a.presentReview, false);
  assert.match(a.message, /^Got it, thanks!\n\nWhat questions do customers usually ask/);
  assert.deepEqual(a.draft.askedTopics, ['commonQuestions']);

  // Asked on a prior turn → settled even with no FAQ stored → review.
  const b = applyReviewGate({ ...emptyProfile(), draft: a.draft }, turn, 'skip');
  assert.equal(b.presentReview, true);

  // FAQ with an answer → settled without asking.
  const withFaq = {
    ...facts,
    commonQuestions: [{ question: 'Online lessons?', answer: 'No, only at home.' }],
  };
  const c = applyReviewGate(emptyProfile(), { ...turn, draft: withFaq }, 'x');
  assert.equal(c.presentReview, true);

  // Model not asking for review → gate stays out of the way.
  const d = applyReviewGate(emptyProfile(), { ...turn, readyForReview: false, message: 'Per hour?' }, 'hi');
  assert.equal(d.message, 'Per hour?');

  // Model asks FAQ in its own words → fixed question swapped in and recorded.
  const own = applyReviewGate(
    emptyProfile(),
    {
      ...turn,
      readyForReview: false,
      message: 'Great, so the goal is answering questions. Could you share common questions customers ask?',
    },
    'answer questions'
  );
  assert.equal(
    own.message,
    'Great, so the goal is answering questions.\n\nWhat questions do customers usually ask you, and what do you answer? Share a few in your own words — or say skip if you prefer not to now.'
  );
  assert.deepEqual(own.draft.askedTopics, ['commonQuestions']);
  // Owner skips → review next, FAQ not repeated.
  const own2 = applyReviewGate({ ...emptyProfile(), draft: own.draft }, turn, 'skip');
  assert.equal(own2.presentReview, true);

  // Goal question with intake-like examples is not treated as a topic question.
  const goalQ = applyReviewGate(
    emptyProfile(),
    {
      ...turn,
      draft: { ...facts, informationToCollect: null },
      readyForReview: false,
      message: "What's the main thing you'd like your bot to do? For example: collect contact details from interested customers.",
    },
    'waser'
  );
  assert.match(goalQ.message, /^What's the main thing/);
  assert.deepEqual(goalQ.draft.askedTopics, []);

  // Approved profiles skip required topics (edits are not blocked).
  const live = { ...emptyProfile(), ...facts, approvedAt: '2026-01-01T00:00:00Z' };
  const e = applyReviewGate(live, { ...turn, draft: { ...facts, tone: 'warm' } }, 'warmer');
  assert.equal(e.presentReview, true);
  console.log('PASS required_topics_gate');
}

async function testNullOwnerGoalDoesNotWipeLive() {
  clean();
  const live = baseApprovedLive();
  saveProfile(live, PROFILE);

  const merged = mergeDraft(live, {
    name: 'Sunny Yoga',
    whatWeDo: 'Private yoga lessons',
    ownerGoal: null,
    services: live.services,
    hours: live.hours,
    locationOrArea: live.locationOrArea,
    commonQuestions: [],
    informationToCollect: [],
    unknowns: [],
    tone: 'friendly',
  });
  assert.equal(
    merged.ownerGoal,
    'answer_and_collect',
    'null draft ownerGoal must not clear live'
  );

  const flowiseMock = { calls: [] };
  const session = makeSession(async () => ({
    message: 'Approved.',
    draft: {
      name: 'Sunny Yoga',
      whatWeDo: 'Private yoga lessons',
      ownerGoal: null,
      services: live.services,
      hours: live.hours,
      locationOrArea: live.locationOrArea,
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'friendly',
    },
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await reviewThenApprove(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'approved_synced');
  const disk = loadProfile(PROFILE);
  assert.equal(disk.ownerGoal, 'answer_and_collect');
  assert.equal(flowiseMock.calls[0].ownerGoal, disk.ownerGoal);
  console.log('PASS null_owner_goal_does_not_wipe_live');
}

async function testFormatSummaryIncludesOwnerGoal() {
  const p = emptyProfile();
  p.name = 'X';
  p.whatWeDo = 'Y';
  const s = formatSummary(p);
  assert.match(s, /Bot goal: \(not set\)/);
  p.ownerGoal = 'collect_details';
  assert.match(formatSummary(p), /Bot goal: Collect details from interested customers/);
  p.ownerGoal = 'Help customers book by messaging the owner';
  assert.match(formatSummary(p), /Bot goal: \(not set\)/, 'legacy free text is not a goal');
  assert.match(formatSummary(p), /Conversation settings:/);
  assert.match(formatSummary(p), /Prices:.*\(default\)/);
  console.log('PASS format_summary_owner_goal');
}

/** Case B: pending behavior settings must not affect live prompt / Flowise. */
async function testBehaviorDraftIsolatesLivePrompt() {
  clean();
  const live = baseApprovedLive();
  live.tone = 'friendly';
  live.responseLength = null;
  live.priceDisclosure = null;
  live.flowiseSyncedAt = '2026-01-01T00:00:00.000Z';
  saveProfile(live, PROFILE);
  const flowiseMock = { calls: [] };
  const syncedAtBefore = live.flowiseSyncedAt;

  const session = makeSession(async () => ({
    message: 'Updated style and price disclosure — approve when ready.',
    draft: {
      name: live.name,
      whatWeDo: live.whatWeDo,
      ownerGoal: live.ownerGoal,
      services: live.services,
      hours: live.hours,
      locationOrArea: live.locationOrArea,
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'warm and short',
      responseLength: 'short',
      priceDisclosure: 'on_request',
    },
    readyForReview: true,
    approved: false,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await handleMessage(
    session,
    'Keep replies warm and short, and only mention prices when customers ask about pricing.'
  );
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');
  assert.equal(flowiseMock.calls.length, 0);

  const disk = loadProfile(PROFILE);
  assert.equal(disk.priceDisclosure, null);
  assert.equal(disk.responseLength, null);
  assert.equal(disk.tone, 'friendly');
  assert.equal(disk.flowiseSyncedAt, syncedAtBefore);
  assert.equal(disk.draft.priceDisclosure, 'on_request');
  assert.equal(disk.draft.responseLength, 'short');

  const livePrompt = buildCustomerSystemPrompt(disk);
  assert.match(livePrompt, /Price disclosure: relevant/);
  assert.doesNotMatch(livePrompt, /on request only/i);

  const summary = formatSummary(disk);
  assert.match(summary, /Live approved \(active customer bot\)/);
  assert.match(summary, /Pending \(not live until you approve\)/);
  assert.match(summary, /Prices: when useful and relevant \(default\)/);
  assert.match(summary, /only when the customer asks about pricing/);
  console.log('PASS behavior_draft_isolates_live_prompt');
}

/** Approval propagates behavior settings into Flowise prompt; facts unchanged. */
async function testBehaviorApprovePropagatesToFlowise() {
  clean();
  const live = baseApprovedLive();
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);
  const flowiseMock = { calls: [] };

  const session = makeSession(async () => ({
    message: 'Approved behavior updates.',
    draft: {
      name: live.name,
      whatWeDo: live.whatWeDo,
      ownerGoal: live.ownerGoal,
      services: live.services,
      hours: live.hours,
      locationOrArea: live.locationOrArea,
      commonQuestions: live.commonQuestions,
      informationToCollect: live.informationToCollect,
      unknowns: live.unknowns,
      tone: 'warm and short',
      responseLength: 'short',
      priceDisclosure: 'on_request',
    },
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await reviewThenApprove(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'approved_synced');
  assert.equal(flowiseMock.calls.length, 1);

  const sent = flowiseMock.calls[0];
  assert.equal(sent.priceDisclosure, 'on_request');
  assert.equal(sent.responseLength, 'short');
  assert.equal(
    JSON.stringify(businessFactsView(sent)),
    factsBefore,
    'business facts must be unchanged on behavior approve'
  );

  const flowData = JSON.parse(buildFlowData(sent));
  const chain = flowData.nodes.find((n) => n.data?.name === 'conversationChain');
  const sys = chain?.data?.inputs?.systemMessagePrompt || '';
  assert.match(sys, /on request only/i);
  assert.match(sys, /Reply length: short/);

  const disk = loadProfile(PROFILE);
  assert.equal(disk.priceDisclosure, 'on_request');
  assert.equal(disk.responseLength, 'short');
  console.log('PASS behavior_approve_propagates_to_flowise');
}

/** Case I: legacy profile without new keys loads with safe defaults. */
async function testLegacyProfileSafeDefaults() {
  clean();
  const legacy = {
    name: 'Quiet Mat Yoga',
    whatWeDo: 'In-person private yoga lessons',
    ownerGoal: null,
    services: [
      {
        name: 'Private yoga lesson',
        price: '200 ILS for 60 minutes',
        notes: 'In-person',
      },
    ],
    hours: null,
    locationOrArea: 'Tel Aviv',
    commonQuestions: [],
    informationToCollect: [],
    unknowns: [],
    tone: 'warm and calm',
    approvedAt: '2026-01-01T00:00:00.000Z',
    chatflowId: 'cf-legacy',
    flowiseSyncOk: true,
    draft: null,
  };
  // Write raw JSON without responseLength / priceDisclosure keys
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  fs.writeFileSync(PROFILE, JSON.stringify(legacy, null, 2), 'utf8');

  const disk = loadProfile(PROFILE);
  assert.equal(disk.tone, 'warm and calm');
  assert.equal(disk.responseLength, null);
  assert.equal(disk.priceDisclosure, null);
  const eff = effectiveBehavior(disk);
  assert.equal(eff.responseLength, DEFAULT_BEHAVIOR.responseLength);
  assert.equal(eff.priceDisclosure, DEFAULT_BEHAVIOR.priceDisclosure);
  assert.equal(eff.tone, 'warm and calm');

  const prompt = buildCustomerSystemPrompt(disk);
  assert.match(prompt, /Tone: warm and calm/);
  assert.match(prompt, /Price disclosure: relevant/);
  assert.match(prompt, /Reply length: standard/);

  const summary = formatSummary(disk);
  assert.match(summary, /Tone: warm and calm/);
  assert.match(summary, /\(default\)/);
  console.log('PASS legacy_profile_safe_defaults');
}

/** Case J: style-only draft must not reset approved priceDisclosure. */
async function testStyleOnlyEditPreservesPriceDisclosure() {
  clean();
  const live = baseApprovedLive();
  live.priceDisclosure = 'on_request';
  live.responseLength = 'short';
  live.tone = 'warm and short';
  live.draft = {
    ...live.draft,
    priceDisclosure: 'on_request',
    responseLength: 'short',
    tone: 'warm and short',
  };
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);

  // Unit: reconcileDraft preserves priceDisclosure when omitted/nulled
  const reconciled = reconcileDraft(
    {
      name: live.name,
      whatWeDo: live.whatWeDo,
      ownerGoal: live.ownerGoal,
      services: live.services,
      hours: live.hours,
      locationOrArea: live.locationOrArea,
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'a bit friendlier',
      responseLength: 'short',
      priceDisclosure: null,
    },
    live.draft
  );
  assert.equal(reconciled.priceDisclosure, 'on_request');

  const flowiseMock = { calls: [] };
  const session = makeSession(async () => ({
    message: 'Updated tone only — approve when ready.',
    draft: reconciled,
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await reviewThenApprove(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'approved_synced');
  const disk = loadProfile(PROFILE);
  assert.equal(disk.priceDisclosure, 'on_request');
  assert.equal(disk.responseLength, 'short');
  assert.equal(disk.tone, 'a bit friendlier');
  assert.equal(JSON.stringify(businessFactsView(disk)), factsBefore);
  console.log('PASS style_only_edit_preserves_price_disclosure');
}

/** Behavior-only mergeDraft preserves every fact. */
async function testBehaviorOnlyMergePreservesFacts() {
  const live = baseApprovedLive();
  const before = JSON.stringify(businessFactsView(live));
  const merged = mergeDraft(live, {
    tone: 'professional and concise',
    responseLength: 'short',
    priceDisclosure: 'relevant',
  });
  assert.equal(JSON.stringify(businessFactsView(merged)), before);
  assert.equal(merged.tone, 'professional and concise');
  assert.equal(merged.responseLength, 'short');
  assert.equal(merged.priceDisclosure, 'relevant');
  assert.equal(
    draftDiffersFromLive(live, {
      tone: 'professional and concise',
      responseLength: 'short',
      priceDisclosure: 'relevant',
    }),
    true
  );
  assert.equal(
    draftDiffersFromLive(live, {
      priceDisclosure: 'relevant', // effective same as null default
    }),
    false,
    'null live + relevant draft must not differ (effective defaults)'
  );
  console.log('PASS behavior_only_merge_preserves_facts');
}

const MAYA_OPENING =
  'Hi, I’m Maya, the digital assistant of Yoga with Noa 🙂 How can I help?';

function identityLive() {
  const live = baseApprovedLive();
  live.name = 'Yoga with Noa';
  live.priceDisclosure = 'on_request';
  live.draft = { ...live.draft, name: live.name, priceDisclosure: 'on_request' };
  return live;
}

function draftFrom(live, overrides = {}) {
  return {
    name: live.name,
    whatWeDo: live.whatWeDo,
    ownerGoal: live.ownerGoal,
    services: live.services,
    hours: live.hours,
    locationOrArea: live.locationOrArea,
    commonQuestions: live.commonQuestions,
    informationToCollect: live.informationToCollect,
    unknowns: live.unknowns,
    tone: live.tone,
    responseLength: live.responseLength,
    priceDisclosure: live.priceDisclosure,
    ...overrides,
  };
}

function systemPromptSentTo(flowiseMock) {
  const flowData = JSON.parse(buildFlowData(flowiseMock.calls.at(-1)));
  const chain = flowData.nodes.find((n) => n.data?.name === 'conversationChain');
  return chain?.data?.inputs?.systemMessagePrompt || '';
}

/** Pending identity / opening must not affect the live prompt or Flowise. */
async function testIdentityDraftIsolatesLive() {
  clean();
  const live = identityLive();
  saveProfile(live, PROFILE);
  const flowiseMock = { calls: [] };
  // Model captures identity but asks an unrelated question instead of reviewing
  const session = makeSession(async ({ profile }) => ({
    message: 'Noted Maya. What outcome do you want this bot to achieve?',
    draft: reconcileDraft(
      draftFrom(live, { assistantName: 'Maya', openingMessage: MAYA_OPENING }),
      profile.draft
    ),
    readyForReview: false,
    approved: false,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await handleMessage(session, 'Call the assistant Maya…');
  assert.equal(r.event, 'build_turn');
  assert.equal(flowiseMock.calls.length, 0);
  assert.equal(r.readyForReview, true, 'settings-only edit is presented for review');
  assert.match(r.reply, /what will change:\n\nName & opening: Maya, custom opening \(was: default\)/);
  assert.match(r.reply, /1\. Try my bot\n2\. Make changes/);
  assert.doesNotMatch(r.reply, /What outcome/, 'model follow-up question stripped');
  const disk = loadProfile(PROFILE);
  assert.equal(disk.assistantName, null);
  assert.equal(disk.openingMessage, null);
  assert.equal(disk.draft.assistantName, 'Maya');
  const livePrompt = buildCustomerSystemPrompt(disk);
  assert.doesNotMatch(livePrompt, /Maya/);
  assert.match(livePrompt, /digital assistant of Yoga with Noa/);
  const summary = formatSummary(disk);
  assert.match(summary, /Live approved[\s\S]*Assistant name: \(not set — no name\)/);
  assert.match(summary, /Pending[\s\S]*Assistant name: Maya/);
  assert.match(summary, /Opening: “Hi, I’m Maya/);
  console.log('PASS identity_draft_isolates_live');
}

/** Approval persists both identity fields and propagates them into Flowise. */
async function testIdentityApprovePropagates() {
  clean();
  const live = identityLive();
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);
  const flowiseMock = { calls: [] };
  const session = makeSession(async ({ profile }) => ({
    message: 'Approved.',
    draft: reconcileDraft(
      draftFrom(live, { assistantName: 'Maya', openingMessage: MAYA_OPENING }),
      profile.draft
    ),
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);

  const r = await reviewThenApprove(session);
  assert.equal(r.event, 'approved_synced');
  assert.equal(flowiseMock.calls.length, 1);
  assert.equal(flowiseMock.calls[0].assistantName, 'Maya');
  assert.equal(flowiseMock.calls[0].openingMessage, MAYA_OPENING);
  const sys = systemPromptSentTo(flowiseMock);
  assert.match(sys, /Assistant name: Maya\./);
  assert.ok(sys.includes(MAYA_OPENING));
  assert.match(sys, /on request only/i);
  const disk = loadProfile(PROFILE);
  assert.equal(disk.assistantName, 'Maya');
  assert.equal(disk.openingMessage, MAYA_OPENING);
  assert.equal(JSON.stringify(businessFactsView(disk)), factsBefore);
  console.log('PASS identity_approve_propagates');
}

/** otherFacts in the draft are shown for review and reach the live profile and customer prompt. */
async function testOtherFactsApprovePropagates() {
  clean();
  const live = baseApprovedLive();
  live.approvedAt = null;
  live.chatflowId = null;
  live.flowiseSyncOk = false;
  live.flowiseSyncedAt = null;
  saveProfile(live, PROFILE);
  const facts = ['Fact A applies on weekdays only.', 'Fact B has no exceptions.'];
  const flowiseMock = { calls: [] };
  const session = makeSession(async () => ({
    message: 'Here is your draft.',
    draft: {
      ...live.draft,
      commonQuestions: [{ question: 'Do you offer gift cards?', answer: 'No.' }],
      otherFacts: facts,
    },
    readyForReview: true,
    approved: false,
    source: 'stub-builder',
  }), flowiseMock);

  const review = await handleMessage(session, 'Please apply this change.');
  assert.ok(
    review.reply.includes(`Other facts: ${facts[0]}; ${facts[1].replace(/\.$/, '')}`),
    'review card must list otherFacts'
  );
  const section = renderSection(1, loadProfile(PROFILE), 'en');
  assert.ok(section.includes('• Other facts:'), 'section 1 must list otherFacts');
  for (const f of facts) assert.ok(section.includes(`   - ${f}`));

  const r = await handleMessage(session, 'approve');
  assert.equal(r.event, 'approved_synced');
  const disk = loadProfile(PROFILE);
  assert.deepEqual(disk.otherFacts, facts);
  assert.deepEqual(flowiseMock.calls[0].otherFacts, facts);
  const sys = systemPromptSentTo(flowiseMock);
  assert.equal(sys, buildCustomerSystemPrompt(disk));
  assert.match(sys, /Other business facts and policies:/);
  for (const f of facts) assert.ok(sys.includes(`- ${f}`));
  console.log('PASS other_facts_approve_propagates');
}

/** Opening-only edit keeps assistantName and every other setting / fact. */
async function testOpeningOnlyEditPreservesName() {
  clean();
  const live = identityLive();
  live.assistantName = 'Maya';
  live.openingMessage = MAYA_OPENING;
  live.responseLength = 'short';
  live.tone = 'warm';
  live.draft = draftFrom(live, {
    assistantName: 'Maya',
    openingMessage: MAYA_OPENING,
  });
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);
  const newOpening = 'Hey, Maya here — how can I help with your yoga today?';

  // Model omits assistantName (null) on an opening-only edit
  const reconciled = reconcileDraft(
    draftFrom(live, { assistantName: null, openingMessage: newOpening }),
    live.draft
  );
  assert.equal(reconciled.assistantName, 'Maya');

  const flowiseMock = { calls: [] };
  const session = makeSession(async () => ({
    message: 'Opening updated.',
    draft: reconciled,
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);
  await reviewThenApprove(session);
  const disk = loadProfile(PROFILE);
  assert.equal(disk.assistantName, 'Maya');
  assert.equal(disk.openingMessage, newOpening);
  assert.equal(disk.priceDisclosure, 'on_request');
  assert.equal(disk.responseLength, 'short');
  assert.equal(disk.tone, 'warm');
  assert.equal(JSON.stringify(businessFactsView(disk)), factsBefore);
  console.log('PASS opening_only_edit_preserves_name');
}

/** Explicit reset flags clear identity on approval; defaults return. */
async function testIdentityResetRestoresDefault() {
  clean();
  const live = identityLive();
  live.assistantName = 'Maya';
  live.openingMessage = MAYA_OPENING;
  live.draft = draftFrom(live, {
    assistantName: 'Maya',
    openingMessage: MAYA_OPENING,
  });
  saveProfile(live, PROFILE);

  // Turn 1: owner asks to remove the name and use the default opening
  const resetDraft = reconcileDraft(
    draftFrom(live, {
      assistantName: null,
      openingMessage: null,
      assistantNameReset: true,
      openingMessageReset: true,
    }),
    live.draft
  );
  assert.equal(resetDraft.assistantName, null);
  assert.equal(resetDraft.assistantNameReset, true);
  // Turn 2 (unrelated edit, model omits flags) keeps the pending reset
  const laterDraft = reconcileDraft(
    draftFrom(live, { tone: 'calm' }),
    resetDraft
  );
  assert.equal(laterDraft.assistantNameReset, true);
  assert.equal(laterDraft.openingMessageReset, true);
  assert.equal(draftDiffersFromLive(live, laterDraft), true);

  const flowiseMock = { calls: [] };
  const session = makeSession(async () => ({
    message: 'Approved.',
    draft: laterDraft,
    readyForReview: true,
    approved: true,
    source: 'stub-builder',
  }), flowiseMock);
  const r = await reviewThenApprove(session);
  assert.equal(r.event, 'approved_synced');
  const disk = loadProfile(PROFILE);
  assert.equal(disk.assistantName, null);
  assert.equal(disk.openingMessage, null);
  assert.equal(disk.tone, 'calm');
  const sys = systemPromptSentTo(flowiseMock);
  assert.doesNotMatch(sys, /Maya/);
  assert.match(sys, /Assistant name: none/);
  assert.match(sys, /Opening: default/);
  assert.match(formatSummary(disk), /Opening: \(default\)/);

  // Omitted (no flag) must NOT clear a set name
  const kept = mergeDraft({ ...live }, { assistantName: null });
  assert.equal(kept.assistantName, 'Maya');
  console.log('PASS identity_reset_restores_default');
}

/** Legacy profiles without identity keys load with safe defaults. */
async function testLegacyIdentityDefaults() {
  clean();
  const legacy = {
    name: 'Quiet Mat Yoga',
    whatWeDo: 'In-person private yoga lessons',
    services: [{ name: 'Private yoga lesson', price: '200 ILS', notes: null }],
    informationToCollect: [],
    unknowns: [],
    commonQuestions: [],
    tone: 'warm and calm',
    approvedAt: '2026-01-01T00:00:00.000Z',
    chatflowId: 'cf-legacy',
    flowiseSyncOk: true,
    draft: { name: 'Quiet Mat Yoga', tone: 'warm and calm' },
  };
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  fs.writeFileSync(PROFILE, JSON.stringify(legacy, null, 2), 'utf8');
  const disk = loadProfile(PROFILE);
  assert.equal(disk.assistantName, null);
  assert.equal(disk.openingMessage, null);
  assert.equal(draftDiffersFromLive(disk, disk.draft), false);
  const prompt = buildCustomerSystemPrompt(disk);
  assert.match(prompt, /digital assistant of Quiet Mat Yoga/);
  assert.match(prompt, /Assistant name: none — do not invent a name/);
  assert.match(prompt, /Tone: warm and calm/);
  assert.match(formatSummary(disk), /Assistant name: \(not set — no name\)/);
  console.log('PASS legacy_identity_defaults');
}

function testIsOwnerApproveMessage() {
  assert.equal(isOwnerApproveMessage('approve'), true);
  assert.equal(isOwnerApproveMessage('Looks good'), true);
  assert.equal(isOwnerApproveMessage('yes'), true);
  assert.equal(isOwnerApproveMessage('ok'), true);
  assert.equal(isOwnerApproveMessage('yes, but make it warmer'), false);
  assert.equal(isOwnerApproveMessage('approve the price change to $80'), false);
  console.log('PASS is_owner_approve_message');
}

/**
 * Soft-approve honesty:
 * 1) pending draft already reviewed + "approve" → soft-approve
 * 2) "yes" that also introduces a new draft change this turn → no approve; draft kept
 * 3) first-time (no approvedAt) after a presented review → approve works
 */
async function testSoftApproveNoNewChangeThisTurn() {
  clean();
  const live = baseApprovedLive();
  live.priceDisclosure = 'on_request';
  live.draft = liveDraftWith(live, { priceDisclosure: 'on_request' });
  saveProfile(live, PROFILE);

  const draftRelevant = liveDraftWith(live, { priceDisclosure: 'relevant' });
  const flowiseMock = { calls: [] };
  const session = makeSession(
    queuedTurns([
      // Present review of relevant (pending)
      {
        message: 'Proposed: prices when useful and relevant.',
        draft: draftRelevant,
        readyForReview: true,
        approved: false,
      },
      // Bare approve of the already-reviewed draft
      {
        message: 'Approved.',
        draft: draftRelevant,
        readyForReview: true,
        approved: false,
      },
    ]),
    flowiseMock
  );

  const r1 = await handleMessage(session, 'Switch to mentioning prices when relevant.');
  assert.equal(r1.approved, false);
  assert.ok(loadProfile(PROFILE).reviewedDraftKey);
  assert.equal(loadProfile(PROFILE).draft.priceDisclosure, 'relevant');
  assert.equal(loadProfile(PROFILE).priceDisclosure, 'on_request');

  const softOk = shouldSoftApprove({
    profile: loadProfile(PROFILE),
    draft: draftRelevant,
    userMessage: 'approve',
  });
  assert.equal(softOk, true, 'reviewed pending draft + approve → soft-approve');

  const r2 = await handleMessage(session, 'approve');
  assert.equal(r2.approved, true);
  assert.equal(r2.event, 'approved_synced');
  assert.equal(loadProfile(PROFILE).priceDisclosure, 'relevant');
  console.log('PASS soft_approve_pending_then_approve');

  // --- (2) "yes" with a new change this turn does not approve; draft kept ---
  clean();
  const live2 = baseApprovedLive();
  live2.priceDisclosure = 'on_request';
  live2.draft = liveDraftWith(live2, { priceDisclosure: 'on_request' });
  saveProfile(live2, PROFILE);
  const flowiseMock2 = { calls: [] };
  const session2 = makeSession(
    queuedTurns([
      {
        message: 'That every-reply policy is not supported. Closest is relevant — want that?',
        draft: liveDraftWith(live2, { priceDisclosure: 'on_request' }),
        readyForReview: false,
        approved: false,
      },
      {
        message: 'Proposed relevant price disclosure — approve when ready.',
        draft: draftRelevant,
        readyForReview: true,
        approved: true, // model wrongly marks approved
      },
    ]),
    flowiseMock2
  );

  await handleMessage(session2, 'Put the price in every reply.');
  const rYes = await handleMessage(session2, 'yes');
  assert.equal(rYes.approved, false, 'yes + new change must not approve');
  assert.equal(flowiseMock2.calls.length, 0);
  const diskYes = loadProfile(PROFILE);
  assert.equal(diskYes.priceDisclosure, 'on_request', 'live unchanged');
  assert.equal(diskYes.draft.priceDisclosure, 'relevant', 'draft keeps accepted alternative');
  assert.ok(diskYes.reviewedDraftKey, 'review of new draft presented');
  assert.match(
    rYes.reply,
    /what will change:\n\nStyle: friendly, prices when relevant \(was: friendly, prices only when asked\)/,
    'shows the pending change when yes applies a new draft change'
  );
  assert.doesNotMatch(
    rYes.reply,
    /^Before I apply anything/m,
    'does not replace preview with stock note when draft changed'
  );
  assert.equal(
    shouldSoftApprove({
      profile: { ...diskYes, reviewedDraftKey: null },
      draft: draftRelevant,
      userMessage: 'yes',
    }),
    false,
    'no prior review → soft-approve false'
  );
  console.log('PASS soft_approve_yes_with_new_change_keeps_draft');

  // --- (3) first-time approval (no approvedAt) after presented review ---
  clean();
  const first = emptyProfile();
  first.name = 'Sunny Yoga';
  first.whatWeDo = 'Private yoga lessons';
  first.services = [{ name: 'Private lesson', price: '$70', notes: null }];
  first.informationToCollect = [];
  first.draft = liveDraftWith(first, {
    name: 'Sunny Yoga',
    whatWeDo: 'Private yoga lessons',
    services: first.services,
    informationToCollect: [],
    askedTopics: ['commonQuestions'],
  });
  saveProfile(first, PROFILE);
  const flowiseMock3 = { calls: [] };
  const session3 = makeSession(
    queuedTurns([
      {
        message: 'Here is your first bot summary.',
        draft: first.draft,
        readyForReview: true,
        approved: false,
      },
      {
        message: 'Creating your bot.',
        draft: first.draft,
        readyForReview: true,
        approved: false,
      },
    ]),
    flowiseMock3
  );

  const rFirstReview = await handleMessage(session3, 'Looks ready.');
  assert.equal(rFirstReview.approved, false);
  assert.ok(loadProfile(PROFILE).reviewedDraftKey);
  assert.equal(loadProfile(PROFILE).approvedAt, null);

  const rFirstApprove = await handleMessage(session3, 'approve');
  assert.equal(rFirstApprove.approved, true);
  assert.equal(rFirstApprove.event, 'approved_synced');
  assert.ok(loadProfile(PROFILE).approvedAt);
  console.log('PASS soft_approve_first_time_after_review');
}

/** Unsupported/ambiguous config requests cannot change the draft, whatever the field. */
function testEnforceConfigRequests() {
  const prev = {
    tone: 'warm',
    responseLength: null,
    priceDisclosure: 'on_request',
    openingMessage: null,
    assistantName: 'Noa',
    commonQuestions: [],
  };

  // Unsupported request smuggled into tone (field named) → restored
  const a = enforceConfigRequests(
    { ...prev, tone: 'warm; start every message with a different emoji' },
    prev,
    [{ request: 'different emoji every message', status: 'unsupported', field: 'tone' }]
  );
  assert.equal(a.draft.tone, 'warm');
  assert.equal(a.unresolved.length, 1);

  // Unsupported with no field, but model still wrote into openingMessage → restored
  const b = enforceConfigRequests(
    { ...prev, openingMessage: 'Reminder sent tomorrow!' },
    prev,
    [{ request: 'send reminders next day', status: 'unsupported', field: null }]
  );
  assert.equal(b.draft.openingMessage, null);

  // Supported change kept alongside an unsupported one
  const c = enforceConfigRequests(
    { ...prev, responseLength: 'short', tone: 'warm, emoji in every message' },
    prev,
    [
      { request: 'short replies', status: 'supported', field: 'responseLength' },
      { request: 'emoji in every message', status: 'unsupported', field: 'tone' },
    ]
  );
  assert.equal(c.draft.responseLength, 'short');
  assert.equal(c.draft.tone, 'warm');

  // Ambiguous on a fact field → restored
  const d = enforceConfigRequests(
    { ...prev, commonQuestions: [{ question: 'x', answer: 'y' }] },
    prev,
    [{ request: 'unclear', status: 'ambiguous', field: 'commonQuestions' }]
  );
  assert.deepEqual(d.draft.commonQuestions, []);

  // "supported" but carrying an alternative = not accepted → restored
  const f = enforceConfigRequests(
    { ...prev, priceDisclosure: 'relevant' },
    prev,
    [{ request: 'prices in every reply', status: 'supported', field: 'priceDisclosure', alternative: 'relevant' }]
  );
  assert.equal(f.draft.priceDisclosure, 'on_request');
  assert.equal(f.unresolved.length, 1);

  // All supported → untouched
  const e = enforceConfigRequests(
    { ...prev, tone: 'playful' },
    prev,
    [{ request: 'playful tone', status: 'supported', field: 'tone' }]
  );
  assert.equal(e.draft.tone, 'playful');
  assert.equal(e.unresolved.length, 0);
  console.log('PASS enforce_config_requests');
}

function testIntakeGateAsksOneQuestion() {
  const gate = 'Should the bot collect anything? If not, say none.';
  const out = withSingleQuestion(
    'Thank you! I noted your service is healing. Could you share any pricing for your services?',
    gate
  );
  assert.equal(out, `Thank you! I noted your service is healing.\n\n${gate}`);
  assert.equal(withSingleQuestion('What are your hours?', gate), gate);
  assert.equal(withSingleQuestion('', gate), gate);
  console.log('PASS intake_gate_asks_one_question');
}

async function main() {
  testEnforceConfigRequests();
  testIntakeGateAsksOneQuestion();
  testRequiredTopicsGate();
  testGoalSupport();
  testHasEnoughForFirstBotRequiresName();
  await testFormatSummaryIncludesOwnerGoal();
  await testDraftEditLeavesLiveUnchanged();
  await testReapproveUpdatesFlowise();
  await testIntakeGateBlocksApprove();
  await testNullOwnerGoalDoesNotWipeLive();
  await testBehaviorDraftIsolatesLivePrompt();
  await testBehaviorApprovePropagatesToFlowise();
  await testLegacyProfileSafeDefaults();
  await testStyleOnlyEditPreservesPriceDisclosure();
  await testBehaviorOnlyMergePreservesFacts();
  await testApproveRequiresPresentedReview();
  await testEditAfterReviewRequiresNewReview();
  await testSoftApproveNoNewChangeThisTurn();
  await testIdentityDraftIsolatesLive();
  await testIdentityApprovePropagates();
  await testOtherFactsApprovePropagates();
  await testOpeningOnlyEditPreservesName();
  await testIdentityResetRestoresDefault();
  await testLegacyIdentityDefaults();
  testIsOwnerApproveMessage();
  clean();
  console.log('\nAll approval-boundary tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
