import {
  createOrUpdateChatflow,
  pingFlowise,
  wakeFlowise,
  truncateFlowiseErrorBody,
} from './flowise.js';
import { sendWhatsAppReply } from './twilio/send.js';

const DEFAULT_POLL_MS = 15000;
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;

function pollMs() {
  return Number(process.env.FLOWISE_SYNC_POLL_MS) || DEFAULT_POLL_MS;
}

function maxWaitMs() {
  return Number(process.env.FLOWISE_SYNC_MAX_WAIT_MS) || DEFAULT_MAX_WAIT_MS;
}

function readyMessage(chatflowId) {
  return `Flowise is ready — your customer bot is synced (chatflow ${chatflowId}). Type /test to try it.`;
}

function timeoutMessage() {
  return 'Flowise is still unavailable after waiting. Your facts stay approved locally. Say **approve** again later when the service is up, then /test.';
}

/**
 * Background: wake Flowise, sync pending approved profiles, WhatsApp-notify.
 * Runs beside the inbound worker (same process gate).
 *
 * @param {object} store
 * @param {{ intervalMs?: number, maxWaitMs?: number }} [opts]
 */
export function startFlowiseSyncWorker(store, opts = {}) {
  if (typeof store.listPendingFlowiseSyncs !== 'function') {
    console.warn('Flowise sync worker: store missing listPendingFlowiseSyncs — OFF');
    return { stop() {}, tick: async () => {} };
  }

  const interval = opts.intervalMs ?? pollMs();
  const maxWait = opts.maxWaitMs ?? maxWaitMs();
  /** @type {Set<string>} */
  const inFlight = new Set();
  let stopped = false;
  let busy = false;
  let wakeStarted = false;

  async function notify(senderId, body) {
    if (!senderId || !String(senderId).startsWith('whatsapp:')) return;
    if (process.env.TWILIO_SKIP_OUTBOUND === '1') return;
    if (!process.env.TWILIO_AUTH_TOKEN) return;
    try {
      await sendWhatsAppReply({ to: senderId, body });
    } catch (err) {
      console.error('flowise sync notify failed:', err.message);
    }
  }

  async function appendAssistant(senderId, content) {
    try {
      const session = await store.loadSession(senderId);
      session.buildHistory = session.buildHistory || [];
      session.buildHistory.push({ role: 'assistant', content });
      await store.saveSession(senderId, session);
    } catch (err) {
      console.warn('flowise sync history append failed:', err.message);
    }
  }

  async function processOne(row) {
    const { senderId, profile } = row;
    if (!senderId || inFlight.has(senderId)) return;
    inFlight.add(senderId);
    try {
      const requestedAt = profile.flowiseSyncRequestedAt
        ? Date.parse(profile.flowiseSyncRequestedAt)
        : Date.now();
      const age = Date.now() - (Number.isFinite(requestedAt) ? requestedAt : Date.now());

      if (!wakeStarted) {
        wakeStarted = true;
        wakeFlowise().finally(() => {
          wakeStarted = false;
        });
      }

      const up = await pingFlowise({ timeoutMs: 8000 });
      if (!up) {
        if (age >= maxWait) {
          profile.flowiseSyncPending = false;
          profile.flowiseSyncOk = false;
          await store.saveProfile(senderId, profile);
          const msg = timeoutMessage();
          await appendAssistant(senderId, msg);
          await notify(senderId, msg);
          console.warn(`flowise sync give up sender=${senderId} after ${age}ms`);
        }
        return;
      }

      try {
        const chatflowId = await createOrUpdateChatflow(profile);
        profile.chatflowId = chatflowId;
        profile.flowiseSyncOk = true;
        profile.flowiseSyncPending = false;
        profile.flowiseSyncedAt = new Date().toISOString();
        profile.flowiseSyncRequestedAt = null;
        await store.saveProfile(senderId, profile);
        const msg = readyMessage(chatflowId);
        await appendAssistant(senderId, msg);
        await notify(senderId, msg);
        console.log(`flowise sync ok sender=${senderId} chatflow=${chatflowId}`);
      } catch (err) {
        const short = truncateFlowiseErrorBody(err.message, 160);
        console.warn(`flowise sync attempt failed sender=${senderId}:`, short);
        if (age >= maxWait) {
          profile.flowiseSyncPending = false;
          profile.flowiseSyncOk = false;
          await store.saveProfile(senderId, profile);
          const msg = timeoutMessage();
          await appendAssistant(senderId, msg);
          await notify(senderId, msg);
        }
      }
    } finally {
      inFlight.delete(senderId);
    }
  }

  async function tick() {
    if (stopped || busy) return;
    busy = true;
    try {
      const pending = await store.listPendingFlowiseSyncs();
      for (const row of pending || []) {
        await processOne(row);
      }
    } catch (err) {
      console.error('flowise sync worker tick:', err.message);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, interval);
  if (timer.unref) timer.unref();
  // Kick once soon so cold-start Approve does not wait a full poll
  setTimeout(tick, 2000).unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}
