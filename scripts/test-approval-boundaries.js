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
  reconcileDraft,
} from '../src/builder.js';
import { withSingleQuestion } from '../src/composeReply.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import { createSession, handleMessage as runMessage } from '../src/session.js';
import { topicByKey } from '../src/builderTopics.js';
import { renderSection } from '../src/ownerNav.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = testProfilePath('approval-boundaries');

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function baseApprovedLive() {
  const p = emptyProfile();
  p.name = 'Sunny Yoga';
  p.whatWeDo = 'Private yoga lessons';
  p.services = [{ name: 'Private lesson', price: '$70 / 60 min', notes: null }];
  p.hours = 'Mon–Fri 9–5';
  p.locationOrArea = 'Austin';
  p.commonQuestions = [];
  p.informationToCollect = [];
  p.unknowns = [];
  p.tone = 'friendly';
  p.priceDisclosure = null;
  p.approvedAt = '2026-01-01T00:00:00.000Z';
  p.draft = {
    name: p.name,
    whatWeDo: p.whatWeDo,
    services: p.services,
    hours: p.hours,
    locationOrArea: p.locationOrArea,
    commonQuestions: p.commonQuestions,
    informationToCollect: p.informationToCollect,
    unknowns: p.unknowns,
    tone: p.tone,
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
    services: live.services,
    hours: live.hours,
    locationOrArea: live.locationOrArea,
    commonQuestions: [],
    informationToCollect: [],
    unknowns: [],
    tone: live.tone,
    priceDisclosure: null,
    askedTopics: ['commonQuestions', 'informationToCollect'],
    ...overrides,
  };
}

/** A draft change is live on that turn; typed "approve" is just another Builder turn. */
async function testEditSavesImmediatelyTypedApproveIsBuilderTurn() {
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
  assert.match(r0.reply, /Here's what changed:/);
  assert.match(r0.reply, /\*Services & prices:\* Private lesson — \$80 \/ 60 min/);
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
  assert.match(r1.reply, /Here's what changed:/);
  assert.equal(loadProfile(PROFILE).services[0].price, '$80 / 60 min');

  const r2 = await handleMessage(session, 'Actually make it $90.');
  assert.match(r2.reply, /Here's what changed:[\s\S]*\$90 \/ 60 min/);
  assert.equal(loadProfile(PROFILE).services[0].price, '$90 / 60 min');
  console.log('PASS successive_edits_save_immediately');
}

/** A draft edit is saved to the live profile on that turn (no pending approval). */
async function testDraftEditSavesLive() {
  clean();
  saveProfile(baseApprovedLive(), PROFILE);
  const liveMock = { approvals: [] };
  const pendingServices = [
    { name: 'Private lesson', price: '$80 / 60 min', notes: null },
  ];

  const session = makeSession(async () => ({
    message: 'Updated the draft price — approve when ready.',
    draft: {
      name: 'Sunny Yoga',
      whatWeDo: 'Private yoga lessons',
      services: pendingServices,
      hours: 'Mon–Fri 9–5',
      locationOrArea: 'Austin',
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'friendly',
      priceDisclosure: null,
    },
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);

  const r = await handleMessage(session, 'Change private lessons to $80.');
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');

  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '$80 / 60 min');
  assert.ok(disk.approvedAt);
  assert.match(r.reply, /Here's what changed:/);
  const summary = formatSummary(disk);
  assert.doesNotMatch(summary, /Pending \(not live until you approve\)/);
  assert.match(summary, /\$80 \/ 60 min/);
  assert.doesNotMatch(summary, /Bot goal:/);
  console.log('PASS draft_edit_saves_live');
}

/** Applying a change writes the live bot immediately (no re-approve step). */
async function testEditUpdatesLiveBotImmediately() {
  clean();
  saveProfile(baseApprovedLive(), PROFILE);
  const liveMock = { approvals: [] };
  const newServices = [
    { name: 'Private lesson', price: '$80 / 60 min', notes: null },
  ];
  const session = makeSession(async () => ({
    message: 'Approved updates applied.',
    draft: {
      name: 'Sunny Yoga',
      whatWeDo: 'Private yoga lessons',
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
  assert.match(r.reply, /Here's what changed:/);

  const sent = loadProfile(PROFILE);
  assert.equal(sent.services[0].price, '$80 / 60 min');

  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '$80 / 60 min');
  assert.ok(disk.approvedAt);
  console.log('PASS edit_updates_live_bot_immediately');
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

async function testApprovedAtRequiresPresentReview() {
  clean();
  saveProfile(emptyProfile(), PROFILE);
  const nameWhat = {
    name: 'Cafe',
    whatWeDo: 'Coffee shop',
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    tone: 'warm',
  };

  const session = makeSession(async () => ({
    message: 'Cafe is a coffee shop ✨',
    draft: nameWhat,
    ownerName: 'Ada',
    source: 'stub-builder',
  }));

  const r = await handleMessage(session, 'I run Cafe, a coffee shop');
  assert.equal(r.ok, true);
  assert.ok(!r.approved);
  assert.equal(r.event, 'build_turn');
  assert.match(r.reply, /Tell me a bit more about Cafe/);
  assert.match(r.reply, /skip/i);
  const afterAsk = loadProfile(PROFILE);
  assert.equal(afterAsk.name, 'Cafe');
  assert.equal(
    afterAsk.approvedAt,
    null,
    'askedTopics including businessDetails is not enough — presentReview is the gate'
  );
  assert.deepEqual(afterAsk.draft.askedTopics, ['businessDetails']);
  assert.equal(
    afterAsk.informationToCollect,
    null,
    'informationToCollect stays null until the owner sets it'
  );

  session.deps.runBuilderTurn = async () => ({
    message: 'Got it, thanks!',
    draft: nameWhat,
    topicResponse: 'skipped',
    source: 'stub-builder',
  });
  const r2 = await handleMessage(session, 'skip');
  assert.match(r2.reply, /I'm ready for a first try, Ada!/);
  const afterSkip = loadProfile(PROFILE);
  assert.ok(afterSkip.approvedAt, 'skip of tell-me-more presents review and writes approvedAt');
  assert.equal(afterSkip.informationToCollect, null);

  clean();
  saveProfile(emptyProfile(), PROFILE);
  const dump = {
    name: 'Harbor',
    whatWeDo: 'Cafe',
    services: [{ name: 'Latte', price: '$4', notes: null }],
    hours: '7–3',
    locationOrArea: 'Downtown',
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
  };
  const dumpSession = makeSession(async () => ({
    message: 'Got everything.',
    draft: dump,
    ownerName: 'Ada',
    source: 'stub-builder',
  }));
  const r3 = await handleMessage(dumpSession, 'Harbor cafe downtown, latte $4, 7-3');
  assert.match(r3.reply, /I'm ready for a first try, Ada!/);
  assert.ok(loadProfile(PROFILE).approvedAt, 'dump-ahead presents review and writes approvedAt');
  assert.equal(loadProfile(PROFILE).informationToCollect, null);
  console.log('PASS approved_at_requires_present_review');
}

function testRequiredTopicsGate() {
  const nameWhat = {
    name: 'Waser',
    whatWeDo: 'Math tutoring',
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
  };
  const dump = {
    ...nameWhat,
    services: [{ name: 'Lesson', price: '$80 per hour', notes: null }],
    hours: 'Mon–Fri 9–17',
    locationOrArea: 'Tel Aviv',
  };
  const topic = topicByKey('businessDetails');
  const tellMore = topic.questionFor(nameWhat);

  // First tell-me-more ask: presentReview false; askedTopics records the ask.
  const a = applyReviewGate(
    emptyProfile(),
    { message: 'Waser is a tutoring shop ✨', draft: nameWhat },
    'we tutor math',
    { ownerName: 'Ada' }
  );
  assert.equal(a.presentReview, false);
  assert.deepEqual(a.draft.askedTopics, ['businessDetails']);
  assert.equal(a.message, `Nice, thanks Ada! ✨\n\n${tellMore}`);

  // Dump-ahead: all details present → presentReview without asking.
  const dumped = applyReviewGate(
    emptyProfile(),
    { message: 'Got it, thanks!', draft: dump },
    'full dump',
    { ownerName: 'Ada' }
  );
  assert.equal(dumped.presentReview, true);
  assert.doesNotMatch(dumped.message, /Tell me a bit more/);

  // Skip after the ask → presentReview true.
  const skipped = applyReviewGate(
    { ...emptyProfile(), draft: a.draft },
    { message: 'Got it, thanks!', draft: nameWhat, topicResponse: 'skipped' },
    'skip',
    { justAsked: topic, ownerName: 'Ada' }
  );
  assert.equal(skipped.presentReview, true);

  // Completing tell-me-more with all details → presentReview.
  const complete = applyReviewGate(
    { ...emptyProfile(), draft: a.draft },
    {
      message: 'Hours and location too.',
      draft: dump,
      topicResponse: 'answered',
    },
    'hours and location',
    { justAsked: topic, ownerName: 'Ada' }
  );
  assert.equal(complete.presentReview, true);

  // Before name + offering, a model question is left alone.
  const before = applyReviewGate(
    emptyProfile(),
    {
      message: 'Per hour?',
      draft: { ...nameWhat, name: null, whatWeDo: null },
    },
    'hi',
    { ownerName: 'Ada' }
  );
  assert.equal(before.message, 'Per hour?');
  assert.equal(before.presentReview, false);

  // Approved profiles skip setup topics (edits are not blocked).
  const live = { ...emptyProfile(), ...dump, approvedAt: '2026-01-01T00:00:00Z' };
  const e = applyReviewGate(
    live,
    { message: 'Warmer.', draft: { ...dump, tone: 'warm' } },
    'warmer'
  );
  assert.equal(e.presentReview, true);
  console.log('PASS required_topics_gate');
}

/** Case B: pending behavior settings must not affect the live prompt. */
async function testBehaviorDraftIsolatesLivePrompt() {
  clean();
  const live = baseApprovedLive();
  live.tone = 'friendly';
  live.priceDisclosure = null;
  saveProfile(live, PROFILE);
  const liveMock = { approvals: [] };
  const approvedAtBefore = live.approvedAt;

  const session = makeSession(async () => ({
    message: 'Updated style and price disclosure — approve when ready.',
    draft: {
      name: live.name,
      whatWeDo: live.whatWeDo,
      services: live.services,
      hours: live.hours,
      locationOrArea: live.locationOrArea,
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'warm and short',
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
  assert.equal(disk.tone, 'warm and short');
  assert.equal(disk.approvedAt, approvedAtBefore);

  const livePrompt = buildCustomerSystemPrompt(disk);
  assert.match(livePrompt, /on request only/i);
  const summary = formatSummary(disk);
  assert.doesNotMatch(summary, /Pending \(not live until you approve\)/);
  assert.match(summary, /I share prices only when a customer asks/);
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
      services: live.services,
      hours: live.hours,
      locationOrArea: live.locationOrArea,
      commonQuestions: live.commonQuestions,
      informationToCollect: live.informationToCollect,
      unknowns: live.unknowns,
      tone: 'warm and short',
      priceDisclosure: live.priceDisclosure,
    },
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);

  const r = await applyChange(session);
  assert.equal(r.ok, true);
  assert.equal(r.event, 'build_turn');

  const sent = loadProfile(PROFILE);
  assert.equal(sent.tone, 'warm and short');
  assert.equal(
    JSON.stringify(businessFactsView(sent)),
    factsBefore,
    'business facts must be unchanged on style approve'
  );

  const sys = buildCustomerSystemPrompt(sent);
  assert.match(sys, /Tone: warm and short/);
  assert.doesNotMatch(sys, /Reply length:/);

  const disk = loadProfile(PROFILE);
  assert.equal(disk.tone, 'warm and short');
  console.log('PASS behavior_approve_propagates_to_live_prompt');
}

/** Case I: legacy profile without new keys loads with safe defaults. */
async function testLegacyProfileSafeDefaults() {
  clean();
  const legacy = {
    name: 'Quiet Mat Yoga',
    whatWeDo: 'In-person private yoga lessons',
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
  // Write raw JSON without priceDisclosure key
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  fs.writeFileSync(PROFILE, JSON.stringify(legacy, null, 2), 'utf8');

  const disk = loadProfile(PROFILE);
  assert.equal(Object.hasOwn(disk, 'retiredField'), false, 'unknown keys dropped on load');
  assert.equal(Object.hasOwn(disk, 'responseLength'), false, 'retired responseLength dropped on load');
  assert.equal(disk.tone, 'warm and calm');
  assert.equal(disk.priceDisclosure, null);
  const eff = effectiveBehavior(disk);
  assert.equal(eff.priceDisclosure, DEFAULT_BEHAVIOR.priceDisclosure);
  assert.equal(eff.tone, 'warm and calm');

  const prompt = buildCustomerSystemPrompt(disk);
  assert.match(prompt, /Tone: warm and calm/);
  assert.match(prompt, /Price disclosure: relevant/);
  assert.doesNotMatch(prompt, /Reply length:/);

  const summary = formatSummary(disk);
  assert.match(summary, /Tone: warm and calm/);
  assert.match(summary, /Price policy: I mention prices when they're relevant/);
  console.log('PASS legacy_profile_safe_defaults');
}

/** Case J: style-only draft must not reset approved priceDisclosure. */
async function testStyleOnlyEditPreservesPriceDisclosure() {
  clean();
  const live = baseApprovedLive();
  live.priceDisclosure = 'on_request';
  live.tone = 'warm and short';
  live.draft = {
    ...live.draft,
    priceDisclosure: 'on_request',
    tone: 'warm and short',
  };
  const factsBefore = JSON.stringify(businessFactsView(live));
  saveProfile(live, PROFILE);

  // Unit: reconcileDraft preserves priceDisclosure when omitted/nulled
  const reconciled = reconcileDraft(
    {
      name: live.name,
      whatWeDo: live.whatWeDo,
      services: live.services,
      hours: live.hours,
      locationOrArea: live.locationOrArea,
      commonQuestions: [],
      informationToCollect: [],
      unknowns: [],
      tone: 'a bit friendlier',
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
    priceDisclosure: 'relevant',
  });
  assert.equal(JSON.stringify(businessFactsView(merged)), before);
  assert.equal(merged.tone, 'professional and concise');
  assert.equal(merged.priceDisclosure, 'relevant');
  assert.equal(
    draftDiffersFromLive(live, {
      tone: 'professional and concise',
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
    services: live.services,
    hours: live.hours,
    locationOrArea: live.locationOrArea,
    commonQuestions: live.commonQuestions,
    informationToCollect: live.informationToCollect,
    unknowns: live.unknowns,
    tone: live.tone,
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
  assert.match(r.reply, /Here's what changed:/, 'settings-only edit is presented as a save card');
  assert.match(r.reply, /Here's what changed:\n\*How I talk:\* friendly, custom opening/);
  assert.doesNotMatch(r.reply, /\(was:/);
  assert.match(r.reply, /2\. 🏪 Tell me more about your business/);
  assert.match(r.reply, /📝 Choose details to collect from customers/);
  assert.match(r.reply, /🤖 Chat with me like a customer/);
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
    ownerName: 'Ada',
    readyForReview: true,
    source: 'stub-builder',
  }), liveMock);

  const review = await handleMessage(session, 'Please apply this change.');
  assert.match(review.reply, /I'm ready for a first try, Ada!/);
  assert.doesNotMatch(review.reply, /Other facts/, 'first-ready menu does not list otherFacts');
  const section = renderSection(1, loadProfile(PROFILE));
  assert.ok(!section.includes('Other facts'), 'section 1 no longer lists otherFacts');
  assert.ok(section.includes('*Price policy:*'), section);

  const r = await handleMessage(session, 'chat with me like a customer');
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
  assert.match(r1.reply, /Here's what changed:/);

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
        configRequests: [
          {
            request: 'Put the price in every reply.',
            status: 'unsupported',
            field: 'priceDisclosure',
            alternative: 'relevant',
          },
        ],
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
  assert.match(rYes.reply, /Here's what changed:/);
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
    { ...prev, openingMessage: 'Hi there', tone: 'warm, emoji in every message' },
    prev,
    [
      { request: 'custom opening', status: 'supported', field: 'openingMessage' },
      { request: 'emoji in every message', status: 'unsupported', field: 'tone' },
    ]
  );
  assert.equal(c.draft.openingMessage, 'Hi there');
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
  assert.match(yes.reply, /Here's what changed:/);
  assert.match(yes.reply, /100 shekel per haircut/);
  assert.doesNotMatch(yes.reply, /Pending change|will change/);
  const disk = loadProfile(PROFILE);
  assert.equal(disk.services[0].price, '100 shekel per haircut');
  assert.equal(disk.commonQuestions[0].answer, "It's 100 shekel per haircut.");
  assert.match(buildCustomerSystemPrompt(disk), /100 shekel per haircut/);

  const qa = await handleMessage(session, '3');
  assert.equal(qa.event, 'menu_section');
  assert.match(qa.reply, /It's 100 shekel per haircut/);
  assert.doesNotMatch(qa.reply, /Pending change|Live now:/);
  assert.match(qa.reply, /These are the questions I know how to answer:/);

  const approve = await handleMessage(session, 'Approve');
  assert.equal(approve.event, 'build_turn');
  assert.match(approve.reply, /2\. 🏪 Tell me more about your business/);
  assert.doesNotMatch(approve.reply, /Pending change/);

  const nowWhat = await handleMessage(session, 'Now what');
  assert.match(nowWhat.reply, /2\. 🏪 Tell me more about your business/);
  assert.doesNotMatch(nowWhat.reply, /Pending change/);
  console.log('PASS transcript_shaped_immediate_save');
}

async function main() {
  testConfigCapabilitiesQuoteRules();
  testEnforceConfigRequests();
  testIntakeGateAsksOneQuestion();
  testRequiredTopicsGate();
  testHasEnoughForFirstBotRequiresName();
  await testTranscriptShapedImmediateSave();
  await testDraftEditSavesLive();
  await testEditUpdatesLiveBotImmediately();
  await testApprovedAtRequiresPresentReview();
  await testBehaviorDraftIsolatesLivePrompt();
  await testBehaviorApprovePropagatesToLivePrompt();
  await testLegacyProfileSafeDefaults();
  await testStyleOnlyEditPreservesPriceDisclosure();
  await testBehaviorOnlyMergePreservesFacts();
  await testEditSavesImmediatelyTypedApproveIsBuilderTurn();
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
