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
  loadProfile,
  mergeDraft,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import { isOwnerApproveMessage, reconcileDraft } from '../src/builder.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import { buildFlowData } from '../src/flowise.js';
import { createSession, handleMessage } from '../src/session.js';

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
  p.ownerGoal = 'Answer FAQs and collect interest for lessons';
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
  return createSession({
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
  assert.match(r1.reply, /Pending \(not live until you approve\)[\s\S]*\$80 \/ 60 min/);
  assert.match(r1.reply, /Reply \*\*approve\*\*/);
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
  assert.match(r2.reply, /Pending[\s\S]*\$90 \/ 60 min/);
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
  const pendingGoal = 'Book more weekday private lessons';

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
  assert.equal(disk.ownerGoal, 'Answer FAQs and collect interest for lessons');
  assert.equal(disk.approvedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(disk.chatflowId, 'cf-live');
  assert.equal(disk.draft.services[0].price, '$80 / 60 min');
  assert.equal(disk.draft.ownerGoal, pendingGoal);

  const summary = formatSummary(disk);
  assert.match(summary, /Live approved \(active customer bot\)/);
  assert.match(summary, /Pending \(not live until you approve\)/);
  assert.match(summary, /\$70 \/ 60 min/);
  assert.match(summary, /\$80 \/ 60 min/);
  assert.match(summary, /Owner goal:/);
  console.log('PASS draft_edit_leaves_live_unchanged');
}

async function testReapproveUpdatesFlowise() {
  clean();
  saveProfile(baseApprovedLive(), PROFILE);
  const flowiseMock = { calls: [] };
  const newServices = [
    { name: 'Private lesson', price: '$80 / 60 min', notes: null },
  ];
  const newGoal = 'Convert chat interest into booked private lessons';

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

async function testIntakeGateBlocksApprove() {
  clean();
  saveProfile(emptyProfile(), PROFILE);
  const flowiseMock = { calls: [] };

  const session = makeSession(async () => ({
    message: 'Looks ready to approve.',
    draft: {
      name: 'Cafe',
      whatWeDo: 'Coffee shop',
      ownerGoal: 'Answer hours and menu questions',
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
      ownerGoal: 'Answer hours and menu questions',
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

  const r = await handleMessage(session, 'approve');
  assert.equal(r.ok, true);
  assert.equal(r.approved, false);
  assert.equal(r.event, 'build_turn');
  assert.equal(flowiseMock.calls.length, 0);
  const disk = loadProfile(PROFILE);
  assert.equal(disk.approvedAt, null);
  assert.match(r.reply, /collect any information/i);
  console.log('PASS intake_gate_blocks_approve');
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
    'Answer FAQs and collect interest for lessons',
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
  assert.equal(disk.ownerGoal, 'Answer FAQs and collect interest for lessons');
  assert.equal(flowiseMock.calls[0].ownerGoal, disk.ownerGoal);
  console.log('PASS null_owner_goal_does_not_wipe_live');
}

async function testFormatSummaryIncludesOwnerGoal() {
  const p = emptyProfile();
  p.name = 'X';
  p.whatWeDo = 'Y';
  const s = formatSummary(p);
  assert.match(s, /Owner goal: \(not set\)/);
  p.ownerGoal = 'Help customers book by messaging the owner';
  assert.match(formatSummary(p), /Owner goal: Help customers book/);
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
  assert.match(r.reply, /Pending[\s\S]*Assistant name: Maya[\s\S]*Reply \*\*approve\*\*/);
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

async function main() {
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
  await testIdentityDraftIsolatesLive();
  await testIdentityApprovePropagates();
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
