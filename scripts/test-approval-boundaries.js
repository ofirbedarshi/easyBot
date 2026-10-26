/**
 * Deterministic approval-boundary tests through real handleMessage handlers
 * with stubbed Builder turns (no network). Each approval that makes the
 * Business Bot live records a snapshot of the live profile.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  businessFactsView,
  CONFIG_CAPABILITIES,
  DEFAULT_BEHAVIOR,
  draftDiffersFromLive,
  effectiveBehavior,
  emptyProfile,
  customerOpeningText,
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
  GOAL_FALLBACK_DISCLAIMER,
  OWNER_GOAL_QUESTION,
  reconcileDraft,
  withSingleQuestion,
} from '../src/builder.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import { createSession, handleMessage as runMessage } from '../src/session.js';
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
    askedTopics: ['commonQuestions', 'informationToCollect'],
  };
  return p;
}

function makeSession(stubTurn) {
  const session = createSession({
    profilePath: PROFILE,
    deps: { runBuilderTurn: stubTurn },
  });
  // Past the wake/opening turn so stubs exercise Builder turns.
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  return session;
}

async function handleMessage(session, text) {
  return runMessage(session, text);
}

/** One stubbed Builder turn that applies the draft immediately. */
async function applyChange(session) {
  return handleMessage(session, 'Please apply this change.');
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
    askedTopics: ['commonQuestions', 'informationToCollect'],
    ...overrides,
  };
}

/** A draft change is live on that turn; typed "approve" is just another Builder turn. */
async function testApproveRequiresPresentedReview() {
  clean();
  const live = baseApprovedLive();
  saveProfile(live, PROFILE);
  const liveMock = { approvals: [] };
  const draft80 = liveDraftWith(live, {
    services: [{ name: 'Private lesson', price: '$80 / 60 min', notes: null }],
  });
  const session = makeSession(
    queuedTurns([
      { message: 'Noted the new price.', draft: draft80, readyForReview: false },
      { message: 'Already saved.', draft: draft80, readyForReview: false, asksQuestion: false },
    ]),
    liveMock
  );

  const r0 = await handleMessage(session, 'Change private lessons to $80.');
  assert.equal(loadProfile(PROFILE).services[0].price, '$80 / 60 min');
  assert.match(r0.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  assert.match(r0.reply, /Services: Private lesson — \$80 \/ 60 min/);
  assert.doesNotMatch(r0.reply, /\(was:/);

  const r1 = await handleMessage(session, 'approve');
  assert.ok(!r1.approved);
  assert.equal(r1.event, 'build_turn');
  assert.equal(loadProfile(PROFILE).services[0].price, '$80 / 60 min');
  assert.match(r1.reply, /🏪 Tell me more about your business/);
  console.log('PASS edit_saves_immediately_typed_approve_is_builder_turn');
}

/** Each edit is live immediately; a second edit overwrites the first. */
async function testEditAfterReviewRequiresNewReview() {
  clean();
  const live = baseApprovedLive();
  saveProfile(live, PROFILE);
  const draft80 = liveDraftWith(live, {
    services: [{ name: 'Private lesson', price: '$80 / 60 min', notes: null }],
  });
  const draft90 = liveDraftWith(live, {
    services: [{ name: 'Private lesson', price: '$90 / 60 min', notes: null }],
  });
  const session = makeSession(
    queuedTurns([
      { message: 'Here is the change.', draft: draft80, readyForReview: true },
      { message: 'Updated to $90.', draft: draft90, readyForReview: true },
    ])
  );

  const r1 = await handleMessage(session, 'Change private lessons to $80.');
  assert.match(r1.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  assert.equal(loadProfile(PROFILE).services[0].price, '$80 / 60 min');

  const r2 = await handleMessage(session, 'Actually make it $90.');
  assert.match(r2.reply, /Got it, I'll remember that! 🌟 Here's what changed:[\s\S]*\$90 \/ 60 min/);
  assert.equal(loadProfile(PROFILE).services[0].price, '$90 / 60 min');
  console.log('PASS successive_edits_save_immediately');
}

async function testDraftEditLeavesLiveUnchanged() {
  clean();
  saveProfile(baseApprovedLive(), PROFILE);
  const liveMock = { approvals: [] };
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
    source: 'stub-builder',
  }), liveMock);

  const r = await handleMessage(session, 'Change private lessons to $80 and update the goal.');
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');

  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '$80 / 60 min');
  assert.equal(disk.ownerGoal, pendingGoal);
  assert.ok(disk.approvedAt);
  assert.match(r.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  const summary = formatSummary(disk);
  assert.doesNotMatch(summary, /Pending \(not live until you approve\)/);
  assert.match(summary, /\$80 \/ 60 min/);
  assert.match(summary, /Bot goal:/);
  console.log('PASS draft_edit_saves_live');
}

async function testReapproveUpdatesLiveBot() {
  clean();
  saveProfile(baseApprovedLive(), PROFILE);
  const liveMock = { approvals: [] };
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
    source: 'stub-builder',
  }), liveMock);

  const r = await applyChange(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');
  assert.match(r.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);

  const sent = loadProfile(PROFILE);
  assert.equal(sent.services[0].price, '$80 / 60 min');
  assert.equal(sent.ownerGoal, newGoal);

  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '$80 / 60 min');
  assert.equal(disk.ownerGoal, newGoal);
  assert.ok(disk.approvedAt);
  console.log('PASS reapprove_updates_live_bot');
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
  const liveMock = { approvals: [] };

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
    source: 'stub-builder',
  }), liveMock);

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
    readyForReview: true,
    source: 'stub-builder',
  });

  // Required topics are asked by the app in order: FAQ first, then intake.
  const r = await handleMessage(session, 'That is everything.');
  assert.equal(r.ok, true);
  assert.ok(!r.approved);
  assert.equal(r.event, 'build_turn');
  assert.match(r.reply, /what do customers usually ask you/i);
  assert.equal(loadProfile(PROFILE).name, 'Cafe');
  assert.equal(loadProfile(PROFILE).approvedAt, null, 'ready timestamp waits until first-time topics settle');
  assert.ok(!/collect any details/i.test(r.reply), 'one topic per turn');

  // Owner skips FAQ → settled (skippable); intake asked next, still no approval.
  const r2 = await handleMessage(session, 'skip');
  assert.ok(!r2.approved);
  assert.match(r2.reply, /collect any details/i);
  assert.ok(!/what do customers usually ask you/i.test(r2.reply), 'FAQ asked once');

  // Intake still null after the owner replied → intake asked again (not skippable).
  const r3 = await handleMessage(session, 'hmm');
  assert.ok(!r3.approved);
  assert.match(r3.reply, /collect any details/i);

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
    source: 'stub-builder',
  });
  const r4 = await handleMessage(session, 'none');
  assert.ok(!r4.approved);
  assert.match(r4.reply, /Chat with me like a customer/);
  assert.deepEqual(loadProfile(PROFILE).informationToCollect, []);
  console.log('PASS required_topics_still_asked');
}

function testGoalSupport() {
  const facts = {
    name: 'Waser',
    whatWeDo: 'Math tutoring',
    services: [{ name: 'Lesson', price: '$80 per hour', notes: null }],
    commonQuestions: [],
    informationToCollect: null,
  };

  assert.match(OWNER_GOAL_QUESTION, /how can I help you the most/);
  assert.match(OWNER_GOAL_QUESTION, /Answer your customers' questions/);
  assert.match(OWNER_GOAL_QUESTION, /Ask customers for their details/);
  assert.doesNotMatch(OWNER_GOAL_QUESTION, /booking an appointment/);

  // Unsupported (model flag) → fallback goal + mapped-goal line before the next question.
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
  assert.ok(u.message.startsWith(GOAL_FALLBACK_DISCLAIMER), 'model ack replaced by mapped-goal line');
  assert.doesNotMatch(u.message, /isn't available yet/);
  assert.ok(
    u.message.indexOf(GOAL_FALLBACK_DISCLAIMER) < u.message.indexOf('What do customers usually ask'),
    'mapped-goal line before the question'
  );

  // Mixed collect + book, model marks supported → keep that goal, no fallback line.
  const mixed = applyReviewGate(
    emptyProfile(),
    {
      message: 'Got it, thanks!',
      draft: {
        ...facts,
        ownerGoal: 'answer_and_collect',
        ownerGoalRequested: 'answer questions and take messages when people want to book',
      },
      goalSupported: true,
      readyForReview: false,
    },
    'answer questions and take messages when people want to book'
  );
  assert.equal(mixed.draft.ownerGoal, 'answer_and_collect');
  assert.equal(mixed.message, 'Got it, thanks!');
  assert.ok(!mixed.message.includes("isn't available yet"));
  assert.ok(!mixed.message.includes(GOAL_FALLBACK_DISCLAIMER));

  // Model omitted goalSupported: the owner's words are not inspected.
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
  assert.equal(missed.draft.ownerGoal, 'answer_questions');
  assert.equal(
    missed.message,
    "I'll set the goal to help customers book. Should the bot collect anything?"
  );

  // Supported → no fallback line.
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
  assert.ok(!s.message.includes(GOAL_FALLBACK_DISCLAIMER));

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
  const turn = { message: 'Got it, thanks!', draft: facts, readyForReview: true };

  // FAQ never asked → asked now, recorded, no review.
  const a = applyReviewGate(emptyProfile(), turn, 'no');
  assert.equal(a.presentReview, false);
  assert.match(a.message, /^Got it! 💛\n\nWhat do customers usually ask you/);
  assert.deepEqual(a.draft.askedTopics, ['commonQuestions']);

  // App-asked FAQ uses the fixed ack, not the model's lead.
  const specificLead =
    'A family bakery in the old town sounds like a place neighbors already know.';
  const specific = applyReviewGate(
    emptyProfile(),
    { message: specificLead, draft: facts, readyForReview: true },
    'we are a family-run bakery in the old town'
  );
  assert.equal(specific.presentReview, false);
  assert.equal(
    specific.message,
    'Got it! 💛\n\nWhat do customers usually ask you, and how would you like me to answer? 🤔💬\nShare a few in your own words, or say "skip" for now.'
  );
  assert.deepEqual(specific.draft.askedTopics, ['commonQuestions']);

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
    'Great, so the goal is answering questions.\n\nWhat do customers usually ask you, and how would you like me to answer? 🤔💬\nShare a few in your own words, or say "skip" for now.'
  );
  assert.deepEqual(own.draft.askedTopics, ['commonQuestions']);

  // wantsReview with an open required topic → ask the topic, not review.
  const wantOpen = applyReviewGate(
    emptyProfile(),
    {
      message: 'Here is the updated summary:\nQ&A:\n- invented $99',
      draft: facts,
      readyForReview: false,
      wantsReview: true,
    },
    'show me the summary'
  );
  assert.equal(wantOpen.presentReview, false);
  assert.match(wantOpen.message, /What do customers usually ask you/);

  // wantsReview with intake answered → review; model summary text is stripped.
  const readyFacts = {
    ...facts,
    commonQuestions: [{ question: 'Online lessons?', answer: 'No, only at home.' }],
  };
  const wantReview = applyReviewGate(
    emptyProfile(),
    {
      message: 'Here is the updated summary:\nQ&A:\n- invented $99',
      draft: readyFacts,
      readyForReview: false,
      wantsReview: true,
    },
    'show me the summary'
  );
  assert.equal(wantReview.presentReview, true);
  assert.equal(wantReview.readyForReview, true);
  assert.doesNotMatch(wantReview.message, /invented|\$99|updated summary/i);

  // A changed draft with asksQuestion and no review flags does not force a review.
  const midQ = applyReviewGate(
    emptyProfile(),
    {
      message: 'How many instructors work there?',
      draft: { ...readyFacts, services: [{ name: 'Lesson', price: '$90 per hour', notes: null }] },
      readyForReview: false,
      wantsReview: false,
      asksQuestion: true,
    },
    'the lesson is 90 now'
  );
  assert.equal(midQ.presentReview, false);
  assert.equal(midQ.asksQuestion, true);
  assert.equal(midQ.draft.services[0].price, '$90 per hour');

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

  const liveMock = { approvals: [] };
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
    source: 'stub-builder',
  }), liveMock);

  // Null ownerGoal merges to the live config: nothing changed, current-bot card.
  const r = await applyChange(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');
  assert.match(r.reply, /Here's your bot for Sunny Yoga:/);
  assert.equal(loadProfile(PROFILE).ownerGoal, 'answer_and_collect');
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

/** Case B: pending behavior settings must not affect the live prompt. */
async function testBehaviorDraftIsolatesLivePrompt() {
  clean();
  const live = baseApprovedLive();
  live.tone = 'friendly';
  live.responseLength = null;
  live.priceDisclosure = null;
  saveProfile(live, PROFILE);
  const liveMock = { approvals: [] };
  const approvedAtBefore = live.approvedAt;

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
    source: 'stub-builder',
  }), liveMock);

  const r = await handleMessage(
    session,
    'Keep replies warm and short, and only mention prices when customers ask about pricing.'
  );
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');

  const disk = loadProfile(PROFILE);
  assert.equal(disk.priceDisclosure, 'on_request');
  assert.equal(disk.responseLength, 'short');
  assert.equal(disk.tone, 'warm and short');
  assert.equal(disk.approvedAt, approvedAtBefore);

  const livePrompt = buildCustomerSystemPrompt(disk);
  assert.match(livePrompt, /on request only/i);
  const summary = formatSummary(disk);
  assert.doesNotMatch(summary, /Pending \(not live until you approve\)/);
  assert.match(summary, /only when the customer asks about pricing/);
  console.log('PASS behavior_edit_saves_live_prompt');
}

/** Approval propagates behavior settings into the live prompt; facts unchanged. */
async function testBehaviorApprovePropagatesToLivePrompt() {
  clean();
  const live = baseApprovedLive();
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);
  const liveMock = { approvals: [] };

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
    source: 'stub-builder',
  }), liveMock);

  const r = await applyChange(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');

  const sent = loadProfile(PROFILE);
  assert.equal(sent.priceDisclosure, 'on_request');
  assert.equal(sent.responseLength, 'short');
  assert.equal(
    JSON.stringify(businessFactsView(sent)),
    factsBefore,
    'business facts must be unchanged on behavior approve'
  );

  const sys = buildCustomerSystemPrompt(sent);
  assert.match(sys, /on request only/i);
  assert.match(sys, /Reply length: short/);

  const disk = loadProfile(PROFILE);
  assert.equal(disk.priceDisclosure, 'on_request');
  assert.equal(disk.responseLength, 'short');
  console.log('PASS behavior_approve_propagates_to_live_prompt');
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
    retiredField: 'dropped on load',
    draft: null,
  };
  // Write raw JSON without responseLength / priceDisclosure keys
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  fs.writeFileSync(PROFILE, JSON.stringify(legacy, null, 2), 'utf8');

  const disk = loadProfile(PROFILE);
  assert.equal(Object.hasOwn(disk, 'retiredField'), false, 'unknown keys dropped on load');
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

  const liveMock = { approvals: [] };
  const session = makeSession(async () => ({
    message: 'Updated tone only — approve when ready.',
    draft: reconciled,
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);

  const r = await applyChange(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');
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

const CUSTOM_OPENING =
  "Hi, I'm Adam, Yoga with Noa's digital assistant 🙂 How can I help?";

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

/** Opening edits save on that turn. */
async function testIdentityDraftIsolatesLive() {
  clean();
  const live = identityLive();
  saveProfile(live, PROFILE);
  const liveMock = { approvals: [] };
  const session = makeSession(async ({ profile }) => ({
    message: 'Noted the opening. What outcome do you want this bot to achieve?',
    draft: reconcileDraft(
      draftFrom(live, { openingMessage: CUSTOM_OPENING }),
      profile.draft
    ),
    readyForReview: false,
    source: 'stub-builder',
  }), liveMock);

  const r = await handleMessage(session, 'Use this opening…');
  assert.equal(r.event, 'build_turn');
  assert.equal(r.readyForReview, true, 'settings-only edit is presented as a save card');
  assert.match(r.reply, /Got it, I'll remember that! 🌟 Here's what changed:\n\nHow I talk: friendly, prices only when asked, custom opening/);
  assert.doesNotMatch(r.reply, /\(was:/);
  assert.match(r.reply, /1\. 🤖 Chat with me like a customer\n2\. ✏️ Keep teaching me/);
  assert.doesNotMatch(r.reply, /What outcome/, 'model follow-up question stripped');
  const disk = loadProfile(PROFILE);
  assert.equal(disk.openingMessage, CUSTOM_OPENING);
  assert.equal('assistantName' in disk, false);
  const livePrompt = buildCustomerSystemPrompt(disk);
  assert.match(livePrompt, /You are Adam, Yoga with Noa's digital assistant/);
  const summary = formatSummary(disk);
  assert.doesNotMatch(summary, /Pending/);
  assert.doesNotMatch(summary, /Assistant name/);
  assert.match(summary, /Opening: “/);
  console.log('PASS identity_edit_saves_live');
}

/** Approval persists the opening and keeps Adam identity in the live prompt. */
async function testIdentityApprovePropagates() {
  clean();
  const live = identityLive();
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);
  const liveMock = { approvals: [] };
  const session = makeSession(async ({ profile }) => ({
    message: 'Approved.',
    draft: reconcileDraft(
      draftFrom(live, { openingMessage: CUSTOM_OPENING }),
      profile.draft
    ),
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);

  const r = await applyChange(session);
  assert.equal(r.event, 'build_turn');
  const diskLive = loadProfile(PROFILE);
  assert.equal(diskLive.openingMessage, CUSTOM_OPENING);
  assert.equal('assistantName' in diskLive, false);
  const sys = buildCustomerSystemPrompt(diskLive);
  assert.match(sys, /You are Adam, Yoga with Noa's digital assistant/);
  assert.doesNotMatch(sys, /Assistant name:/);
  assert.doesNotMatch(sys, /Use the opening ONLY/);
  assert.equal(customerOpeningText(diskLive), CUSTOM_OPENING);
  assert.match(sys, /on request only/i);
  const disk = loadProfile(PROFILE);
  assert.equal(disk.openingMessage, CUSTOM_OPENING);
  assert.equal(JSON.stringify(businessFactsView(disk)), factsBefore);
  console.log('PASS identity_approve_propagates');
}

/** otherFacts in the draft are shown for review and reach the live profile and customer prompt. */
async function testOtherFactsApprovePropagates() {
  clean();
  const live = baseApprovedLive();
  live.approvedAt = null;
  saveProfile(live, PROFILE);
  const facts = ['Fact A applies on weekdays only.', 'Fact B has no exceptions.'];
  const liveMock = { approvals: [] };
  const session = makeSession(async () => ({
    message: 'Here is your draft.',
    draft: {
      ...live.draft,
      commonQuestions: [{ question: 'Do you offer gift cards?', answer: 'No.' }],
      otherFacts: facts,
    },
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);

  const review = await handleMessage(session, 'Please apply this change.');
  assert.ok(
    review.reply.includes(`Other facts: ${facts[0]}; ${facts[1].replace(/\.$/, '')}`),
    'review card must list otherFacts'
  );
  const section = renderSection(1, loadProfile(PROFILE));
  assert.ok(section.includes('• Other facts:'), 'section 1 must list otherFacts');
  for (const f of facts) assert.ok(section.includes(`   - ${f}`));

  const r = await handleMessage(session, '1');
  assert.equal(r.event, 'enter_test');
  const disk = loadProfile(PROFILE);
  assert.deepEqual(disk.otherFacts, facts);
  const sys = buildCustomerSystemPrompt(disk);
  assert.equal(sys, buildCustomerSystemPrompt(disk));
  assert.match(sys, /Other business facts and policies:/);
  for (const f of facts) assert.ok(sys.includes(`- ${f}`));
  console.log('PASS other_facts_approve_propagates');
}

/** Opening-only edit keeps every other setting / fact. */
async function testOpeningOnlyEditPreservesName() {
  clean();
  const live = identityLive();
  live.openingMessage = CUSTOM_OPENING;
  live.responseLength = 'short';
  live.tone = 'warm';
  live.draft = draftFrom(live, {
    openingMessage: CUSTOM_OPENING,
  });
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);
  const newOpening = "Hey — how can I help with your yoga today?";

  const reconciled = reconcileDraft(
    draftFrom(live, { openingMessage: newOpening }),
    live.draft
  );
  assert.equal(reconciled.tone, 'warm');
  assert.equal(reconciled.priceDisclosure, 'on_request');

  const liveMock = { approvals: [] };
  const session = makeSession(async () => ({
    message: 'Opening updated.',
    draft: reconciled,
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);
  await applyChange(session);
  const disk = loadProfile(PROFILE);
  assert.equal(disk.openingMessage, newOpening);
  assert.equal(disk.priceDisclosure, 'on_request');
  assert.equal(disk.responseLength, 'short');
  assert.equal(disk.tone, 'warm');
  assert.equal(JSON.stringify(businessFactsView(disk)), factsBefore);
  console.log('PASS opening_only_edit_preserves_name');
}

/** Explicit reset flags clear the opening on approval; Adam default returns. */
async function testIdentityResetRestoresDefault() {
  clean();
  const live = identityLive();
  live.openingMessage = CUSTOM_OPENING;
  live.draft = draftFrom(live, {
    openingMessage: CUSTOM_OPENING,
  });
  saveProfile(live, PROFILE);

  const resetDraft = reconcileDraft(
    draftFrom(live, {
      openingMessage: null,
      openingMessageReset: true,
    }),
    live.draft
  );
  assert.equal(resetDraft.openingMessage, null);
  assert.equal(resetDraft.openingMessageReset, true);
  const laterDraft = reconcileDraft(
    draftFrom(live, { tone: 'calm' }),
    resetDraft
  );
  assert.equal(laterDraft.openingMessageReset, true);
  assert.equal(draftDiffersFromLive(live, laterDraft), true);

  const liveMock = { approvals: [] };
  const session = makeSession(async () => ({
    message: 'Approved.',
    draft: laterDraft,
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);
  const r = await applyChange(session);
  assert.equal(r.event, 'build_turn');
  const disk = loadProfile(PROFILE);
  assert.equal(disk.openingMessage, null);
  assert.equal(disk.tone, 'calm');
  const sys = buildCustomerSystemPrompt(disk);
  assert.match(sys, /You are Adam, Yoga with Noa's digital assistant/);
  assert.doesNotMatch(sys, /Assistant name:/);
  assert.doesNotMatch(sys, /Use the opening ONLY/);
  assert.match(formatSummary(disk), /Opening: \(default\)/);

  const kept = mergeDraft({ ...live }, { openingMessage: null });
  assert.equal(kept.openingMessage, CUSTOM_OPENING);
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
    retiredField: 'dropped on load',
    draft: { name: 'Quiet Mat Yoga', tone: 'warm and calm' },
  };
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  fs.writeFileSync(PROFILE, JSON.stringify(legacy, null, 2), 'utf8');
  const disk = loadProfile(PROFILE);
  assert.equal('assistantName' in disk, false);
  assert.equal(disk.openingMessage, null);
  assert.equal(draftDiffersFromLive(disk, disk.draft), false);
  const prompt = buildCustomerSystemPrompt(disk);
  assert.match(prompt, /You are Adam, Quiet Mat Yoga's digital assistant/);
  assert.doesNotMatch(prompt, /Assistant name:/);
  assert.match(prompt, /Tone: warm and calm/);
  assert.doesNotMatch(formatSummary(disk), /Assistant name/);
  assert.match(formatSummary(disk), /Opening: \(default\)/);
  console.log('PASS legacy_identity_defaults');
}

/**
 * Typed "approve" / "yes" are ordinary Builder turns. A real draft change
 * on that turn is saved immediately.
 */
async function testTypedApproveIsBuilderTurn() {
  clean();
  const live = baseApprovedLive();
  live.priceDisclosure = 'on_request';
  live.draft = liveDraftWith(live, { priceDisclosure: 'on_request' });
  saveProfile(live, PROFILE);

  const draftRelevant = liveDraftWith(live, { priceDisclosure: 'relevant' });
  const session = makeSession(
    queuedTurns([
      {
        message: 'Saved the price setting.',
        draft: draftRelevant,
        readyForReview: true,
      },
      {
        message: 'Already saved.',
        draft: draftRelevant,
        readyForReview: false,
        asksQuestion: false,
      },
    ])
  );

  const r1 = await handleMessage(session, 'Switch to mentioning prices when relevant.');
  assert.ok(!r1.approved);
  assert.equal(loadProfile(PROFILE).priceDisclosure, 'relevant');
  assert.match(r1.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);

  const typed = await handleMessage(session, 'approve');
  assert.equal(typed.event, 'build_turn');
  assert.equal(loadProfile(PROFILE).priceDisclosure, 'relevant');
  assert.match(typed.reply, /🏪 Tell me more about your business/);
  console.log('PASS typed_approve_is_builder_turn_change_already_saved');

  clean();
  const live2 = baseApprovedLive();
  live2.priceDisclosure = 'on_request';
  live2.draft = liveDraftWith(live2, { priceDisclosure: 'on_request' });
  saveProfile(live2, PROFILE);
  const session2 = makeSession(
    queuedTurns([
      {
        message: 'That every-reply policy is not supported. Closest is relevant — want that?',
        draft: liveDraftWith(live2, { priceDisclosure: 'on_request' }),
        readyForReview: false,
        asksQuestion: true,
      },
      {
        message: 'Using relevant.',
        draft: draftRelevant,
        readyForReview: true,
      },
    ])
  );

  await handleMessage(session2, 'Put the price in every reply.');
  const rYes = await handleMessage(session2, 'yes');
  assert.ok(!rYes.approved);
  assert.equal(loadProfile(PROFILE).priceDisclosure, 'relevant');
  assert.match(rYes.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  console.log('PASS typed_yes_saves_accepted_alternative');
}

/** Catalog: per-offering quote/process rules are facts; global never-prices is not. */
function testConfigCapabilitiesQuoteRules() {
  const facts = CONFIG_CAPABILITIES.find((c) => c.field === 'business facts');
  const price = CONFIG_CAPABILITIES.find((c) => c.field === 'priceDisclosure');
  assert.ok(facts && price, 'catalog entries exist');
  assert.match(facts.represents, /otherFacts/);
  assert.match(facts.represents, /priced or quoted/);
  assert.doesNotMatch(facts.cannotRepresent, /how the bot behaves/i);
  assert.match(price.cannotRepresent, /global never-mention-any-prices/);
  assert.match(price.cannotRepresent, /one offering is priced or quoted is a business fact/);
  console.log('PASS config_capabilities_quote_rules');
}

/** Unsupported/ambiguous config requests cannot change the draft, whatever the field. */
function testEnforceConfigRequests() {
  const prev = {
    tone: 'warm',
    responseLength: null,
    priceDisclosure: 'on_request',
    openingMessage: null,
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

/**
 * Production log shape: confirm a price → saved immediately → customer prompt
 * sees it → Q&A view is current (no pending) → non-question turns show the menu.
 */
async function testTranscriptShapedImmediateSave() {
  clean();
  const live = emptyProfile();
  live.name = 'BurgerBarber';
  live.whatWeDo = 'Barbershop';
  live.services = [{ name: "Men's haircut", price: null, notes: null }];
  live.informationToCollect = ['name', 'phone'];
  live.commonQuestions = [];
  live.approvedAt = '2026-01-01T00:00:00.000Z';
  live.draft = {
    ...liveDraftWith(live, {
      name: live.name,
      whatWeDo: live.whatWeDo,
      services: live.services,
      commonQuestions: [],
      informationToCollect: live.informationToCollect,
    }),
  };
  saveProfile(live, PROFILE);

  const savedDraft = liveDraftWith(live, {
    services: [{ name: "Men's haircut", price: '100 shekel per haircut', notes: null }],
    commonQuestions: [
      {
        question: 'How much does a haircut cost?',
        answer: "It's 100 shekel per haircut.",
      },
    ],
  });

  const session = makeSession(
    queuedTurns([
      {
        message: 'Thanks for confirming the haircut costs 100 shekel per haircut.',
        draft: savedDraft,
        readyForReview: true,
      },
      {
        message: 'The haircut price and FAQ answer are approved.',
        draft: savedDraft,
        readyForReview: false,
        asksQuestion: false,
      },
      {
        message:
          'Your BurgerBarber bot has the approved haircut price and FAQ. What would you like to do next—try the bot, make another change, or get the bot ready for your business?',
        draft: savedDraft,
        readyForReview: false,
        asksQuestion: true,
      },
    ])
  );
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  session.leadIntake = { submittedAt: '2026-01-01T00:00:00.000Z' };

  const yes = await handleMessage(session, 'Yes');
  assert.match(yes.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  assert.match(yes.reply, /100 shekel per haircut/);
  assert.doesNotMatch(yes.reply, /Pending change|will change/);
  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '100 shekel per haircut');
  assert.equal(disk.commonQuestions[0].answer, "It's 100 shekel per haircut.");
  assert.match(buildCustomerSystemPrompt(disk), /100 shekel per haircut/);

  const menu = await handleMessage(session, '2');
  assert.equal(menu.event, 'menu');
  const qa = await handleMessage(session, '2');
  assert.equal(qa.event, 'menu_section');
  assert.match(qa.reply, /It's 100 shekel per haircut/);
  assert.doesNotMatch(qa.reply, /Pending change|Live now:/);
  assert.match(qa.reply, /Here's what I have:/);

  const approve = await handleMessage(session, 'Approve');
  assert.equal(approve.event, 'build_turn');
  assert.match(approve.reply, /1\. 🏪 Tell me more about your business/);
  assert.doesNotMatch(approve.reply, /Pending change/);

  const nowWhat = await handleMessage(session, 'Now what');
  assert.match(nowWhat.reply, /1\. 🏪 Tell me more about your business/);
  assert.doesNotMatch(nowWhat.reply, /Pending change/);
  console.log('PASS transcript_shaped_immediate_save');
}

async function main() {
  testConfigCapabilitiesQuoteRules();
  testEnforceConfigRequests();
  testIntakeGateAsksOneQuestion();
  testRequiredTopicsGate();
  testGoalSupport();
  testHasEnoughForFirstBotRequiresName();
  await testTranscriptShapedImmediateSave();
  await testFormatSummaryIncludesOwnerGoal();
  await testDraftEditLeavesLiveUnchanged();
  await testReapproveUpdatesLiveBot();
  await testIntakeGateBlocksApprove();
  await testNullOwnerGoalDoesNotWipeLive();
  await testBehaviorDraftIsolatesLivePrompt();
  await testBehaviorApprovePropagatesToLivePrompt();
  await testLegacyProfileSafeDefaults();
  await testStyleOnlyEditPreservesPriceDisclosure();
  await testBehaviorOnlyMergePreservesFacts();
  await testApproveRequiresPresentedReview();
  await testEditAfterReviewRequiresNewReview();
  await testTypedApproveIsBuilderTurn();
  await testIdentityDraftIsolatesLive();
  await testIdentityApprovePropagates();
  await testOtherFactsApprovePropagates();
  await testOpeningOnlyEditPreservesName();
  await testIdentityResetRestoresDefault();
  await testLegacyIdentityDefaults();
  clean();
  console.log('\nAll approval-boundary tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
