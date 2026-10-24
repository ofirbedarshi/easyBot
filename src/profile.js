import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'business-profile.json');
const TEST_PROFILES_DIR = path.join(DATA_DIR, 'test-profiles');

const TEXT_FACT_KEYS = [
  'name',
  'whatWeDo',
  'ownerGoal',
  'hours',
  'locationOrArea',
  'tone',
];

export function defaultProfilePath() {
  return PROFILE_PATH;
}

/** Per-fixture profile file for isolated adaptive e2e sessions. */
export function testProfilePath(sessionKey) {
  return path.join(TEST_PROFILES_DIR, `${sessionKey}.json`);
}

/**
 * FAQ item shape: { question, answer }.
 * Legacy bare strings become { question, answer: '' }.
 */
export function normalizeFaqItem(item) {
  if (item == null) return null;
  if (typeof item === 'string') {
    const q = item.trim();
    if (!q) return null;
    return { question: q, answer: '' };
  }
  if (typeof item === 'object') {
    const question = String(item.question ?? item.q ?? '').trim();
    const answer = String(item.answer ?? item.a ?? '').trim();
    if (!question && !answer) return null;
    return {
      question: question || '(untitled)',
      answer,
    };
  }
  return null;
}

export function normalizeCommonQuestions(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeFaqItem).filter(Boolean);
}

export function emptyProfile() {
  return {
    name: null,
    whatWeDo: null,
    /**
     * Outcome the owner wants the customer bot to achieve.
     * null = not clarified yet — never invent a goal in app code.
     */
    ownerGoal: null,
    services: [],
    hours: null,
    locationOrArea: null,
    /** FAQ: [{ question, answer }] — answer is what the Business Bot may tell customers. */
    commonQuestions: [],
    /**
     * What the Business Bot should ask the customer for.
     * null = owner not asked yet; [] = collect nothing; non-empty = items to ask.
     */
    informationToCollect: null,
    /** Explicit gaps the owner left undecided or unclarified (must stay unknown until approved). */
    unknowns: [],
    tone: null,
    approvedAt: null,
    chatflowId: null,
    /** Set only after Flowise create/update succeeds for the current approval. */
    flowiseSyncedAt: null,
    /** App gate for /test: true only after a successful Flowise sync. */
    flowiseSyncOk: false,
    /**
     * True while approved facts await background Flowise sync (cold start / 502).
     * Cleared on success or after sync worker gives up.
     */
    flowiseSyncPending: false,
    /** ISO time when pending sync was requested (wake + retry window). */
    flowiseSyncRequestedAt: null,
    draft: null,
  };
}

function normalizeProfileFaq(profile) {
  profile.commonQuestions = normalizeCommonQuestions(profile.commonQuestions);
  if (profile.draft && typeof profile.draft === 'object') {
    if (Array.isArray(profile.draft.commonQuestions)) {
      profile.draft.commonQuestions = normalizeCommonQuestions(
        profile.draft.commonQuestions
      );
    }
  }
  return profile;
}

export function loadProfile(profilePath = PROFILE_PATH) {
  const filePath = profilePath || PROFILE_PATH;
  if (!fs.existsSync(filePath)) {
    return emptyProfile();
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const profile = normalizeProfileFaq({ ...emptyProfile(), ...parsed });
  // Pre-flag profiles that already have a chatflow were syncable; allow /test
  if (
    parsed.flowiseSyncOk === undefined &&
    profile.chatflowId &&
    profile.approvedAt
  ) {
    profile.flowiseSyncOk = true;
  }
  return profile;
}

export function saveProfile(profile, profilePath = PROFILE_PATH) {
  const filePath = profilePath || PROFILE_PATH;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf8');
  return profile;
}

export function mergeDraft(profile, draft) {
  const next = { ...profile };
  if (!draft || typeof draft !== 'object') return next;

  for (const key of TEXT_FACT_KEYS) {
    if (draft[key] != null && draft[key] !== '') next[key] = draft[key];
  }
  if (Array.isArray(draft.services)) next.services = draft.services;
  if (Array.isArray(draft.commonQuestions)) {
    next.commonQuestions = normalizeCommonQuestions(draft.commonQuestions);
  }
  if (Array.isArray(draft.informationToCollect)) {
    next.informationToCollect = draft.informationToCollect;
  }
  if (Array.isArray(draft.unknowns)) next.unknowns = draft.unknowns;
  return next;
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

/** True when draft would change live approved facts after merge. */
export function draftDiffersFromLive(profile, draft) {
  if (!draft || typeof draft !== 'object') return false;
  const merged = mergeDraft(profile, draft);
  for (const key of TEXT_FACT_KEYS) {
    if ((merged[key] || null) !== (profile[key] || null)) return true;
  }
  if (stableJson(merged.services || []) !== stableJson(profile.services || [])) {
    return true;
  }
  if (
    stableJson(normalizeCommonQuestions(merged.commonQuestions)) !==
    stableJson(normalizeCommonQuestions(profile.commonQuestions))
  ) {
    return true;
  }
  if (
    stableJson(merged.informationToCollect ?? null) !==
    stableJson(profile.informationToCollect ?? null)
  ) {
    return true;
  }
  if (stableJson(merged.unknowns || []) !== stableJson(profile.unknowns || [])) {
    return true;
  }
  return false;
}

function formatFactsBlock(profile) {
  const lines = [];
  lines.push(`Business: ${profile.name || '(not set)'}`);
  lines.push(`What they do: ${profile.whatWeDo || '(not set)'}`);
  lines.push(`Owner goal: ${profile.ownerGoal || '(not set)'}`);
  if (profile.services?.length) {
    lines.push('Services:');
    for (const s of profile.services) {
      const price = s.price != null ? ` — ${s.price}` : '';
      const notes = s.notes ? ` (${s.notes})` : '';
      lines.push(`  • ${s.name || 'Unnamed'}${price}${notes}`);
    }
  } else {
    lines.push('Services: (none yet)');
  }
  lines.push(`Hours: ${profile.hours || '(not set)'}`);
  lines.push(`Location / area: ${profile.locationOrArea || '(not set)'}`);
  lines.push(`Tone: ${profile.tone || '(not set)'}`);
  if (profile.commonQuestions?.length) {
    lines.push('Common questions (FAQ — answers the customer bot may use):');
    for (const q of profile.commonQuestions) {
      const faq = normalizeFaqItem(q);
      if (!faq) continue;
      lines.push(`  • Q: ${faq.question}`);
      lines.push(
        faq.answer
          ? `    A: ${faq.answer}`
          : '    A: (not recorded yet — bot cannot invent this)'
      );
    }
  }
  if (Array.isArray(profile.informationToCollect)) {
    if (profile.informationToCollect.length) {
      lines.push('Information the bot should collect:');
      for (const item of profile.informationToCollect) {
        lines.push(`  • ${item}`);
      }
    } else {
      lines.push('Information the bot should collect: (none)');
    }
  }
  if (profile.unknowns?.length) {
    lines.push('Explicitly unknown / undecided (bot must not invent these):');
    for (const u of profile.unknowns) lines.push(`  • ${u}`);
  }
  return lines.join('\n');
}

/**
 * Owner-facing summary. When already approved and draft differs from live,
 * shows Live vs Pending so unapproved edits are not mistaken for the active bot.
 */
export function formatSummary(profile) {
  const draft = profile?.draft;
  if (
    profile?.approvedAt &&
    draft &&
    draftDiffersFromLive(profile, draft)
  ) {
    const pending = mergeDraft(profile, draft);
    return [
      'Live approved (active customer bot):',
      formatFactsBlock(profile),
      '',
      'Pending (not live until you approve):',
      formatFactsBlock(pending),
    ].join('\n');
  }
  const view = draft ? mergeDraft(profile, draft) : profile;
  return formatFactsBlock(view || emptyProfile());
}

export function hasEnoughForFirstBot(profile) {
  const hasIdentity = !!(profile.name || profile.whatWeDo);
  const hasOffering =
    (profile.services && profile.services.length > 0) || !!profile.whatWeDo;
  return hasIdentity && hasOffering;
}
