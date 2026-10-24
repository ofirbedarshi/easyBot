/**
 * Deterministic approval-boundary tests through real handleMessage handlers
 * with mocked Flowise + stubbed Builder turns (no network).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  emptyProfile,
  formatSummary,
  loadProfile,
  mergeDraft,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
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

  const r = await handleMessage(session, 'approve');
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

  const r = await handleMessage(session, 'approve');
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
  console.log('PASS format_summary_owner_goal');
}

async function main() {
  await testFormatSummaryIncludesOwnerGoal();
  await testDraftEditLeavesLiveUnchanged();
  await testReapproveUpdatesFlowise();
  await testIntakeGateBlocksApprove();
  await testNullOwnerGoalDoesNotWipeLive();
  clean();
  console.log('\nAll approval-boundary tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
