/** Furthest-only funnel stage for the admin list. */

export const STAGE_ORDER = ['building', 'approved', 'tried', 'lead'];

export const STAGE_LABELS = {
  building: 'Building',
  approved: 'Bot approved',
  tried: 'Tried the bot',
  lead: 'Lead',
};

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || STAGE_LABELS.building;
}

export function deriveStage({ hasLead, approvedAt, triedBot: tried }) {
  if (hasLead) return 'lead';
  if (tried) return 'tried';
  if (approvedAt) return 'approved';
  return 'building';
}

export function triedBot({ messages, session }) {
  if (session?.mode === 'TEST') return true;
  if (Array.isArray(session?.testHistory) && session.testHistory.length > 0) {
    return true;
  }
  if (Array.isArray(messages) && messages.some((m) => m.mode === 'test')) {
    return true;
  }
  return false;
}

export function businessNameFrom(profile, lead) {
  const draftName = trimOrNull(profile?.draft?.name);
  if (draftName) return draftName;
  const liveName = trimOrNull(profile?.name);
  if (liveName) return liveName;
  const leadName = trimOrNull(lead?.businessName ?? lead?.business_name);
  return leadName;
}

function trimOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
}
