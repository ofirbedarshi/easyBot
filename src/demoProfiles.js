/**
 * Pre-built demo profiles: lookup, claim, and create-demo helpers.
 * Binding is first-wake only. No keyword matching of owner free text
 * except DEMO_CODE_RE.
 */

import crypto from 'crypto';
import { applyBuilderModelOutput } from './applyExtraction.js';
import { DEMO_INTRO } from './copy.js';
import { E164_RE, phoneE164FromSenderId } from './phone.js';
import {
  applyDraftToLive,
  emptyProfile,
  formatSummary,
  hasEnoughForFirstBot,
  withKnownProfileKeys,
} from './profile.js';

/** First inbound must match this exactly (after trim) to use the code fallback. */
export const DEMO_CODE_RE = /^hi adam code-([A-Z0-9]{8,})$/i;

/** Unambiguous alphabet: no 0/O, 1/I/L. */
export const DEMO_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const DEMO_WA_ME_NUMBER = '17623205871';

const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function parseDemoCode(text) {
  const m = DEMO_CODE_RE.exec(String(text || '').trim());
  return m ? String(m[1]).toUpperCase() : null;
}

/**
 * Strip formatting and require a real E.164. No country guessing.
 * @param {string} raw
 * @returns {string|null} +E.164 or null
 */
export function normalizeBusinessPhone(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (s.toLowerCase().startsWith('whatsapp:')) s = s.slice('whatsapp:'.length).trim();
  s = s.replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (!s.startsWith('+') && /^[1-9][0-9]{7,14}$/.test(s)) s = `+${s}`;
  return E164_RE.test(s) ? s : null;
}

export function generateDemoCode(length = 8) {
  const n = Math.max(8, Number(length) || 8);
  const alphabet = DEMO_CODE_ALPHABET;
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

export function fallbackWaLink(code) {
  const token = encodeURIComponent(`Hi Adam code-${String(code || '').toUpperCase()}`);
  return `https://wa.me/${DEMO_WA_ME_NUMBER}?text=${token}`;
}

export function defaultDemoExpiresAt(now = new Date()) {
  return new Date(now.getTime() + DEFAULT_TTL_MS).toISOString();
}

export function isClaimableDemo(row, now = new Date()) {
  if (!row) return false;
  if (row.claimed_by != null) return false;
  if (row.reviewed_at == null) return false;
  const expires = new Date(row.expires_at).getTime();
  return Number.isFinite(expires) && expires > now.getTime();
}

export function isFreshOwnerProfile(profile) {
  if (!profile) return true;
  if (profile.approvedAt) return false;
  if (String(profile.name || '').trim()) return false;
  if (String(profile.whatWeDo || '').trim()) return false;
  if (Array.isArray(profile.services) && profile.services.length > 0) return false;
  return true;
}

export async function isDemoBindEligible(session) {
  if (!session?.store || !session.senderId) return false;
  if (session.demoBindEligible) return true;
  if (typeof session.store.listMessages !== 'function') return false;
  const msgs = await session.store.listMessages(session.senderId);
  return msgs.filter((m) => m.direction === 'inbound').length === 1;
}

/**
 * Phone match first, then exact code. Lookups ignore expired / claimed / unreviewed.
 */
export async function findClaimableDemo(store, senderId, text) {
  if (!store) return null;
  const phone = phoneE164FromSenderId(senderId);
  if (phone && typeof store.findClaimableDemoByPhone === 'function') {
    const byPhone = await store.findClaimableDemoByPhone(phone);
    if (byPhone) return byPhone;
  }
  const code = parseDemoCode(text);
  if (code && typeof store.findClaimableDemoByCode === 'function') {
    return store.findClaimableDemoByCode(code);
  }
  return null;
}

export function prefixDemoIntro(enterTestResult) {
  const chrome = enterTestResult.replies?.length
    ? enterTestResult.replies
    : [enterTestResult.reply].filter(Boolean);
  const replies = [DEMO_INTRO, ...chrome];
  return {
    ...enterTestResult,
    reply: replies.join('\n\n'),
    replies,
  };
}

export function profileFromBuilderTurn(turn, live = emptyProfile()) {
  const parsed = turn?.modelJson
    ? turn.modelJson
    : {
        draft: turn?.draft,
        newFacts: turn?.newFacts || [],
        ownerEdits: turn?.ownerEdits || [],
        factEdits: turn?.factEdits || [],
        resolvedUnknowns: turn?.resolvedUnknowns || [],
      };
  const draft = turn?.draft
    ? turn.draft
    : applyBuilderModelOutput(parsed, live.draft, { mode: 'delta', live });
  const profile = withKnownProfileKeys({ ...live, draft });
  profile.draft = draft;
  applyDraftToLive(profile);
  return profile;
}

/**
 * Run existing Builder extraction on pasted public site text. No scraping.
 */
export async function extractDemoProfile({
  siteText,
  sourceUrl,
  runBuilderTurn,
} = {}) {
  const text = String(siteText || '').trim();
  if (!text) {
    throw new Error('extractDemoProfile: site text is empty');
  }
  const live = emptyProfile();
  const userMessage = sourceUrl
    ? `Public text from our website (${sourceUrl}):\n\n${text}`
    : text;
  const turn = await runBuilderTurn({
    buildHistory: [],
    profile: live,
    userMessage,
  });
  if (turn?.onPurpose === false) {
    throw new Error('extractDemoProfile: Builder treated the text as off-purpose');
  }
  const profile = profileFromBuilderTurn(turn, live);
  return { profile, turn, summary: formatSummary(profile) };
}

export function assertDemoReady(profile) {
  if (!hasEnoughForFirstBot(profile)) {
    throw new Error(
      'Demo profile needs a business name and what you do (or a service) before it can enter TEST'
    );
  }
}

export function reviewedDemoRecord({
  businessLabel,
  businessPhone,
  sourceUrl,
  profile,
  code,
  prospectId,
  now = new Date(),
} = {}) {
  const phone =
    businessPhone == null || String(businessPhone).trim() === ''
      ? null
      : normalizeBusinessPhone(businessPhone);
  assertDemoReady(profile);
  const approved = withKnownProfileKeys(profile);
  if (!approved.approvedAt) approved.approvedAt = now.toISOString();
  const trimmedProspect =
    prospectId == null || String(prospectId).trim() === ''
      ? null
      : String(prospectId).trim();
  return {
    business_label: String(businessLabel || '').trim(),
    prospect_id: trimmedProspect,
    business_phone: phone,
    code: String(code || generateDemoCode()).toUpperCase(),
    profile: approved,
    source_url: sourceUrl || null,
    reviewed_at: now.toISOString(),
    expires_at: defaultDemoExpiresAt(now),
  };
}
