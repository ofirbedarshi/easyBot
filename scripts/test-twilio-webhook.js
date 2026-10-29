/**
 * Mocked Twilio webhook tests — no network, no OpenAI, no live Twilio.
 * Labels: MOCKED only (not Sandbox, not live WhatsApp).
 *
 * Run: npm run test:twilio
 */
import assert from 'assert';
import twilio from 'twilio';
import express from 'express';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { createTwilioWhatsAppRouter } from '../src/twilio/webhook.js';
import { startInboundWorker } from '../src/twilio/worker.js';
import {
  validateTwilioSignature,
  resolveWebhookUrl,
} from '../src/twilio/validate.js';
import {
  createSenderSession,
  handleMessage,
  persistSenderSession,
  bootstrapSession,
} from '../src/session.js';
import { emptyProfile } from '../src/profile.js';
import {
  BURST_LIMIT_REPLY,
  checkMessageLength,
  checkSenderBurst,
  maxMessageChars,
  maxMsgsPerSenderPerBurst,
} from '../src/limits.js';

const AUTH = 'test_auth_token_for_mocked_suite';
const BASE = 'https://demo.example.com';
const PATH = '/webhooks/twilio/whatsapp';
const FULL_URL = `${BASE}${PATH}`;

process.env.TWILIO_AUTH_TOKEN = AUTH;
process.env.PUBLIC_BASE_URL = BASE;
process.env.TWILIO_SKIP_OUTBOUND = '1';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''; // builder not needed for most tests

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

async function drain(store, worker, maxTicks = 40) {
  for (let i = 0; i < maxTicks; i++) {
    await worker.tick();
    const dump = store._dump();
    const pending = dump.inbound.filter((r) =>
      ['received', 'processing'].includes(r.status)
    );
    if (pending.length === 0) return dump;
    await sleep(20);
  }
  return store._dump();
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('=== MOCKED Twilio webhook suite (not Sandbox / not live) ===\n');

{
  const prevChars = process.env.DEMO_MAX_MSG_CHARS;
  const prevBurst = process.env.DEMO_MAX_MSGS_PER_SENDER_PER_BURST;
  delete process.env.DEMO_MAX_MSG_CHARS;
  delete process.env.DEMO_MAX_MSGS_PER_SENDER_PER_BURST;
  assert.equal(maxMessageChars(), 1000);
  assert.equal(maxMsgsPerSenderPerBurst(), 10);
  const okLen = checkMessageLength('a'.repeat(1000));
  assert.equal(okLen.ok, true);
  const long = checkMessageLength('a'.repeat(1001));
  assert.equal(long.ok, false);
  assert.match(long.reason, /max 1000 characters/);
  assert.equal(checkSenderBurst(10).ok, true);
  const burst = checkSenderBurst(11);
  assert.equal(burst.ok, false);
  assert.equal(burst.reason, BURST_LIMIT_REPLY);
  process.env.DEMO_MAX_MSG_CHARS = '50';
  process.env.DEMO_MAX_MSGS_PER_SENDER_PER_BURST = '3';
  assert.equal(maxMessageChars(), 50);
  assert.equal(checkSenderBurst(4).ok, false);
  if (prevChars == null) delete process.env.DEMO_MAX_MSG_CHARS;
  else process.env.DEMO_MAX_MSG_CHARS = prevChars;
  if (prevBurst == null) delete process.env.DEMO_MAX_MSGS_PER_SENDER_PER_BURST;
  else process.env.DEMO_MAX_MSGS_PER_SENDER_PER_BURST = prevBurst;
  ok('length default 1000 and burst 10/10min are env-configurable');
}

// --- Unit: signature helper ---
{
  const params = {
    MessageSid: 'SMunit1',
    From: 'whatsapp:+15550001',
    To: 'whatsapp:+15550000',
    Body: 'hello',
  };
  const good = validateTwilioSignature({
    authToken: AUTH,
    signature: sign(params),
    webhookUrl: FULL_URL,
    params,
  });
  assert.equal(good.ok, true);
  ok('validateTwilioSignature accepts valid signature');

  const bad = validateTwilioSignature({
    authToken: AUTH,
    signature: 'not-a-valid-signature',
    webhookUrl: FULL_URL,
    params,
  });
  assert.equal(bad.ok, false);
  ok('validateTwilioSignature rejects invalid signature');

  const missing = validateTwilioSignature({
    authToken: AUTH,
    signature: undefined,
    webhookUrl: FULL_URL,
    params,
  });
  assert.equal(missing.ok, false);
  ok('validateTwilioSignature rejects missing signature');
}

// --- HTTP: valid / invalid / missing ---
{
  const store = createMemoryStore();
  await withServer(store, async ({ base }) => {
    const params = {
      MessageSid: 'SMhttp1',
      AccountSid: 'ACtest',
      From: 'whatsapp:+15551111',
      To: 'whatsapp:+15550000',
      Body: 'ping',
      NumMedia: '0',
    };
    const good = await postWebhook(base, params, {
      'X-Twilio-Signature': sign(params),
    });
    assert.equal(good.status, 200);
    assert.ok(good.text.includes('<Response>'));
    ok('HTTP accepts valid signature (200 + TwiML)');

    const bad = await postWebhook(base, params, {
      'X-Twilio-Signature': 'xxxxx',
    });
    assert.equal(bad.status, 403);
    ok('HTTP rejects invalid signature (403)');

    const miss = await postWebhook(base, { ...params, MessageSid: 'SMhttp2' });
    assert.equal(miss.status, 403);
    ok('HTTP rejects missing signature (403)');
  });
}

// --- Duplicate MessageSid ---
{
  const store = createMemoryStore();
  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  // Stub handle path: inject profile so worker does not call OpenAI if body is stop
  await withServer(store, async ({ base }) => {
    const params = {
      MessageSid: 'SMdup1',
      AccountSid: 'ACtest',
      From: 'whatsapp:+15552222',
      To: 'whatsapp:+15550000',
      Body: 'stop',
      NumMedia: '0',
    };
    const a = await postWebhook(base, params, {
      'X-Twilio-Signature': sign(params),
    });
    const b = await postWebhook(base, params, {
      'X-Twilio-Signature': sign(params),
    });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const dump = store._dump();
    const rows = dump.inbound.filter((r) => r.message_sid === 'SMdup1');
    assert.equal(rows.length, 1);
    ok('duplicate MessageSid enqueued once');
  });
  await drain(store, worker);
  worker.stop();
}

// --- Per-sender order ---
{
  const store = createMemoryStore();
  const sender = 'whatsapp:+15553333';
  await store.ensureSender(sender);
  // Pre-seed session so stop and second command do not need OpenAI
  const session = await createSenderSession(store, sender);
  bootstrapSession(session);
  await persistSenderSession(session);

  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  await withServer(store, async ({ base }) => {
    const p1 = {
      MessageSid: 'SMord1',
      AccountSid: 'ACtest',
      From: sender,
      To: 'whatsapp:+15550000',
      Body: 'stop',
      NumMedia: '0',
    };
    const p2 = {
      MessageSid: 'SMord2',
      AccountSid: 'ACtest',
      From: sender,
      To: 'whatsapp:+15550000',
      Body: 'stop',
      NumMedia: '0',
    };
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
  ok('consecutive messages processed in order for one sender');
  worker.stop();
}

// --- Two-sender isolation ---
{
  const store = createMemoryStore();
  const a = 'whatsapp:+15554441';
  const b = 'whatsapp:+15554442';
  await store.saveProfile(a, {
    ...emptyProfile(),
    name: 'Sender A Biz',
    whatWeDo: 'yoga',
    approvedAt: '2026-01-01T00:00:00.000Z',
  });
  await store.saveProfile(b, {
    ...emptyProfile(),
    name: 'Sender B Biz',
    whatWeDo: 'barber',
    approvedAt: '2026-01-01T00:00:00.000Z',
  });
  const sa = await createSenderSession(store, a);
  const sb = await createSenderSession(store, b);
  bootstrapSession(sa);
  bootstrapSession(sb);
  await persistSenderSession(sa);
  await persistSenderSession(sb);

  const ra = await handleMessage(sa, '/test');
  await persistSenderSession(sa);
  const rb = await handleMessage(sb, 'stop');
  await persistSenderSession(sb);

  assert.equal(ra.event, 'enter_test');
  assert.equal(sa.mode, 'TEST');
  assert.equal(sb.mode, 'BUILD');
  const pa = await store.loadProfile(a);
  const pb = await store.loadProfile(b);
  assert.equal(pa.name, 'Sender A Biz');
  assert.equal(pb.name, 'Sender B Biz');
  ok('two senders keep isolated profiles and modes');

  // /test blocked until name + offering
  await store.saveProfile(a, emptyProfile());
  const sa2 = await createSenderSession(store, a);
  sa2.mode = 'BUILD';
  const blocked = await handleMessage(sa2, '/test');
  assert.equal(blocked.ok, false);
  assert.match(blocked.reply, /business name and what you do/);
  ok('/test blocked until name and offering are set');
}

// --- Builder/test commands through webhook (MOCKED; no OpenAI network) ---
{
  const store = createMemoryStore();
  const sender = 'whatsapp:+15555555';
  await store.saveProfile(sender, {
    ...emptyProfile(),
    name: 'Demo Yoga',
    whatWeDo: 'yoga classes',
    services: [{ name: 'Drop-in', price: '15' }],
    informationToCollect: [],
    approvedAt: '2026-01-01T00:00:00.000Z',
  });
  const session = await createSenderSession(store, sender);
  bootstrapSession(session);
  await persistSenderSession(session);

  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  await withServer(store, async ({ base }) => {
    const mk = (sid, body) => ({
      MessageSid: sid,
      AccountSid: 'ACtest',
      From: sender,
      To: 'whatsapp:+15550000',
      Body: body,
      NumMedia: '0',
    });
    const t1 = mk('SMwf1', '/test');
    const t2 = mk('SMwf2', 'stop');
    await postWebhook(base, t1, { 'X-Twilio-Signature': sign(t1) });
    await postWebhook(base, t2, { 'X-Twilio-Signature': sign(t2) });
  });
  const dump = await drain(store, worker);
  const sess = await store.loadSession(sender);
  assert.equal(sess.mode, 'BUILD');
  const done = dump.inbound.filter((r) => r.status === 'done');
  assert.equal(done.length, 2);
  const outFor = (sid) =>
    dump.messages
      .filter((m) => m.direction === 'outbound' && m.in_reply_to_sid === sid)
      .sort((a, b) => a.id - b.id);
  const testOut = outFor('SMwf1');
  const stopOut = outFor('SMwf2');
  assert.equal(testOut.length, 2);
  assert.ok(testOut[0].body.includes("From here on, I'll answer just like I would for Demo Yoga's customers"));
  assert.ok(testOut[0].body.includes('Spotted something wrong? Type *stop*'));
  assert.ok(testOut[0].body.includes('Done trying me out? Type *stop* too.'));
  assert.ok(!testOut[0].body.includes('/end'));
  assert.ok(testOut[1].body.includes("Hi! I'm Adam, Demo Yoga's digital assistant"));
  assert.equal(stopOut.length, 2);
  assert.ok(stopOut[0].body.includes('*Test mode is off*'));
  assert.ok(stopOut[0].body.includes("I'm back to learning about your business."));
  assert.ok(stopOut[1].body.startsWith("I'm back! What should I learn next?"));
  assert.ok(done[0].reply_body.includes("Hi! I'm Adam, Demo Yoga's digital assistant"));
  assert.ok(done[1].reply_body.startsWith("I'm back! What should I learn next?"));
  assert.equal(sess.buildHistory[sess.buildHistory.length - 1].nav, 'menu');
  ok('webhook workflow /test then stop (mocked store + worker)');
  worker.stop();
}

// resolveWebhookUrl smoke
{
  const req = {
    originalUrl: PATH,
    path: PATH,
    url: PATH,
    protocol: 'https',
    get(h) {
      if (h === 'host') return 'demo.example.com';
      return undefined;
    },
  };
  process.env.PUBLIC_BASE_URL = BASE;
  assert.equal(resolveWebhookUrl(req), FULL_URL);
  ok('resolveWebhookUrl uses PUBLIC_BASE_URL');
}

// --- Burst cap: 11th message in the window is skipped (no LLM) ---
{
  const store = createMemoryStore();
  const sender = 'whatsapp:+15556666';
  await store.ensureSender(sender);
  const session = await createSenderSession(store, sender);
  bootstrapSession(session);
  await persistSenderSession(session);

  for (let i = 0; i < 10; i++) {
    const sid = `SMburst${i}`;
    await store.enqueueInbound({
      messageSid: sid,
      senderId: sender,
      body: `seed ${i}`,
    });
    store._patchInbound(sid, { status: 'done' });
  }

  const worker = startInboundWorker(store, { intervalMs: 10_000 });
  await withServer(store, async ({ base }) => {
    const params = {
      MessageSid: 'SMburst10',
      AccountSid: 'ACtest',
      From: sender,
      To: 'whatsapp:+15550000',
      Body: 'one more',
      NumMedia: '0',
    };
    await postWebhook(base, params, { 'X-Twilio-Signature': sign(params) });
  });
  const dump = await drain(store, worker);
  const last = dump.inbound.find((r) => r.message_sid === 'SMburst10');
  assert.equal(last.status, 'skipped');
  assert.equal(last.error, BURST_LIMIT_REPLY);
  const outbound = dump.messages.find((m) => m.in_reply_to_sid === 'SMburst10');
  assert.ok(outbound, 'burst skip still sends a reply');
  assert.equal(outbound.body, BURST_LIMIT_REPLY);
  ok('11th inbound in 10 minutes hits the burst cap');
  worker.stop();
}

console.log(`\n=== ${passed} mocked checks passed ===`);
console.log('Not run here: Twilio Sandbox, live WhatsApp number.\n');
