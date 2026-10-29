/**
 * Shared client profiles: first-wake bind by exact bot-XXXXXXXX.
 * No claim, no expiry. One code can be used by many leads.
 */

import { DEMO_CODE_ALPHABET, DEMO_WA_ME_NUMBER, generateDemoCode } from './demoProfiles.js';
import { emptyProfile, withKnownProfileKeys } from './profile.js';

/** First inbound must match this exactly (after trim). Distinct from DEMO_CODE_RE. */
export const CLIENT_CODE_RE = /^bot-([A-Z0-9]{8})$/i;

export const CLIENT_STATUSES = Object.freeze(['lead', 'demo', 'trial']);

export function parseClientCode(text) {
  const m = CLIENT_CODE_RE.exec(String(text || '').trim());
  return m ? String(m[1]).toUpperCase() : null;
}

export function generateClientCode() {
  return generateDemoCode(8);
}

export function clientWaLink(code) {
  const token = encodeURIComponent(`bot-${String(code || '').toUpperCase()}`);
  return `https://wa.me/${DEMO_WA_ME_NUMBER}?text=${token}`;
}

export function formatClientCode(code) {
  return `bot-${String(code || '').toUpperCase()}`;
}

export function normalizeClientStatus(raw) {
  const status = String(raw || 'lead').trim().toLowerCase();
  return CLIENT_STATUSES.includes(status) ? status : null;
}

export function clientProfileFromRow(row) {
  return withKnownProfileKeys(row?.profile || emptyProfile());
}

export function clientRecord({
  name,
  businessName,
  contactChannel,
  status,
  profile,
  notes,
  code,
} = {}) {
  const business = String(businessName || '').trim();
  if (!business) throw new Error('clientRecord: business_name is required');
  const normalizedStatus = normalizeClientStatus(status);
  if (!normalizedStatus) {
    throw new Error(`clientRecord: status must be one of ${CLIENT_STATUSES.join(', ')}`);
  }
  const next = withKnownProfileKeys(profile || emptyProfile());
  if (!String(next.name || '').trim()) next.name = business;
  const token = String(code || generateClientCode()).toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(token)) {
    throw new Error('clientRecord: code must be 8 letters or digits');
  }
  return {
    name: name == null || String(name).trim() === '' ? null : String(name).trim(),
    business_name: business,
    contact_channel:
      contactChannel == null || String(contactChannel).trim() === ''
        ? null
        : String(contactChannel).trim(),
    status: normalizedStatus,
    code: token,
    profile: next,
    notes: notes == null || String(notes).trim() === '' ? null : String(notes).trim(),
  };
}
