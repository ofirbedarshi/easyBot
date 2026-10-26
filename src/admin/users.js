import { formatSummary, withKnownProfileKeys } from '../profile.js';
import { businessNameFrom, deriveStage, triedBot } from './stage.js';

export const USER_LIST_CAP = 200;
export const MESSAGE_CAP = 2000;

export function buildUserRow({ sender, profile, session, lead, messages }) {
  const prof = withKnownProfileKeys(profile || {});
  const hasLead = !!lead;
  const stage = deriveStage({
    hasLead,
    approvedAt: prof.approvedAt,
    triedBot: triedBot({ messages, session }),
  });
  const times = (messages || [])
    .map((m) => m.created_at)
    .filter(Boolean)
    .slice()
    .sort();
  return {
    senderId: sender.id,
    phoneE164: sender.phoneE164 || sender.phone_e164 || null,
    firstSeenAt: sender.createdAt || sender.created_at || null,
    lastMessageAt: times.length ? times[times.length - 1] : null,
    messageCount: (messages || []).length,
    businessName: businessNameFrom(prof, lead),
    stage,
    isLead: hasLead,
    approvedAt: prof.approvedAt || null,
  };
}

export function buildUserDetail(args) {
  const row = buildUserRow(args);
  const prof = withKnownProfileKeys(args.profile || {});
  const lead = args.lead
    ? {
        businessName: args.lead.businessName ?? args.lead.business_name ?? null,
        answers: args.lead.answers || {},
        createdAt: args.lead.createdAt ?? args.lead.created_at ?? null,
      }
    : null;
  let messages = (args.messages || []).map((m) => ({
    id: m.id,
    direction: m.direction,
    body: m.body ?? '',
    mode: m.mode,
    createdAt: m.created_at,
  }));
  let truncated = false;
  if (messages.length > MESSAGE_CAP) {
    messages = messages.slice(-MESSAGE_CAP);
    truncated = true;
  }
  return {
    ...row,
    summary: formatSummary(prof),
    lead,
    messages,
    truncated,
  };
}

export function filterUsers(users, { q = '', stage = '' } = {}) {
  const query = String(q || '').trim().toLowerCase();
  const wantStage = String(stage || '').trim();
  return users.filter((u) => {
    if (wantStage && u.stage !== wantStage) return false;
    if (!query) return true;
    const hay = [u.phoneE164, u.businessName, u.senderId]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(query);
  });
}

export function sortUsers(users) {
  return users.slice().sort((a, b) => {
    const ta = a.lastMessageAt || a.firstSeenAt || '';
    const tb = b.lastMessageAt || b.firstSeenAt || '';
    return tb.localeCompare(ta);
  });
}
