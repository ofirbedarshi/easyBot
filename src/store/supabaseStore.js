/**
 * Supabase-backed store for WhatsApp senders (service role, server-only).
 */

import { createClient } from '@supabase/supabase-js';
import {
  emptyProfile,
  withKnownProfileKeys,
  normalizeBehaviorSettings,
  normalizeCommonQuestions,
} from '../profile.js';
import { phoneE164FromSenderId } from '../phone.js';
import { modeFromSessionPreview } from '../conversationLog.js';
import { buildUserDetail, buildUserRow } from '../admin/users.js';

export function isSupabaseConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function isMissingOwnerNameColumn(error) {
  const code = error?.code;
  const msg = String(error?.message || '');
  return code === '42703' || /owner_name/i.test(msg);
}

export function createSupabaseStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  }
  const sb = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    kind: 'supabase',
    client: sb,

    async ensureSender(senderId) {
      const phoneE164 = phoneE164FromSenderId(senderId);
      if (!phoneE164) {
        throw new Error('ensureSender: invalid sender phone');
      }
      const { error } = await sb.from('easybot_senders').upsert(
        {
          id: senderId,
          phone_e164: phoneE164,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' }
      );
      if (error) throw new Error(`ensureSender: ${error.message}`);

      const { data: sess } = await sb
        .from('easybot_sessions')
        .select('sender_id')
        .eq('sender_id', senderId)
        .maybeSingle();
      if (!sess) {
        const { error: sErr } = await sb.from('easybot_sessions').insert({
          sender_id: senderId,
          mode: 'BUILD',
          build_history: [],
          test_history: [],
          test_session_id: `test-${Date.now()}`,
        });
        if (sErr && sErr.code !== '23505') {
          throw new Error(`ensureSession: ${sErr.message}`);
        }
      }

      const { data: prof } = await sb
        .from('easybot_business_profiles')
        .select('sender_id')
        .eq('sender_id', senderId)
        .maybeSingle();
      if (!prof) {
        const { error: pErr } = await sb.from('easybot_business_profiles').insert({
          sender_id: senderId,
          profile: emptyProfile(),
        });
        if (pErr && pErr.code !== '23505') {
          throw new Error(`ensureProfile: ${pErr.message}`);
        }
      }
    },

    async loadProfile(senderId) {
      await this.ensureSender(senderId);
      const { data, error } = await sb
        .from('easybot_business_profiles')
        .select('profile')
        .eq('sender_id', senderId)
        .single();
      if (error) throw new Error(`loadProfile: ${error.message}`);
      const parsed = data.profile || {};
      const profile = normalizeBehaviorSettings(withKnownProfileKeys(parsed));
      profile.commonQuestions = normalizeCommonQuestions(
        profile.commonQuestions
      );
      if (profile.draft && Array.isArray(profile.draft.commonQuestions)) {
        profile.draft.commonQuestions = normalizeCommonQuestions(
          profile.draft.commonQuestions
        );
      }
      return profile;
    },

    async saveProfile(senderId, profile) {
      await this.ensureSender(senderId);
      const toSave = { ...profile };
      toSave.commonQuestions = normalizeCommonQuestions(
        toSave.commonQuestions
      );
      if (toSave.draft && Array.isArray(toSave.draft.commonQuestions)) {
        toSave.draft = {
          ...toSave.draft,
          commonQuestions: normalizeCommonQuestions(
            toSave.draft.commonQuestions
          ),
        };
      }
      const { error } = await sb
        .from('easybot_business_profiles')
        .update({
          profile: toSave,
          updated_at: new Date().toISOString(),
        })
        .eq('sender_id', senderId);
      if (error) throw new Error(`saveProfile: ${error.message}`);
      return toSave;
    },

    async loadSession(senderId) {
      await this.ensureSender(senderId);
      const { data, error } = await sb
        .from('easybot_sessions')
        .select('*')
        .eq('sender_id', senderId)
        .single();
      if (error) throw new Error(`loadSession: ${error.message}`);
      return {
        mode: data.mode || 'BUILD',
        buildHistory: data.build_history || [],
        testHistory: data.test_history || [],
        testSessionId: data.test_session_id || `test-${Date.now()}`,
        leadIntake: data.lead_intake ?? null,
        ownerName: data.owner_name ?? null,
      };
    },

    async saveSession(senderId, session) {
      await this.ensureSender(senderId);
      const payload = {
        mode: session.mode,
        build_history: session.buildHistory || [],
        test_history: session.testHistory || [],
        test_session_id: session.testSessionId,
        lead_intake: session.leadIntake ?? null,
        owner_name: session.ownerName ?? null,
        updated_at: new Date().toISOString(),
      };
      let { error } = await sb
        .from('easybot_sessions')
        .update(payload)
        .eq('sender_id', senderId);
      if (error && isMissingOwnerNameColumn(error)) {
        delete payload.owner_name;
        ({ error } = await sb
          .from('easybot_sessions')
          .update(payload)
          .eq('sender_id', senderId));
      }
      if (error) throw new Error(`saveSession: ${error.message}`);
    },

    /** One lead per sender (unique sender_id); a duplicate keeps the first. */
    async saveLead(senderId, lead) {
      await this.ensureSender(senderId);
      const { error } = await sb.from('easybot_leads').insert({
        sender_id: senderId,
        business_name: lead.businessName ?? null,
        answers: lead.answers,
        created_at: lead.createdAt,
      });
      if (error && error.code !== '23505') throw new Error(`saveLead: ${error.message}`);
    },

    async deleteLead(senderId) {
      const { error } = await sb.from('easybot_leads').delete().eq('sender_id', senderId);
      if (error) throw new Error(`deleteLead: ${error.message}`);
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
      const { data, error } = await sb
        .from('easybot_messages')
        .insert({
          sender_id: senderId,
          direction,
          body: body ?? '',
          twilio_message_sid: twilioMessageSid ?? null,
          mode,
          in_reply_to_sid: inReplyToSid ?? null,
        })
        .select('*')
        .single();
      if (error) {
        if (error.code === '23505' && twilioMessageSid) {
          const { data: existing } = await sb
            .from('easybot_messages')
            .select('*')
            .eq('twilio_message_sid', twilioMessageSid)
            .single();
          return { inserted: false, row: existing };
        }
        throw new Error(`appendMessage: ${error.message}`);
      }
      return { inserted: true, row: data };
    },

    async updateMessageModeBySid(twilioMessageSid, mode) {
      if (!twilioMessageSid) return;
      const { error } = await sb
        .from('easybot_messages')
        .update({ mode })
        .eq('twilio_message_sid', twilioMessageSid);
      if (error) throw new Error(`updateMessageModeBySid: ${error.message}`);
    },

    async setMessageSid(id, twilioMessageSid) {
      const { error } = await sb
        .from('easybot_messages')
        .update({ twilio_message_sid: twilioMessageSid ?? null })
        .eq('id', id);
      if (error) throw new Error(`setMessageSid: ${error.message}`);
    },

    async findOutboundsForInbound(inboundSid) {
      const { data, error } = await sb
        .from('easybot_messages')
        .select('*')
        .eq('direction', 'outbound')
        .eq('in_reply_to_sid', inboundSid)
        .order('id', { ascending: true });
      if (error) throw new Error(`findOutboundsForInbound: ${error.message}`);
      return data || [];
    },

    async findOutboundForInbound(inboundSid) {
      const rows = await this.findOutboundsForInbound(inboundSid);
      return rows[0] || null;
    },

    async listMessages(senderId) {
      const { data, error } = await sb
        .from('easybot_messages')
        .select('*')
        .eq('sender_id', senderId)
        .order('id', { ascending: true });
      if (error) throw new Error(`listMessages: ${error.message}`);
      return data || [];
    },

    async listAdminUsers() {
      const [sendersRes, profilesRes, sessionsRes, leadsRes, msgsRes] =
        await Promise.all([
          sb.from('easybot_senders').select('id, phone_e164, created_at, updated_at'),
          sb.from('easybot_business_profiles').select('sender_id, profile'),
          sb.from('easybot_sessions').select('sender_id, mode, test_history'),
          sb.from('easybot_leads').select('sender_id, business_name, answers, created_at'),
          sb.from('easybot_messages').select('sender_id, created_at, mode, body'),
        ]);
      for (const [label, res] of [
        ['senders', sendersRes],
        ['profiles', profilesRes],
        ['sessions', sessionsRes],
        ['leads', leadsRes],
        ['messages', msgsRes],
      ]) {
        if (res.error) throw new Error(`listAdminUsers ${label}: ${res.error.message}`);
      }
      const profilesBy = new Map(
        (profilesRes.data || []).map((r) => [r.sender_id, r.profile])
      );
      const sessionsBy = new Map(
        (sessionsRes.data || []).map((r) => [
          r.sender_id,
          { mode: r.mode, testHistory: r.test_history || [] },
        ])
      );
      const leadsBy = new Map(
        (leadsRes.data || []).map((r) => [r.sender_id, r])
      );
      const msgsBy = new Map();
      for (const m of msgsRes.data || []) {
        const list = msgsBy.get(m.sender_id) || [];
        list.push(m);
        msgsBy.set(m.sender_id, list);
      }
      return (sendersRes.data || []).map((sender) =>
        buildUserRow({
          sender,
          profile: profilesBy.get(sender.id) || {},
          session: sessionsBy.get(sender.id) || null,
          lead: leadsBy.get(sender.id) || null,
          messages: msgsBy.get(sender.id) || [],
        })
      );
    },

    async getAdminUser(senderId) {
      const { data: sender, error: sErr } = await sb
        .from('easybot_senders')
        .select('id, phone_e164, created_at, updated_at')
        .eq('id', senderId)
        .maybeSingle();
      if (sErr) throw new Error(`getAdminUser sender: ${sErr.message}`);
      if (!sender) return null;

      const [profRes, sessRes, leadRes, messages] = await Promise.all([
        sb
          .from('easybot_business_profiles')
          .select('profile')
          .eq('sender_id', senderId)
          .maybeSingle(),
        sb
          .from('easybot_sessions')
          .select('mode, test_history, lead_intake')
          .eq('sender_id', senderId)
          .maybeSingle(),
        sb
          .from('easybot_leads')
          .select('sender_id, business_name, answers, created_at')
          .eq('sender_id', senderId)
          .maybeSingle(),
        this.listMessages(senderId),
      ]);
      if (profRes.error) throw new Error(`getAdminUser profile: ${profRes.error.message}`);
      if (sessRes.error) throw new Error(`getAdminUser session: ${sessRes.error.message}`);
      if (leadRes.error) throw new Error(`getAdminUser lead: ${leadRes.error.message}`);

      const sess = sessRes.data;
      return buildUserDetail({
        sender,
        profile: profRes.data?.profile || {},
        session: sess
          ? { mode: sess.mode, testHistory: sess.test_history || [] }
          : null,
        lead: leadRes.data || null,
        messages,
      });
    },

    async enqueueInbound({ messageSid, senderId, body }) {
      await this.ensureSender(senderId);
      const { data, error } = await sb
        .from('easybot_inbound_messages')
        .insert({
          message_sid: messageSid,
          sender_id: senderId,
          body: body ?? '',
          status: 'received',
        })
        .select('*')
        .single();

      if (error) {
        if (error.code === '23505') {
          const { data: existing } = await sb
            .from('easybot_inbound_messages')
            .select('*')
            .eq('message_sid', messageSid)
            .single();
          const session = await this.loadSession(senderId);
          await this.appendMessage({
            senderId,
            direction: 'inbound',
            body: existing?.body ?? body ?? '',
            twilioMessageSid: messageSid,
            mode: modeFromSessionPreview(session),
          });
          return { inserted: false, row: existing };
        }
        throw new Error(`enqueueInbound: ${error.message}`);
      }
      const session = await this.loadSession(senderId);
      await this.appendMessage({
        senderId,
        direction: 'inbound',
        body: body ?? '',
        twilioMessageSid: messageSid,
        mode: modeFromSessionPreview(session),
      });
      return { inserted: true, row: data };
    },

    async claimNextInbound() {
      const { data, error } = await sb.rpc('easybot_claim_next_inbound');
      if (error) throw new Error(`claimNextInbound: ${error.message}`);
      if (!data || (Array.isArray(data) && data.length === 0)) return null;
      return Array.isArray(data) ? data[0] : data;
    },

    async markInboundDone(id, { replySid, replyBody } = {}) {
      const { error } = await sb
        .from('easybot_inbound_messages')
        .update({
          status: 'done',
          reply_sid: replySid ?? null,
          reply_body: replyBody ?? null,
          finished_at: new Date().toISOString(),
          error: null,
        })
        .eq('id', id);
      if (error) throw new Error(`markInboundDone: ${error.message}`);
    },

    async markInboundFailed(id, errMsg) {
      const { error } = await sb
        .from('easybot_inbound_messages')
        .update({
          status: 'failed',
          error: String(errMsg || 'failed'),
          finished_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw new Error(`markInboundFailed: ${error.message}`);
    },

    async markInboundSkipped(id, reason) {
      const { error } = await sb
        .from('easybot_inbound_messages')
        .update({
          status: 'skipped',
          error: String(reason || 'skipped'),
          finished_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw new Error(`markInboundSkipped: ${error.message}`);
    },

    async countSenderMessagesSince(senderId, sinceIso) {
      const { data, error } = await sb.rpc('easybot_sender_message_count', {
        p_sender_id: senderId,
        p_since: sinceIso,
      });
      if (error) throw new Error(`countSenderMessagesSince: ${error.message}`);
      return Number(data) || 0;
    },
  };
}
