/**
 * In-memory store for mocked WhatsApp tests (no Supabase / Twilio network).
 */

import crypto from 'crypto';
import { emptyProfile } from '../profile.js';
import { phoneE164FromSenderId } from '../phone.js';
import { modeFromSessionPreview } from '../conversationLog.js';
import { buildUserDetail, buildUserRow } from '../admin/users.js';
import { defaultDemoExpiresAt, isClaimableDemo } from '../demoProfiles.js';

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
  /** @type {Map<string, object>} */
  const demos = new Map();
  /** @type {Map<string, object>} */
  const clients = new Map();
  let nextId = 1;
  let nextMessageId = 1;

  function senderHasProcessing(senderId) {
    return inbound.some((p) => p.sender_id === senderId && p.status === 'processing');
  }

  return {
    kind: 'memory',

    async hasSender(senderId) {
      return senders.has(senderId);
    },

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
          testCustomerCount: 0,
          leadIntake: null,
          reviewChats: null,
          ownerName: null,
          demoOrigin: false,
          clientId: null,
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
        testCustomerCount: session.testCustomerCount ?? 0,
        leadIntake: structuredClone(session.leadIntake ?? null),
        reviewChats: structuredClone(session.reviewChats ?? null),
        ownerName: session.ownerName ?? null,
        demoOrigin: session.demoOrigin === true,
        clientId: session.clientId ?? null,
      });
    },

    /** One lead per sender; a second save keeps the first. */
    async saveLead(senderId, lead) {
      await this.ensureSender(senderId);
      if (!leads.has(senderId)) leads.set(senderId, structuredClone(lead));
    },

    async deleteLead(senderId) {
      leads.delete(senderId);
    },

    async appendMessage({
      senderId,
      direction,
      body,
      twilioMessageSid,
      mode,
      inReplyToSid,
      createdAt,
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
        created_at: createdAt || new Date().toISOString(),
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

    async findOutboundsForInbound(inboundSid) {
      return messages
        .filter((m) => m.direction === 'outbound' && m.in_reply_to_sid === inboundSid)
        .sort((a, b) => a.id - b.id);
    },

    async findOutboundForInbound(inboundSid) {
      const rows = await this.findOutboundsForInbound(inboundSid);
      return rows[0] || null;
    },

    async listMessages(senderId) {
      return messages
        .filter((m) => m.sender_id === senderId)
        .map((m) => ({ ...m }))
        .sort((a, b) => a.id - b.id);
    },

    async listAdminUsers() {
      const rows = [];
      for (const [senderId, sender] of senders) {
        rows.push(
          buildUserRow({
            sender,
            profile: profiles.get(senderId) || emptyProfile(),
            session: sessions.get(senderId) || null,
            lead: leads.get(senderId) || null,
            messages: messages.filter((m) => m.sender_id === senderId),
          })
        );
      }
      return rows;
    },

    async getAdminUser(senderId) {
      const sender = senders.get(senderId);
      if (!sender) return null;
      return buildUserDetail({
        sender,
        profile: profiles.get(senderId) || emptyProfile(),
        session: sessions.get(senderId) || null,
        lead: leads.get(senderId) || null,
        messages: messages
          .filter((m) => m.sender_id === senderId)
          .slice()
          .sort((a, b) => a.id - b.id),
      });
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

    async insertDemo(row) {
      const id = row.id || crypto.randomUUID();
      const code = String(row.code || '').toUpperCase();
      if (!code) throw new Error('insertDemo: code required');
      const prospectId =
        row.prospect_id == null || String(row.prospect_id).trim() === ''
          ? null
          : String(row.prospect_id).trim();
      for (const existing of demos.values()) {
        if (existing.code === code) throw new Error('insertDemo: code already exists');
        if (
          row.business_phone &&
          existing.business_phone &&
          existing.business_phone === row.business_phone
        ) {
          throw new Error('insertDemo: business_phone already exists');
        }
        if (prospectId && existing.prospect_id && existing.prospect_id === prospectId) {
          throw new Error('insertDemo: prospect_id already exists');
        }
      }
      const rec = {
        id,
        business_label: row.business_label,
        prospect_id: prospectId,
        business_phone: row.business_phone ?? null,
        code,
        profile: structuredClone(row.profile),
        owner_name: row.owner_name ?? null,
        source_url: row.source_url ?? null,
        reviewed_at: row.reviewed_at ?? null,
        created_at: row.created_at || new Date().toISOString(),
        expires_at: row.expires_at || defaultDemoExpiresAt(),
        claimed_by: row.claimed_by ?? null,
        claimed_at: row.claimed_at ?? null,
      };
      demos.set(id, rec);
      return structuredClone(rec);
    },

    async findClaimableDemoByPhone(phone) {
      for (const row of demos.values()) {
        if (row.business_phone === phone && isClaimableDemo(row)) {
          return structuredClone(row);
        }
      }
      return null;
    },

    async findClaimableDemoByCode(code) {
      const needle = String(code || '').toUpperCase();
      for (const row of demos.values()) {
        if (row.code === needle && isClaimableDemo(row)) {
          return structuredClone(row);
        }
      }
      return null;
    },

    async claimDemo(id, claimedBy) {
      const row = demos.get(id);
      if (!row || !isClaimableDemo(row)) return null;
      row.claimed_by = claimedBy;
      row.claimed_at = new Date().toISOString();
      return structuredClone(row);
    },

    async findDemoByProspectId(prospectId) {
      const needle = String(prospectId || '').trim();
      if (!needle) return null;
      for (const row of demos.values()) {
        if (row.prospect_id === needle) return structuredClone(row);
      }
      return null;
    },

    async findDemoByCode(code) {
      const needle = String(code || '').toUpperCase();
      if (!needle) return null;
      for (const row of demos.values()) {
        if (row.code === needle) return structuredClone(row);
      }
      return null;
    },

    async findDemoByPhone(phone) {
      if (!phone) return null;
      for (const row of demos.values()) {
        if (row.business_phone === phone) return structuredClone(row);
      }
      return null;
    },

    async countSenderDelete(senderId) {
      return {
        easybot_senders: senders.has(senderId) ? 1 : 0,
        easybot_business_profiles: profiles.has(senderId) ? 1 : 0,
        easybot_sessions: sessions.has(senderId) ? 1 : 0,
        easybot_messages: messages.filter((m) => m.sender_id === senderId).length,
        easybot_inbound_messages: inbound.filter((r) => r.sender_id === senderId).length,
        easybot_leads: leads.has(senderId) ? 1 : 0,
      };
    },

    async deleteSenderData(senderId) {
      const counts = {
        easybot_messages: 0,
        easybot_inbound_messages: 0,
        easybot_leads: 0,
        easybot_sessions: 0,
        easybot_business_profiles: 0,
        easybot_senders: 0,
      };
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].sender_id === senderId) {
          messages.splice(i, 1);
          counts.easybot_messages += 1;
        }
      }
      for (let i = inbound.length - 1; i >= 0; i--) {
        if (inbound[i].sender_id === senderId) {
          bySid.delete(inbound[i].message_sid);
          inbound.splice(i, 1);
          counts.easybot_inbound_messages += 1;
        }
      }
      if (leads.delete(senderId)) counts.easybot_leads = 1;
      if (sessions.delete(senderId)) counts.easybot_sessions = 1;
      if (profiles.delete(senderId)) counts.easybot_business_profiles = 1;
      if (senders.delete(senderId)) counts.easybot_senders = 1;
      return counts;
    },

    async insertClient(row) {
      const id = row.id || crypto.randomUUID();
      const code = String(row.code || '').toUpperCase();
      if (!code) throw new Error('insertClient: code required');
      for (const existing of clients.values()) {
        if (existing.code === code) throw new Error('insertClient: code already exists');
      }
      const rec = {
        id,
        name: row.name ?? null,
        business_name: row.business_name,
        contact_channel: row.contact_channel ?? null,
        status: row.status,
        code,
        profile: structuredClone(row.profile),
        notes: row.notes ?? null,
        created_at: row.created_at || new Date().toISOString(),
      };
      clients.set(id, rec);
      return structuredClone(rec);
    },

    async findClientByCode(code) {
      const needle = String(code || '').toUpperCase();
      if (!needle) return null;
      for (const row of clients.values()) {
        if (row.code === needle) return structuredClone(row);
      }
      return null;
    },

    async findClientById(id) {
      if (!id) return null;
      const row = clients.get(id);
      return row ? structuredClone(row) : null;
    },

    async deleteDemo(id) {
      if (!demos.has(id)) return 0;
      demos.delete(id);
      return 1;
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
        demos: Object.fromEntries(demos),
        clients: Object.fromEntries(clients),
      };
    },

    _patchInbound(messageSid, patch) {
      const row = inbound.find((r) => r.message_sid === messageSid);
      if (row) Object.assign(row, patch);
      return row;
    },
  };
}
