/**
 * delete-demo.js: unclaimed, claimed refuse, claimed+flag, assets, dry-run.
 * Deterministic. No network.
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DELETE_COUNT_KEYS,
  deleteDemo,
  formatDeletePlan,
  parseArgs,
} from './delete-demo.js';
import { createMemoryStore } from '../src/store/memoryStore.js';

const PHONE = '+15125550100';
const SENDER = `whatsapp:${PHONE}`;
const OTHER = 'whatsapp:+15125550999';
const CODE = 'ABCD2345';
const APPROVED_AT = '2026-10-28T00:00:00.000Z';
const PROSPECT_ID = 'fake-harbor';

function demoProfile() {
  return {
    name: 'Harbor Cuts',
    whatWeDo: 'Barbershop',
    services: [{ name: 'Haircut', price: '$30', notes: null }],
    hours: 'Mon–Fri 9–17',
    locationOrArea: 'Austin',
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    otherFacts: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    approvedAt: APPROVED_AT,
    firstTestedAt: null,
    draft: {
      name: 'Harbor Cuts',
      whatWeDo: 'Barbershop',
      services: [{ name: 'Haircut', price: '$30', notes: null }],
      hours: 'Mon–Fri 9–17',
      locationOrArea: 'Austin',
      askedTopics: ['businessDetails'],
    },
  };
}

function demoRow(overrides = {}) {
  return {
    business_label: 'Harbor Cuts',
    prospect_id: PROSPECT_ID,
    business_phone: PHONE,
    code: CODE,
    profile: demoProfile(),
    source_url: 'https://harborcuts.example',
    reviewed_at: APPROVED_AT,
    expires_at: '2027-01-01T00:00:00.000Z',
    claimed_by: null,
    claimed_at: null,
    ...overrides,
  };
}

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delete-demo-'));
}

function seedAssets(cwd, prospectId = PROSPECT_ID) {
  const dir = path.join(cwd, 'demo-output', prospectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note.txt'), 'local artifact');
  return dir;
}

async function seedClaimedSender(store, senderId = SENDER) {
  await store.ensureSender(senderId);
  await store.saveLead(senderId, {
    businessName: 'Harbor Cuts',
    answers: { contactConsent: 'Yes, sure' },
    createdAt: APPROVED_AT,
  });
  await store.enqueueInbound({
    messageSid: 'SM-demo-del-1',
    senderId,
    body: 'hi from the shop',
  });
  await store.appendMessage({
    senderId,
    direction: 'outbound',
    body: 'Welcome',
    twilioMessageSid: 'SM-demo-del-out',
    mode: 'TEST',
    inReplyToSid: 'SM-demo-del-1',
  });
}

function snapshot(store) {
  return JSON.stringify(store._dump());
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('=== delete-demo (deterministic) ===\n');

{
  const args = parseArgs(['--id', PROSPECT_ID, '--dry-run']);
  assert.equal(args.id, PROSPECT_ID);
  assert.equal(args.dryRun, true);
  assert.equal(args.yes, false);
  assert.equal(args.includeClaimed, false);
  const claimed = parseArgs(['--code', CODE, '--yes', '--include-claimed']);
  assert.equal(claimed.code, CODE);
  assert.equal(claimed.yes, true);
  assert.equal(claimed.includeClaimed, true);
  const byPhone = parseArgs(['--phone', PHONE]);
  assert.equal(byPhone.phone, PHONE);
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--id', PROSPECT_ID, '--code', CODE]));
  assert.throws(() => parseArgs(['--dry-run']));
  ok('parseArgs: --id/--code/--phone, --dry-run, --include-claimed; one lookup key');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const cwd = makeTmp();
  const assetDir = seedAssets(cwd);
  const logs = [];
  const result = await deleteDemo(
    { id: PROSPECT_ID, yes: true },
    { store, cwd, log: (m) => logs.push(m), confirmDelete: async () => true }
  );
  assert.equal(result.deleted, true);
  assert.equal(result.plan.counts.easybot_demo_profiles, 1);
  assert.equal(Object.values(store._dump().demos).length, 0);
  assert.equal(fs.existsSync(assetDir), false);
  assert.match(logs.join('\n'), /easybot_demo_profiles: 1/);
  fs.rmSync(cwd, { recursive: true, force: true });
  ok('unclaimed delete removes the demo row and demo-output/<id>/');
}

{
  const store = createMemoryStore();
  await store.insertDemo(
    demoRow({ claimed_by: SENDER, claimed_at: APPROVED_AT })
  );
  await seedClaimedSender(store);
  const cwd = makeTmp();
  seedAssets(cwd);
  const warns = [];
  const before = snapshot(store);
  const result = await deleteDemo(
    { id: PROSPECT_ID, yes: true },
    {
      store,
      cwd,
      log: () => {},
      warn: (m) => warns.push(m),
      confirmDelete: async () => true,
    }
  );
  assert.equal(result.deleted, false);
  assert.equal(result.refused, true);
  assert.equal(snapshot(store), before);
  assert.equal(fs.existsSync(path.join(cwd, 'demo-output', PROSPECT_ID)), true);
  assert.match(warns.join('\n'), /--include-claimed/);
  fs.rmSync(cwd, { recursive: true, force: true });
  ok('claimed without --include-claimed refuses and leaves data');
}

{
  const store = createMemoryStore();
  await store.insertDemo(
    demoRow({ claimed_by: SENDER, claimed_at: APPROVED_AT })
  );
  await seedClaimedSender(store);
  await store.ensureSender(OTHER);
  const cwd = makeTmp();
  const assetDir = seedAssets(cwd);
  const result = await deleteDemo(
    { code: CODE, yes: true, includeClaimed: true },
    { store, cwd, log: () => {}, confirmDelete: async () => true }
  );
  assert.equal(result.deleted, true);
  const dump = store._dump();
  assert.equal(Object.values(dump.demos).length, 0);
  assert.equal(dump.senders[SENDER], undefined);
  assert.equal(dump.profiles[SENDER], undefined);
  assert.equal(dump.sessions[SENDER], undefined);
  assert.equal(dump.leads[SENDER], undefined);
  assert.equal(dump.messages.filter((m) => m.sender_id === SENDER).length, 0);
  assert.equal(dump.inbound.filter((r) => r.sender_id === SENDER).length, 0);
  assert.ok(dump.senders[OTHER]);
  assert.equal(fs.existsSync(assetDir), false);
  assert.equal(result.plan.counts.easybot_demo_profiles, 1);
  assert.equal(result.plan.counts.easybot_senders, 1);
  assert.equal(result.plan.counts.easybot_business_profiles, 1);
  assert.equal(result.plan.counts.easybot_sessions, 1);
  assert.equal(result.plan.counts.easybot_leads, 1);
  assert.ok(result.plan.counts.easybot_messages >= 1);
  assert.ok(result.plan.counts.easybot_inbound_messages >= 1);
  fs.rmSync(cwd, { recursive: true, force: true });
  ok('claimed + --include-claimed removes sender data and leaves other senders');
}

{
  const store = createMemoryStore();
  await store.insertDemo(
    demoRow({ claimed_by: SENDER, claimed_at: APPROVED_AT })
  );
  await seedClaimedSender(store);
  const cwd = makeTmp();
  const assetDir = seedAssets(cwd);
  const logs = [];
  const before = snapshot(store);
  const result = await deleteDemo(
    { id: PROSPECT_ID, dryRun: true, includeClaimed: true, yes: true },
    {
      store,
      cwd,
      log: (m) => logs.push(String(m)),
      confirmDelete: async () => {
        throw new Error('dry-run must not confirm');
      },
    }
  );
  assert.equal(result.dryRun, true);
  assert.equal(result.deleted, false);
  assert.equal(snapshot(store), before);
  assert.equal(fs.existsSync(assetDir), true);
  assert.equal(fs.readFileSync(path.join(assetDir, 'note.txt'), 'utf8'), 'local artifact');
  const printed = logs.join('\n');
  assert.match(printed, /Would delete:/);
  for (const key of DELETE_COUNT_KEYS) {
    assert.match(printed, new RegExp(`${key}: \\d+`));
  }
  assert.match(printed, /easybot_demo_profiles: 1/);
  assert.match(printed, /easybot_senders: 1/);
  assert.match(printed, /easybot_messages: [1-9]/);
  assert.equal(printed.includes(assetDir), true);
  assert.match(printed, /Dry run\. Nothing deleted\./);
  const dump = store._dump();
  assert.equal(Object.values(dump.demos)[0].claimed_by, SENDER);
  assert.ok(dump.senders[SENDER]);
  assert.ok(dump.leads[SENDER]);
  fs.rmSync(cwd, { recursive: true, force: true });
  ok('dry-run prints counts and paths and leaves everything intact');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow({ code: 'GONECODE' }));
  await deleteDemo(
    { code: 'GONECODE', yes: true },
    { store, log: () => {}, confirmDelete: async () => true }
  );
  const logs = [];
  const result = await deleteDemo(
    { code: 'GONECODE', yes: true },
    { store, log: (m) => logs.push(String(m)), confirmDelete: async () => true }
  );
  assert.equal(result.found, false);
  assert.equal(result.deleted, false);
  assert.match(logs.join('\n'), /No demo found/);
  ok('second delete on a missing demo is a no-op');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow({ prospect_id: 'by-phone' }));
  const result = await deleteDemo(
    { phone: '+1 (512) 555-0100', yes: true },
    { store, log: () => {}, confirmDelete: async () => true }
  );
  assert.equal(result.deleted, true);
  assert.equal(Object.values(store._dump().demos).length, 0);
  ok('lookup by phone normalizes E.164');
}

{
  const plan = {
    counts: {
      easybot_demo_profiles: 1,
      easybot_senders: 0,
      easybot_business_profiles: 0,
      easybot_sessions: 0,
      easybot_messages: 0,
      easybot_inbound_messages: 0,
      easybot_leads: 0,
    },
    assetPaths: [],
  };
  const text = formatDeletePlan(plan);
  assert.match(text, /Local assets:\n  \(none\)/);
  ok('formatDeletePlan lists every table and empty assets');
}

console.log(`\n${passed} passed`);
