/**
 * In-memory store for mocked WhatsApp tests (no Supabase / Twilio network).
 */

import { emptyProfile } from '../profile.js';
import { phoneE164FromSenderId } from '../phone.js';
import { modeFromSessionPreview } from '../conversationLog.js';

/** Matches easybot_claim_next_inbound 120s reclaim. */
export const INBOUND_CLAIM_STALE_MS = 120_000;

export function createMemoryStore() {
  /** @type {Map<string, object>} */
  const senders = new Map();
  /** @type {Map<string, object>} */
  const profiles = new Map();
  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** @type {Map<string, object>} */
  const bySid = new Map();
  /** @type {object[]} */
  const inbound = [];
  /** @type {object[]} */
  const messages = [];
  /** @type {Map<string, object>} */
  const leads = new Map();
  let nextId = 1;
  let nextMessageId = 1;

  function senderHasProcessing(senderId) {
    return inbound.some((p) => p.sender_id === senderId && p.status === 'processing');
  }

  return {
    kind: 'memory',

    async ensureSender(senderId) {
      const phoneE164 = phoneE164FromSenderId(senderId);
      if (!phoneE164) {
        throw new Error('ensureSender: invalid sender phone');
      }
      const now = new Date().toISOString();
      if (!senders.has(senderId)) {
        senders.set(senderId, {
          id: senderId,
          phoneE164,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const prev = senders.get(senderId);
        senders.set(senderId, { ...prev, phoneE164, updatedAt: now });
      }
      if (!profiles.has(senderId)) {
        profiles.set(senderId, emptyProfile());
      }
      if (!sessions.has(senderId)) {
        sessions.set(senderId, {
          mode: 'BUILD',
          buildHistory: [],
          testHistory: [],
          testSessionId: `test-${Date.now()}`,
          leadIntake: null,
        });
      }
    },

    async loadProfile(senderId) {
      await this.ensureSender(senderId);
      return structuredClone(profiles.get(senderId));
    },

    async saveProfile(senderId, profile) {
      await this.ensureSender(senderId);
      profiles.set(senderId, structuredClone(profile));
      return profile;
    },

    async loadSession(senderId) {
      await this.ensureSender(senderId);
      return structuredClone(sessions.get(senderId));
    },

    async saveSession(senderId, session) {
      await this.ensureSender(senderId);
      sessions.set(senderId, {
        mode: session.mode,
        buildHistory: structuredClone(session.buildHistory || []),
        testHistory: structuredClone(session.testHistory || []),
        testSessionId: session.testSessionId,
        leadIntake: structuredClone(session.leadIntake ?? null),
      });
    },

    /** One lead per sender; a second save keeps the first. */
    async saveLead(senderId, lead) {
      await this.ensureSender(senderId);
      if (!leads.has(senderId)) leads.set(senderId, structuredClone(lead));
    },

    async appendMessage({
      senderId,
      direction,
      body,
      twilioMessageSid,
      mode,
      inReplyToSid,
    }) {
      await this.ensureSender(senderId);
      if (twilioMessageSid) {
        const existing = messages.find(
          (m) => m.twilio_message_sid === twilioMessageSid
        );
        if (existing) return { inserted: false, row: existing };
      }
      const row = {
        id: nextMessageId++,
        sender_id: senderId,
        direction,
        body: body ?? '',
        twilio_message_sid: twilioMessageSid ?? null,
        mode,
        in_reply_to_sid: inReplyToSid ?? null,
        created_at: new Date().toISOString(),
      };
      messages.push(row);
      return { inserted: true, row };
    },

    async updateMessageModeBySid(twilioMessageSid, mode) {
      const row = messages.find((m) => m.twilio_message_sid === twilioMessageSid);
      if (row) row.mode = mode;
    },

    async setMessageSid(id, twilioMessageSid) {
      const row = messages.find((m) => m.id === id);
      if (row) row.twilio_message_sid = twilioMessageSid ?? null;
    },

    async findOutboundForInbound(inboundSid) {
      return (
        messages.find(
          (m) => m.direction === 'outbound' && m.in_reply_to_sid === inboundSid
        ) || null
      );
    },

    async listMessages(senderId) {
      return messages
        .filter((m) => m.sender_id === senderId)
        .map((m) => ({ ...m }))
        .sort((a, b) => a.id - b.id);
    },

    /**
     * @returns {{ inserted: boolean, row: object }}
     */
    async enqueueInbound({ messageSid, senderId, body }) {
      await this.ensureSender(senderId);
      if (bySid.has(messageSid)) {
        const existing = bySid.get(messageSid);
        const logged = messages.find((m) => m.twilio_message_sid === messageSid);
        if (!logged) {
          const session = await this.loadSession(senderId);
          await this.appendMessage({
            senderId,
            direction: 'inbound',
            body: existing.body ?? '',
            twilioMessageSid: messageSid,
            mode: modeFromSessionPreview(session),
          });
        }
        return { inserted: false, row: existing };
      }
      const row = {
        id: nextId++,
        message_sid: messageSid,
        sender_id: senderId,
        body: body ?? '',
        status: 'received',
        error: null,
        reply_sid: null,
        reply_body: null,
        created_at: new Date().toISOString(),
        claimed_at: null,
        finished_at: null,
      };
      inbound.push(row);
      bySid.set(messageSid, row);
      const session = await this.loadSession(senderId);
      await this.appendMessage({
        senderId,
        direction: 'inbound',
        body: body ?? '',
        twilioMessageSid: messageSid,
        mode: modeFromSessionPreview(session),
      });
      return { inserted: true, row };
    },

    async claimNextInbound() {
      const now = Date.now();
      const candidates = inbound
        .filter((r) => {
          if (r.status === 'received') {
            return !senderHasProcessing(r.sender_id);
          }
          if (r.status === 'processing') {
            const stale =
              r.claimed_at &&
              now - new Date(r.claimed_at).getTime() > INBOUND_CLAIM_STALE_MS;
            return Boolean(stale);
          }
          return false;
        })
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
      const next = candidates[0];
      if (!next) return null;
      next.status = 'processing';
      next.claimed_at = new Date().toISOString();
      return { ...next };
    },

    async markInboundDone(id, { replySid, replyBody } = {}) {
      const row = inbound.find((r) => r.id === id);
      if (!row) return;
      row.status = 'done';
      row.reply_sid = replySid ?? null;
      row.reply_body = replyBody ?? null;
      row.finished_at = new Date().toISOString();
      row.error = null;
    },

    async markInboundFailed(id, error) {
      const row = inbound.find((r) => r.id === id);
      if (!row) return;
      row.status = 'failed';
      row.error = String(error || 'failed');
      row.finished_at = new Date().toISOString();
    },

    async markInboundSkipped(id, reason) {
      const row = inbound.find((r) => r.id === id);
      if (!row) return;
      row.status = 'skipped';
      row.error = String(reason || 'skipped');
      row.finished_at = new Date().toISOString();
    },

    async countSenderMessagesSince(senderId, sinceIso) {
      const since = new Date(sinceIso).getTime();
      return inbound.filter(
        (r) => r.sender_id === senderId && new Date(r.created_at).getTime() >= since
      ).length;
    },

    /** Test helpers */
    _dump() {
      return {
        senders: Object.fromEntries(senders),
        profiles: Object.fromEntries(profiles),
        sessions: Object.fromEntries(sessions),
        inbound: inbound.map((r) => ({ ...r })),
        messages: messages.map((m) => ({ ...m })),
        leads: Object.fromEntries(leads),
      };
    },

    _patchInbound(messageSid, patch) {
      const row = inbound.find((r) => r.message_sid === messageSid);
      if (row) Object.assign(row, patch);
      return row;
    },
  };
}
