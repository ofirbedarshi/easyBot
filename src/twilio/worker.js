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
import { modeFromHandleResult } from '../conversationLog.js';

const GENERIC_ERROR_REPLY =
  'Sorry, something went wrong processing that message. Please try again.';

async function deliverReply({ to, body }) {
  if (process.env.TWILIO_SKIP_OUTBOUND === '1') {
    return { sid: 'SKIP' };
  }
  return sendWhatsAppReply({ to, body });
}

/**
 * Finish a row that already has an outbound archive row (reclaim / retry).
 * Sends only when the log row has no Twilio sid yet.
 */
async function finishExistingOutbound(store, row, existing) {
  let sid = existing.twilio_message_sid;
  if (!sid) {
    const sent = await deliverReply({ to: row.sender_id, body: existing.body });
    sid = sent.sid;
    await store.setMessageSid(existing.id, sid);
  }
  await store.markInboundDone(row.id, {
    replySid: sid,
    replyBody: existing.body,
  });
}

async function logOutboundThenSend(store, { senderId, inboundSid, body, mode }) {
  const existing = await store.findOutboundForInbound(inboundSid);
  if (existing) {
    return { sid: existing.twilio_message_sid || null, already: true, row: existing };
  }
  const { row } = await store.appendMessage({
    senderId,
    direction: 'outbound',
    body,
    twilioMessageSid: null,
    mode,
    inReplyToSid: inboundSid,
  });
  const sent = await deliverReply({ to: senderId, body });
  await store.setMessageSid(row.id, sent.sid);
  return { sid: sent.sid, already: false, row };
}

/**
 * Durable inbound processor. Polls store; per-sender serial via claim.
 * Different senders are processed in parallel on each tick.
 */
export function startInboundWorker(store, opts = {}) {
  const intervalMs =
    opts.intervalMs ?? (Number(process.env.WORKER_POLL_MS) || 500);
  const sessionDeps = opts.sessionDeps || null;
  let stopped = false;
  let busy = false;

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const claimed = [];
      for (let i = 0; i < 5; i++) {
        const row = await store.claimNextInbound();
        if (!row) break;
        claimed.push(row);
      }
      await Promise.all(
        claimed.map((row) => processRow(store, row, { sessionDeps }))
      );
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

async function processRow(store, row, { sessionDeps } = {}) {
  const senderId = row.sender_id;
  const body = row.body || '';

  try {
    const already = await store.findOutboundForInbound(row.message_sid);
    if (already) {
      await finishExistingOutbound(store, row, already);
      return;
    }

    const length = checkMessageLength(body);
    if (!length.ok) {
      await store.updateMessageModeBySid(row.message_sid, 'limit');
      const sent = await logOutboundThenSend(store, {
        senderId,
        inboundSid: row.message_sid,
        body: length.reason,
        mode: 'limit',
      });
      if (sent.already) {
        await finishExistingOutbound(store, row, sent.row);
        return;
      }
      await store.markInboundSkipped(row.id, length.reason);
      return;
    }

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const hourCount = await store.countSenderMessagesSince(senderId, hourAgo);
    const dayCount = await store.countSenderMessagesSince(senderId, dayAgo);
    if (hourCount > maxMsgsPerSenderPerHour()) {
      const msg = 'Hourly message limit reached. Try again later.';
      await store.updateMessageModeBySid(row.message_sid, 'limit');
      await logOutboundThenSend(store, {
        senderId,
        inboundSid: row.message_sid,
        body: msg,
        mode: 'limit',
      });
      await store.markInboundSkipped(row.id, msg);
      return;
    }
    if (dayCount > maxMsgsPerSenderPerDay()) {
      const msg = 'Daily message limit reached. Try again tomorrow.';
      await store.updateMessageModeBySid(row.message_sid, 'limit');
      await logOutboundThenSend(store, {
        senderId,
        inboundSid: row.message_sid,
        body: msg,
        mode: 'limit',
      });
      await store.markInboundSkipped(row.id, msg);
      return;
    }

    const session = await createSenderSession(store, senderId, {
      deps: sessionDeps || undefined,
    });
    const result = await handleMessage(session, length.text);
    const mode = modeFromHandleResult(result, session);
    await store.updateMessageModeBySid(row.message_sid, mode);

    if (!result.reply) {
      console.warn(`inbound ${row.message_sid} no reply:`, result.error || '(empty)');
    }
    const reply = result.reply || GENERIC_ERROR_REPLY;

    await logOutboundThenSend(store, {
      senderId,
      inboundSid: row.message_sid,
      body: reply,
      mode,
    });
    await persistSenderSession(session);

    const outbound = await store.findOutboundForInbound(row.message_sid);
    await store.markInboundDone(row.id, {
      replySid: outbound?.twilio_message_sid ?? 'SKIP',
      replyBody: reply,
    });
    console.log(
      `inbound ${row.message_sid} done reply_sid=${outbound?.twilio_message_sid} chars=${reply.length}`
    );
  } catch (err) {
    console.error(`process inbound ${row.message_sid}:`, err.message);
    try {
      await store.updateMessageModeBySid(row.message_sid, 'error');
      await logOutboundThenSend(store, {
        senderId,
        inboundSid: row.message_sid,
        body: GENERIC_ERROR_REPLY,
        mode: 'error',
      });
    } catch {
      /* ignore outbound fail */
    }
    await store.markInboundFailed(row.id, err.message);
  }
}
