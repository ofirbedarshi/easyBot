import {
  createSenderSession,
  handleMessage,
  persistSenderSession,
} from '../session.js';
import {
  checkMessageLength,
  maxMsgsPerSenderPerDay,
  maxMsgsPerSenderPerHour,
} from '../limits.js';
import { sendWhatsAppReply } from './send.js';

/**
 * Durable inbound processor. Polls store; per-sender serial via claim RPC/store.
 */
export function startInboundWorker(store, opts = {}) {
  const intervalMs =
    opts.intervalMs ?? (Number(process.env.WORKER_POLL_MS) || 500);
  let stopped = false;
  let busy = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      // Drain several claims per tick; claim fn already serializes per sender
      for (let i = 0; i < 5; i++) {
        const row = await store.claimNextInbound();
        if (!row) break;
        await processRow(store, row);
      }
    } catch (err) {
      console.error('worker tick error:', err.message);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  if (timer.unref) timer.unref();
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

async function processRow(store, row) {
  const senderId = row.sender_id;
  const body = row.body || '';

  try {
    const length = checkMessageLength(body);
    if (!length.ok) {
      await sendWhatsAppReply({ to: senderId, body: length.reason });
      await store.markInboundSkipped(row.id, length.reason);
      return;
    }

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const hourCount = await store.countSenderMessagesSince(senderId, hourAgo);
    const dayCount = await store.countSenderMessagesSince(senderId, dayAgo);
    if (hourCount > maxMsgsPerSenderPerHour()) {
      const msg = 'Hourly message limit reached. Try again later.';
      await sendWhatsAppReply({ to: senderId, body: msg });
      await store.markInboundSkipped(row.id, msg);
      return;
    }
    if (dayCount > maxMsgsPerSenderPerDay()) {
      const msg = 'Daily message limit reached. Try again tomorrow.';
      await sendWhatsAppReply({ to: senderId, body: msg });
      await store.markInboundSkipped(row.id, msg);
      return;
    }

    const session = await createSenderSession(store, senderId);
    const result = await handleMessage(session, length.text);
    await persistSenderSession(session);

    const reply = result.reply || result.error || '(no reply)';
    let replySid = null;
    if (process.env.TWILIO_SKIP_OUTBOUND === '1') {
      // Tests / dry-run — no Twilio send
      replySid = 'SKIP';
    } else {
      const sent = await sendWhatsAppReply({ to: senderId, body: reply });
      replySid = sent.sid;
    }

    await store.markInboundDone(row.id, {
      replySid,
      replyBody: reply,
    });
    console.log(
      `inbound ${row.message_sid} done reply_sid=${replySid} chars=${reply.length}`
    );
  } catch (err) {
    console.error(`process inbound ${row.message_sid}:`, err.message);
    try {
      await sendWhatsAppReply({
        to: senderId,
        body: 'Sorry, something went wrong processing that message. Please try again.',
      });
    } catch {
      /* ignore outbound fail */
    }
    await store.markInboundFailed(row.id, err.message);
  }
}
