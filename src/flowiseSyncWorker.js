import {
  createOrUpdateChatflow,
  pingFlowise,
  wakeFlowise,
  truncateFlowiseErrorBody,
} from './flowise.js';
import { sendWhatsAppReply } from './twilio/send.js';
import {
  renderSyncDone,
  renderSyncSuccess,
  renderSyncSuccessInTest,
} from './ownerNav.js';
import { leadSubmitted } from './leadIntake.js';

const DEFAULT_POLL_MS = 15000;
const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1000;

function pollMs() {
  return Number(process.env.FLOWISE_SYNC_POLL_MS) || DEFAULT_POLL_MS;
}

function maxWaitMs() {
  return Number(process.env.FLOWISE_SYNC_MAX_WAIT_MS) || DEFAULT_MAX_WAIT_MS;
}

function timeoutMessage() {
  return 'Your bot is still not ready after waiting. Your changes are saved. Choose **Try my bot** or type /test later to try again.';
}

/**
 * Background: wake Flowise, sync pending approved profiles, WhatsApp-notify.
 * Runs beside the inbound worker (same process gate).
 *
 * @param {object} store
 * @param {{ intervalMs?: number, maxWaitMs?: number, deps?: object }} [opts]
 */
export function startFlowiseSyncWorker(store, opts = {}) {
  const ping = opts.deps?.pingFlowise || pingFlowise;
  const wake = opts.deps?.wakeFlowise || wakeFlowise;
  const sync = opts.deps?.createOrUpdateChatflow || createOrUpdateChatflow;
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

  /**
   * Success note chosen from the sender's current mode: editing menu (menu
   * navigation active) only in BUILD; TEST gets a plain note without a menu.
   */
  async function appendSyncSuccess(senderId) {
    let session;
    try {
      session = await store.loadSession(senderId);
    } catch (err) {
      console.warn('flowise sync session load failed:', err.message);
      return renderSyncDone();
    }
    session.buildHistory = session.buildHistory || [];
    const inTest = session.mode === 'TEST';
    const msg = inTest
      ? renderSyncSuccessInTest()
      : renderSyncSuccess({ leadOption: !leadSubmitted(session.leadIntake) });
    session.buildHistory.push(
      inTest
        ? { role: 'assistant', content: msg }
        : { role: 'assistant', content: msg, nav: 'menu' }
    );
    try {
      await store.saveSession(senderId, session);
    } catch (err) {
      console.warn('flowise sync history append failed:', err.message);
    }
    return msg;
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
        wake().finally(() => {
          wakeStarted = false;
        });
      }

      const up = await ping({ timeoutMs: 8000 });
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
        const chatflowId = await sync(profile);
        profile.chatflowId = chatflowId;
        profile.flowiseSyncOk = true;
        profile.flowiseSyncPending = false;
        profile.flowiseSyncedAt = new Date().toISOString();
        profile.flowiseSyncRequestedAt = null;
        await store.saveProfile(senderId, profile);
        const msg = await appendSyncSuccess(senderId);
        if (msg) await notify(senderId, msg);
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
