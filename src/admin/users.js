import { formatSummary, withKnownProfileKeys } from '../profile.js';
import { businessNameFrom, deriveStage, triedBot } from './stage.js';

export const USER_LIST_CAP = 200;
export const MESSAGE_CAP = 2000;

function sortMessagesOldestFirst(messages) {
  return (messages || []).slice().sort((a, b) => {
    const ta = String(a.created_at || '');
    const tb = String(b.created_at || '');
    if (ta !== tb) return ta.localeCompare(tb);
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

export function buildUserRow({ sender, profile, session, lead, messages }) {
  const prof = withKnownProfileKeys(profile || {});
  const hasLead = !!lead;
  const stage = deriveStage({
    hasLead,
    approvedAt: prof.approvedAt,
    triedBot: triedBot({ messages, session }),
  });
  const ordered = sortMessagesOldestFirst(messages);
  const last = ordered[ordered.length - 1] || null;
  return {
    senderId: sender.id,
    phoneE164: sender.phoneE164 || sender.phone_e164 || null,
    firstSeenAt: sender.createdAt || sender.created_at || null,
    lastMessageAt: last?.created_at || null,
    lastMessagePreview: last ? String(last.body ?? '').trim() : '',
    messageCount: ordered.length,
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
  let messages = sortMessagesOldestFirst(args.messages).map((m) => ({
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
    profile: prof,
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
