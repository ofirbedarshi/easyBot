import {
  createSenderSession,
  handleMessage,
  persistSenderSession,
} from '../session.js';
import {
  burstWindowMs,
  checkMessageLength,
  checkSenderBurst,
  isLimitsExemptSender,
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

function replyBodies(result) {
  if (Array.isArray(result?.replies) && result.replies.length) {
    return result.replies.map((b) => String(b || '')).filter(Boolean);
  }
  const one = result?.reply || GENERIC_ERROR_REPLY;
  return [one];
}

/**
 * Finish outbound archive rows (reclaim / retry).
 * Sends only when a log row has no Twilio sid yet, in stored order.
 */
async function finishExistingOutbounds(store, row, existing) {
  let sid = null;
  let body = existing[existing.length - 1]?.body;
  for (const out of existing) {
    sid = out.twilio_message_sid;
    if (!sid) {
      const sent = await deliverReply({ to: row.sender_id, body: out.body });
      sid = sent.sid;
      await store.setMessageSid(out.id, sid);
    }
    body = out.body;
  }
  await store.markInboundDone(row.id, {
    replySid: sid,
    replyBody: body,
  });
}

async function finishExistingOutbound(store, row, existing) {
  return finishExistingOutbounds(store, row, [existing]);
}

async function logOutboundsThenSend(store, { senderId, inboundSid, bodies, mode }) {
  const existing = await store.findOutboundsForInbound(inboundSid);
  const rows = [...existing];
  for (let i = existing.length; i < bodies.length; i += 1) {
    const { row } = await store.appendMessage({
      senderId,
      direction: 'outbound',
      body: bodies[i],
      twilioMessageSid: null,
      mode,
      inReplyToSid: inboundSid,
    });
    rows.push(row);
  }
  let sid = null;
  for (const out of rows) {
    sid = out.twilio_message_sid;
    if (!sid) {
      const sent = await deliverReply({ to: senderId, body: out.body });
      sid = sent.sid;
      await store.setMessageSid(out.id, sid);
      out.twilio_message_sid = sid;
    }
  }
  return { sid, rows, already: existing.length >= bodies.length };
}

async function logOutboundThenSend(store, { senderId, inboundSid, body, mode }) {
  const existing = await store.findOutboundForInbound(inboundSid);
  if (existing) {
    return { sid: existing.twilio_message_sid || null, already: true, row: existing };
  }
  const sent = await logOutboundsThenSend(store, {
    senderId,
    inboundSid,
    bodies: [body],
    mode,
  });
  return { sid: sent.sid, already: false, row: sent.rows[0] };
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
    const already = await store.findOutboundsForInbound(row.message_sid);
    if (already.length) {
      await finishExistingOutbounds(store, row, already);
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

    if (!isLimitsExemptSender(senderId)) {
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const burstAgo = new Date(Date.now() - burstWindowMs()).toISOString();
      const hourCount = await store.countSenderMessagesSince(senderId, hourAgo);
      const dayCount = await store.countSenderMessagesSince(senderId, dayAgo);
      const burstCount = await store.countSenderMessagesSince(senderId, burstAgo);
      const burst = checkSenderBurst(burstCount);
      if (!burst.ok) {
        await store.updateMessageModeBySid(row.message_sid, 'limit');
        await logOutboundThenSend(store, {
          senderId,
          inboundSid: row.message_sid,
          body: burst.reason,
          mode: 'limit',
        });
        await store.markInboundSkipped(row.id, burst.reason);
        return;
      }
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
    }

    const session = await createSenderSession(store, senderId, {
      deps: sessionDeps || undefined,
    });
    const result = await handleMessage(session, length.text);
    const mode = modeFromHandleResult(result, session);
    await store.updateMessageModeBySid(row.message_sid, mode);

    const bodies = replyBodies(result);
    if (!result.reply && !result.replies?.length) {
      console.warn(`inbound ${row.message_sid} no reply:`, result.error || '(empty)');
    }

    const sent = await logOutboundsThenSend(store, {
      senderId,
      inboundSid: row.message_sid,
      bodies,
      mode,
    });
    await persistSenderSession(session);

    const lastBody = bodies[bodies.length - 1];
    await store.markInboundDone(row.id, {
      replySid: sent.sid ?? 'SKIP',
      replyBody: lastBody,
    });
    console.log(
      `inbound ${row.message_sid} done reply_sid=${sent.sid} chars=${lastBody.length} parts=${bodies.length}`
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
