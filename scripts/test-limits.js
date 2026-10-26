/**
 * LIMITS_EXEMPT_SENDERS + volume-cap skip (no network).
 * Run: node scripts/test-limits.js  (also part of npm test)
 */
import assert from 'assert';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { startInboundWorker } from '../src/twilio/worker.js';
import {
  createSenderSession,
  persistSenderSession,
  bootstrapSession,
} from '../src/session.js';
import { BURST_LIMIT_REPLY, checkMessageLength, isLimitsExemptSender } from '../src/limits.js';

process.env.TWILIO_SKIP_OUTBOUND = '1';

const EXEMPT_E164 = '+15551234001';
const EXEMPT_SENDER = `whatsapp:${EXEMPT_E164}`;
const OTHER_SENDER = 'whatsapp:+15551234002';

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
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

async function seedDoneInbound(store, sender, count, prefix) {
  for (let i = 0; i < count; i++) {
    const sid = `${prefix}${i}`;
    await store.enqueueInbound({
      messageSid: sid,
      senderId: sender,
      body: `seed ${i}`,
    });
    store._patchInbound(sid, { status: 'done' });
  }
}

async function readySession(store, sender) {
  await store.ensureSender(sender);
  const session = await createSenderSession(store, sender);
  bootstrapSession(session);
  await persistSenderSession(session);
}

async function withEnv(overrides, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

console.log('=== LIMITS_EXEMPT_SENDERS suite ===\n');

{
  await withEnv({ LIMITS_EXEMPT_SENDERS: null }, () => {
    assert.equal(isLimitsExemptSender(EXEMPT_SENDER), false);
    assert.equal(isLimitsExemptSender(EXEMPT_E164), false);
  });
  await withEnv({ LIMITS_EXEMPT_SENDERS: '' }, () => {
    assert.equal(isLimitsExemptSender(EXEMPT_SENDER), false);
  });
  await withEnv({ LIMITS_EXEMPT_SENDERS: '   ' }, () => {
    assert.equal(isLimitsExemptSender(EXEMPT_SENDER), false);
  });
  ok('unset / empty / whitespace LIMITS_EXEMPT_SENDERS means no exemptions');
}

{
  const envList = `  whatsapp: ${EXEMPT_E164} , ${OTHER_SENDER} `;
  assert.equal(isLimitsExemptSender(EXEMPT_SENDER, envList), true);
  assert.equal(isLimitsExemptSender(EXEMPT_E164, envList), true);
  assert.equal(isLimitsExemptSender(`  ${EXEMPT_E164}  `, envList), true);
  assert.equal(isLimitsExemptSender(`whatsapp: ${EXEMPT_E164}`, envList), true);
  assert.equal(isLimitsExemptSender(OTHER_SENDER, envList), true);
  assert.equal(isLimitsExemptSender('whatsapp:+15551234999', envList), false);
  assert.equal(isLimitsExemptSender('not-a-phone', envList), false);
  ok('whatsapp: prefix and whitespace are normalized on either side');
}

{
  const store = createMemoryStore();
  await readySession(store, EXEMPT_SENDER);
  await seedDoneInbound(store, EXEMPT_SENDER, 5, 'SMover');

  const dump = await withEnv(
    {
      LIMITS_EXEMPT_SENDERS: `  whatsapp:${EXEMPT_E164} `,
      DEMO_MAX_MSGS_PER_SENDER_PER_BURST: '2',
      DEMO_MAX_MSGS_PER_SENDER_PER_HOUR: '2',
      DEMO_MAX_MSGS_PER_SENDER_PER_DAY: '2',
    },
    async () => {
      await store.enqueueInbound({
        messageSid: 'SMexempt-live',
        senderId: EXEMPT_SENDER,
        body: '/end',
      });
      const worker = startInboundWorker(store, { intervalMs: 10_000 });
      const result = await drain(store, worker);
      worker.stop();
      return result;
    }
  );

  const row = dump.inbound.find((r) => r.message_sid === 'SMexempt-live');
  assert.equal(row.status, 'done');
  assert.ok(row.reply_body);
  assert.notEqual(row.error, BURST_LIMIT_REPLY);
  ok('exempt sender over burst/hour/day caps is still processed');
}

{
  const store = createMemoryStore();
  await readySession(store, OTHER_SENDER);
  await seedDoneInbound(store, OTHER_SENDER, 5, 'SMblock');

  const dump = await withEnv(
    {
      LIMITS_EXEMPT_SENDERS: EXEMPT_E164,
      DEMO_MAX_MSGS_PER_SENDER_PER_BURST: '2',
      DEMO_MAX_MSGS_PER_SENDER_PER_HOUR: '2',
      DEMO_MAX_MSGS_PER_SENDER_PER_DAY: '2',
    },
    async () => {
      await store.enqueueInbound({
        messageSid: 'SMblock-live',
        senderId: OTHER_SENDER,
        body: '/end',
      });
      const worker = startInboundWorker(store, { intervalMs: 10_000 });
      const result = await drain(store, worker);
      worker.stop();
      return result;
    }
  );

  const row = dump.inbound.find((r) => r.message_sid === 'SMblock-live');
  assert.equal(row.status, 'skipped');
  assert.equal(row.error, BURST_LIMIT_REPLY);
  ok('non-exempt sender is still blocked by volume caps');
}

{
  const store = createMemoryStore();
  await readySession(store, EXEMPT_SENDER);
  await seedDoneInbound(store, EXEMPT_SENDER, 5, 'SMempty');

  const dump = await withEnv(
    {
      LIMITS_EXEMPT_SENDERS: '',
      DEMO_MAX_MSGS_PER_SENDER_PER_BURST: '2',
      DEMO_MAX_MSGS_PER_SENDER_PER_HOUR: '2',
      DEMO_MAX_MSGS_PER_SENDER_PER_DAY: '2',
    },
    async () => {
      await store.enqueueInbound({
        messageSid: 'SMempty-live',
        senderId: EXEMPT_SENDER,
        body: '/end',
      });
      const worker = startInboundWorker(store, { intervalMs: 10_000 });
      const result = await drain(store, worker);
      worker.stop();
      return result;
    }
  );

  const row = dump.inbound.find((r) => r.message_sid === 'SMempty-live');
  assert.equal(row.status, 'skipped');
  ok('empty LIMITS_EXEMPT_SENDERS keeps current volume-cap behavior');
}

{
  const longBody = 'x'.repeat(21);
  const dump = await withEnv(
    {
      LIMITS_EXEMPT_SENDERS: EXEMPT_E164,
      DEMO_MAX_MSG_CHARS: '20',
    },
    async () => {
      const length = checkMessageLength(longBody);
      assert.equal(length.ok, false);
      const store = createMemoryStore();
      await readySession(store, EXEMPT_SENDER);
      await store.enqueueInbound({
        messageSid: 'SMlong1',
        senderId: EXEMPT_SENDER,
        body: longBody,
      });
      const worker = startInboundWorker(store, { intervalMs: 10_000 });
      const result = await drain(store, worker);
      worker.stop();
      return result;
    }
  );
  const row = dump.inbound.find((r) => r.message_sid === 'SMlong1');
  assert.equal(row.status, 'skipped');
  assert.match(row.error, /max 20 characters/);
  ok('exempt sender still hits the per-message character cap');
}

console.log(`\n=== ${passed} limits checks passed ===\n`);
