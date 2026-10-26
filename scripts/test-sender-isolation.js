/**
 * Deterministic multi-sender isolation + conversation log (no network).
 * Run: node scripts/test-sender-isolation.js  (also part of npm test)
 */
import assert from 'assert';
import twilio from 'twilio';
import express from 'express';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { createTwilioWhatsAppRouter } from '../src/twilio/webhook.js';
import { startInboundWorker } from '../src/twilio/worker.js';
import {
  createSenderSession,
  handleMessage,
  persistSenderSession,
} from '../src/session.js';
import { emptyProfile } from '../src/profile.js';
import { phoneE164FromSenderId } from '../src/phone.js';
import { BUSINESS_BOT_STORED_MESSAGES } from '../src/businessBot.js';

const AUTH = 'test_auth_token_for_isolation_suite';
const BASE = 'https://demo.example.com';
const PATH = '/webhooks/twilio/whatsapp';
const FULL_URL = `${BASE}${PATH}`;

process.env.TWILIO_AUTH_TOKEN = AUTH;
process.env.PUBLIC_BASE_URL = BASE;
process.env.TWILIO_SKIP_OUTBOUND = '1';
// This suite sends bursts to test history caps, not rate limits.
process.env.DEMO_MAX_MSGS_PER_SENDER_PER_BURST = '100';

function sign(params) {
  return twilio.getExpectedTwilioSignature(AUTH, FULL_URL, params);
}

async function withServer(store, fn) {
  const app = express();
  app.use('/webhooks/twilio', createTwilioWhatsAppRouter(store));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address();
  try {
    await fn({ port, base: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function postWebhook(base, params, headers = {}) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${base}${PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function drain(store, worker, maxTicks = 80) {
  for (let i = 0; i < maxTicks; i++) {
    await worker.tick();
    const dump = store._dump();
    const pending = dump.inbound.filter((r) =>
      ['received', 'processing'].includes(r.status)
    );
    if (pending.length === 0) return dump;
    await sleep(15);
  }
  return store._dump();
}

function mk(sid, from, body) {
  return {
    MessageSid: sid,
    AccountSid: 'ACtest',
    From: from,
    To: 'whatsapp:+15550000',
    Body: body,
    NumMedia: '0',
  };
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('=== sender isolation + conversation log (mocked) ===\n');

{
  assert.equal(phoneE164FromSenderId('whatsapp:+15551234567'), '+15551234567');
  assert.equal(phoneE164FromSenderId('+15551234567'), '+15551234567');
  assert.equal(phoneE164FromSenderId('whatsapp:not-a-phone'), null);
  assert.equal(phoneE164FromSenderId(''), null);
  ok('phoneE164FromSenderId parses WhatsApp From');
}

{
  const store = createMemoryStore();
  await withServer(store, async ({ base }) => {
    const bad = await postWebhook(base, mk('SMbad1', 'whatsapp:not-a-phone', 'hi'), {
      'X-Twilio-Signature': sign(mk('SMbad1', 'whatsapp:not-a-phone', 'hi')),
    });
    assert.equal(bad.status, 400);
    const miss = await postWebhook(base, mk('SMsig1', 'whatsapp:+15550001', 'hi'));
    assert.equal(miss.status, 403);
  });
  ok('invalid From is 400; missing signature is 403');
}

{
  const store = createMemoryStore();
  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  const senders = [
    'whatsapp:+15551001',
    'whatsapp:+15551002',
    'whatsapp:+15551003',
    'whatsapp:+15551004',
    'whatsapp:+15551005',
    'whatsapp:+15551006',
  ];
  await withServer(store, async ({ base }) => {
    await Promise.all(
      senders.map((from, i) => {
        const params = mk(`SMiso${i}`, from, `hello-from-${i}`);
        return postWebhook(base, params, { 'X-Twilio-Signature': sign(params) });
      })
    );
  });
  const dump = await drain(store, worker);
  assert.equal(dump.inbound.length, 6);
  assert.equal(dump.inbound.filter((r) => r.status === 'done').length, 6);
  for (let i = 0; i < senders.length; i++) {
    const from = senders[i];
    const phone = phoneE164FromSenderId(from);
    assert.equal(dump.senders[from].phoneE164, phone);
    const mine = dump.messages.filter((m) => m.sender_id === from);
    const inbound = mine.filter((m) => m.direction === 'inbound');
    const outbound = mine.filter((m) => m.direction === 'outbound');
    assert.equal(inbound.length, 1);
    assert.equal(outbound.length, 1);
    assert.equal(inbound[0].body, `hello-from-${i}`);
    assert.equal(inbound[0].mode, 'opening');
    assert.equal(inbound[0].twilio_message_sid, `SMiso${i}`);
    assert.ok(inbound[0].created_at);
    assert.ok(outbound[0].created_at);
    assert.equal(outbound[0].in_reply_to_sid, `SMiso${i}`);
    const leaked = dump.messages.some(
      (m) => m.sender_id === from && m.body && m.body.includes('hello-from-') && !m.body.includes(`hello-from-${i}`)
    );
    assert.equal(leaked, false);
    const profile = dump.profiles[from];
    assert.ok(profile);
    for (const other of senders) {
      if (other === from) continue;
      assert.equal(
        dump.messages.some((m) => m.sender_id === other && m.body === `hello-from-${i}`),
        false
      );
    }
  }
  ok('concurrent senders stay isolated; first inbound is logged as opening');
  worker.stop();
}

{
  const store = createMemoryStore();
  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  const sender = 'whatsapp:+15552001';
  await withServer(store, async ({ base }) => {
    const params = mk('SMdupx', sender, 'first-wake');
    const a = await postWebhook(base, params, { 'X-Twilio-Signature': sign(params) });
    const b = await postWebhook(base, params, { 'X-Twilio-Signature': sign(params) });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
  });
  await drain(store, worker);
  const dump = store._dump();
  assert.equal(dump.inbound.filter((r) => r.message_sid === 'SMdupx').length, 1);
  assert.equal(
    dump.messages.filter((m) => m.twilio_message_sid === 'SMdupx').length,
    1
  );
  assert.equal(
    dump.messages.filter((m) => m.direction === 'outbound' && m.in_reply_to_sid === 'SMdupx')
      .length,
    1
  );
  ok('duplicate MessageSid enqueued and logged once');
  worker.stop();
}

{
  const store = createMemoryStore();
  const sender = 'whatsapp:+15553001';
  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  await withServer(store, async ({ base }) => {
    const p1 = mk('SMordA', sender, 'wake-me');
    const p2 = mk('SMordB', sender, 'stop');
    await postWebhook(base, p1, { 'X-Twilio-Signature': sign(p1) });
    await postWebhook(base, p2, { 'X-Twilio-Signature': sign(p2) });
  });
  const dump = await drain(store, worker);
  const rows = dump.inbound
    .filter((r) => r.sender_id === sender)
    .sort((a, b) => a.id - b.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[1].status, 'done');
  assert.ok(rows[0].finished_at <= rows[1].finished_at);
  const msgs = dump.messages.filter((m) => m.sender_id === sender);
  const inbound = msgs.filter((m) => m.direction === 'inbound');
  assert.equal(inbound[0].body, 'wake-me');
  assert.equal(inbound[0].mode, 'opening');
  assert.equal(inbound[1].body, 'stop');
  assert.equal(inbound[1].mode, 'command');
  const sess = dump.sessions[sender];
  assert.equal(sess.buildHistory.filter((t) => t.role === 'user').length, 0);
  ok('same-sender order; wake text persisted but not fed to Builder');
  worker.stop();
}

{
  const store = createMemoryStore();
  const sender = 'whatsapp:+15554001';
  await store.saveProfile(sender, {
    ...emptyProfile(),
    name: 'Log Cafe',
    whatWeDo: 'coffee',
    services: [{ name: 'Drip', price: '4' }],
    approvedAt: '2026-01-01T00:00:00.000Z',
  });
  const session = await createSenderSession(store, sender);
  const entered = await handleMessage(session, '/test');
  assert.equal(entered.event, 'enter_test');
  await persistSenderSession(session);

  const worker = startInboundWorker(store, {
    intervalMs: 10_000,
    sessionDeps: {
      businessBotReply: async ({ question }) => `echo:${question}`,
    },
  });
  const n = 25;
  await withServer(store, async ({ base }) => {
    for (let i = 0; i < n; i++) {
      const params = mk(`SMcap${i}`, sender, `q-${i}`);
      const res = await postWebhook(base, params, {
        'X-Twilio-Signature': sign(params),
      });
      assert.equal(res.status, 200);
    }
  });
  await drain(store, worker);
  const mid = await store.loadSession(sender);
  assert.ok(mid.testHistory.length <= BUSINESS_BOT_STORED_MESSAGES);
  assert.equal(mid.testHistory.length, BUSINESS_BOT_STORED_MESSAGES);

  const beforeWipe = (await store.listMessages(sender)).length;
  assert.ok(beforeWipe >= n * 2);

  await withServer(store, async ({ base }) => {
    const wipe = mk('SMwipe', sender, '/test');
    await postWebhook(base, wipe, { 'X-Twilio-Signature': sign(wipe) });
  });
  await drain(store, worker);
  const after = await store.loadSession(sender);
  assert.equal(after.testHistory.length, 0);
  const logged = await store.listMessages(sender);
  assert.ok(logged.length >= beforeWipe + 2);
  const q0 = logged.find((m) => m.direction === 'inbound' && m.body === 'q-0');
  assert.ok(q0);
  assert.equal(q0.mode, 'test');
  assert.ok(logged.every((m) => m.created_at && m.direction && m.mode));
  ok('log keeps every turn after 40-cap and /test wipe');
  worker.stop();
}

{
  const store = createMemoryStore();
  const sender = 'whatsapp:+15555001';
  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  await store.enqueueInbound({
    messageSid: 'SMreclaim1',
    senderId: sender,
    body: 'stop',
  });
  const stale = new Date(Date.now() - 200_000).toISOString();
  store._patchInbound('SMreclaim1', {
    status: 'processing',
    claimed_at: stale,
  });
  await store.appendMessage({
    senderId: sender,
    direction: 'outbound',
    body: 'already sent',
    twilioMessageSid: 'SMout1',
    mode: 'command',
    inReplyToSid: 'SMreclaim1',
  });
  await drain(store, worker);
  const dump = store._dump();
  const out = dump.messages.filter(
    (m) => m.direction === 'outbound' && m.in_reply_to_sid === 'SMreclaim1'
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].body, 'already sent');
  const row = dump.inbound.find((r) => r.message_sid === 'SMreclaim1');
  assert.equal(row.status, 'done');
  ok('stale processing with outbound does not double-reply');
  worker.stop();
}

{
  const store = createMemoryStore();
  const sender = 'whatsapp:+15555002';
  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  await store.enqueueInbound({
    messageSid: 'SMreclaim2',
    senderId: sender,
    body: 'stop',
  });
  store._patchInbound('SMreclaim2', {
    status: 'processing',
    claimed_at: new Date(Date.now() - 200_000).toISOString(),
  });
  await drain(store, worker);
  const dump = store._dump();
  const row = dump.inbound.find((r) => r.message_sid === 'SMreclaim2');
  assert.equal(row.status, 'done');
  const out = dump.messages.filter(
    (m) => m.direction === 'outbound' && m.in_reply_to_sid === 'SMreclaim2'
  );
  assert.equal(out.length, 1);
  ok('stale processing without outbound is reclaimed once');
  worker.stop();
}

console.log(`\n=== ${passed} isolation checks passed ===\n`);
