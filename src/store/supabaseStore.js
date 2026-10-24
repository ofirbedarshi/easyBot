/**
 * Supabase-backed store for WhatsApp senders (service role, server-only).
 */

import { createClient } from '@supabase/supabase-js';
import { emptyProfile, normalizeCommonQuestions } from '../profile.js';

export function isSupabaseConfigured() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
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
      const { error } = await sb.from('easybot_senders').upsert(
        { id: senderId, updated_at: new Date().toISOString() },
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
      const profile = { ...emptyProfile(), ...parsed };
      profile.commonQuestions = normalizeCommonQuestions(
        profile.commonQuestions
      );
      if (profile.draft && Array.isArray(profile.draft.commonQuestions)) {
        profile.draft.commonQuestions = normalizeCommonQuestions(
          profile.draft.commonQuestions
        );
      }
      if (
        parsed.flowiseSyncOk === undefined &&
        profile.chatflowId &&
        profile.approvedAt
      ) {
        profile.flowiseSyncOk = true;
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
      };
    },

    async saveSession(senderId, session) {
      await this.ensureSender(senderId);
      const { error } = await sb
        .from('easybot_sessions')
        .update({
          mode: session.mode,
          build_history: session.buildHistory || [],
          test_history: session.testHistory || [],
          test_session_id: session.testSessionId,
          updated_at: new Date().toISOString(),
        })
        .eq('sender_id', senderId);
      if (error) throw new Error(`saveSession: ${error.message}`);
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
          return { inserted: false, row: existing };
        }
        throw new Error(`enqueueInbound: ${error.message}`);
      }
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

    /** Profiles waiting for background Flowise sync after Approve. */
    async listPendingFlowiseSyncs() {
      const { data, error } = await sb
        .from('easybot_business_profiles')
        .select('sender_id, profile');
      if (error) throw new Error(`listPendingFlowiseSyncs: ${error.message}`);
      const out = [];
      for (const row of data || []) {
        const profile = row.profile || {};
        if (profile.flowiseSyncPending && profile.approvedAt) {
          out.push({
            senderId: row.sender_id,
            profile: { ...emptyProfile(), ...profile },
          });
        }
      }
      return out;
    },
  };
}
