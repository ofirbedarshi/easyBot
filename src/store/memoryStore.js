/**
 * In-memory store for mocked WhatsApp tests (no Supabase / Twilio network).
 */

import { emptyProfile } from '../profile.js';

export function createMemoryStore() {
  /** @type {Map<string, object>} */
  const profiles = new Map();
  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** @type {Map<string, object>} */
  const bySid = new Map();
  /** @type {object[]} */
  const inbound = [];
  /** @type {Map<string, object>} */
  const leads = new Map();
  let nextId = 1;

  return {
    kind: 'memory',

    async ensureSender(senderId) {
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

    /**
     * @returns {{ inserted: boolean, row: object }}
     */
    async enqueueInbound({ messageSid, senderId, body }) {
      await this.ensureSender(senderId);
      if (bySid.has(messageSid)) {
        return { inserted: false, row: bySid.get(messageSid) };
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
      return { inserted: true, row };
    },

    async claimNextInbound() {
      const processingSenders = new Set(
        inbound.filter((r) => r.status === 'processing').map((r) => r.sender_id)
      );
      const next = inbound
        .filter((r) => r.status === 'received' && !processingSenders.has(r.sender_id))
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
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

    /** Profiles waiting for background Flowise sync after Approve. */
    async listPendingFlowiseSyncs() {
      const out = [];
      for (const [senderId, profile] of profiles.entries()) {
        if (profile?.flowiseSyncPending && profile?.approvedAt) {
          out.push({ senderId, profile: structuredClone(profile) });
        }
      }
      return out;
    },

    /** Test helpers */
    _dump() {
      return {
        profiles: Object.fromEntries(profiles),
        sessions: Object.fromEntries(sessions),
        inbound: inbound.map((r) => ({ ...r })),
        leads: Object.fromEntries(leads),
      };
    },
  };
}
