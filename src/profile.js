import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'business-profile.json');
const TEST_PROFILES_DIR = path.join(DATA_DIR, 'test-profiles');

/** Business-fact text fields (not conversation settings). */
const TEXT_FACT_KEYS = [
  'name',
  'whatWeDo',
  'ownerGoal',
  'hours',
  'locationOrArea',
];

/** Conversation settings — expression / disclosure, not business facts. */
export const BEHAVIOR_KEYS = ['tone', 'responseLength', 'priceDisclosure'];

export const RESPONSE_LENGTH_VALUES = ['short', 'standard'];
export const PRICE_DISCLOSURE_VALUES = ['relevant', 'on_request'];

/**
 * Effective defaults when a field is null / missing (legacy-safe).
 * Stored values stay null until the owner sets them.
 */
export const DEFAULT_BEHAVIOR = {
  tone: 'friendly, clear, and professional',
  responseLength: 'standard',
  priceDisclosure: 'relevant',
};

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

/** Normalize free-form / enum spelling into a stored responseLength value. */
export function normalizeResponseLength(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (s === 'short' || s === 'brief' || s === 'concise') return 'short';
  if (s === 'standard' || s === 'normal' || s === 'default') return 'standard';
  if (RESPONSE_LENGTH_VALUES.includes(s)) return s;
  return null;
}

/** Normalize free-form / enum spelling into a stored priceDisclosure value. */
export function normalizePriceDisclosure(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (
    s === 'on_request' ||
    s === 'onrequest' ||
    s === 'only_when_asked' ||
    s === 'when_asked' ||
    s === 'ask_only'
  ) {
    return 'on_request';
  }
  if (
    s === 'relevant' ||
    s === 'when_relevant' ||
    s === 'as_relevant' ||
    s === 'useful'
  ) {
    return 'relevant';
  }
  if (PRICE_DISCLOSURE_VALUES.includes(s)) return s;
  return null;
}

/**
 * Drop invalid enum values to null on live profile and draft.
 * Does not invent defaults into stored fields.
 */
export function normalizeBehaviorSettings(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  if (profile.tone != null && typeof profile.tone === 'string') {
    const t = profile.tone.trim();
    profile.tone = t || null;
  } else if (profile.tone !== undefined && profile.tone !== null) {
    profile.tone = String(profile.tone).trim() || null;
  }
  if ('responseLength' in profile || profile.responseLength !== undefined) {
    profile.responseLength = normalizeResponseLength(profile.responseLength);
  }
  if ('priceDisclosure' in profile || profile.priceDisclosure !== undefined) {
    profile.priceDisclosure = normalizePriceDisclosure(profile.priceDisclosure);
  }
  if (profile.draft && typeof profile.draft === 'object') {
    if (profile.draft.tone != null && typeof profile.draft.tone === 'string') {
      const t = profile.draft.tone.trim();
      profile.draft.tone = t || null;
    }
    if ('responseLength' in profile.draft) {
      profile.draft.responseLength = normalizeResponseLength(
        profile.draft.responseLength
      );
    }
    if ('priceDisclosure' in profile.draft) {
      profile.draft.priceDisclosure = normalizePriceDisclosure(
        profile.draft.priceDisclosure
      );
    }
  }
  return profile;
}

/**
 * Effective conversation settings for prompts / judges / summaries.
 * Null stored values resolve to DEFAULT_BEHAVIOR.
 */
export function effectiveBehavior(profile) {
  const p = profile || {};
  const tone =
    typeof p.tone === 'string' && p.tone.trim()
      ? p.tone.trim()
      : DEFAULT_BEHAVIOR.tone;
  const responseLength =
    normalizeResponseLength(p.responseLength) || DEFAULT_BEHAVIOR.responseLength;
  const priceDisclosure =
    normalizePriceDisclosure(p.priceDisclosure) ||
    DEFAULT_BEHAVIOR.priceDisclosure;
  return { tone, responseLength, priceDisclosure };
}

/** Approved business facts only — no conversation settings. */
export function businessFactsView(profile) {
  const p = profile || {};
  return {
    name: p.name ?? null,
    whatWeDo: p.whatWeDo ?? null,
    ownerGoal: p.ownerGoal ?? null,
    services: Array.isArray(p.services) ? p.services : [],
    hours: p.hours ?? null,
    locationOrArea: p.locationOrArea ?? null,
    commonQuestions: normalizeCommonQuestions(p.commonQuestions),
    informationToCollect: Array.isArray(p.informationToCollect)
      ? p.informationToCollect
      : p.informationToCollect === null
        ? null
        : [],
    unknowns: Array.isArray(p.unknowns) ? p.unknowns : [],
  };
}

/** Conversation settings view (effective values) for judges / prompts. */
export function behaviorSettingsView(profile) {
  return effectiveBehavior(profile);
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
    /** Free-text how the bot should sound. null = use DEFAULT_BEHAVIOR.tone. */
    tone: null,
    /**
     * Reply length setting: 'short' | 'standard' | null.
     * null = use DEFAULT_BEHAVIOR.responseLength ('standard').
     */
    responseLength: null,
    /**
     * Price disclosure: 'relevant' | 'on_request' | null.
     * null = use DEFAULT_BEHAVIOR.priceDisclosure ('relevant').
     */
    priceDisclosure: null,
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
  const profile = normalizeBehaviorSettings(
    normalizeProfileFaq({ ...emptyProfile(), ...parsed })
  );
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
  for (const key of BEHAVIOR_KEYS) {
    if (key === 'tone') {
      if (draft.tone != null && draft.tone !== '') next.tone = draft.tone;
    } else if (key === 'responseLength') {
      const n = normalizeResponseLength(draft.responseLength);
      if (n != null) next.responseLength = n;
    } else if (key === 'priceDisclosure') {
      const n = normalizePriceDisclosure(draft.priceDisclosure);
      if (n != null) next.priceDisclosure = n;
    }
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

/** True when draft would change live approved facts or behavior after merge. */
export function draftDiffersFromLive(profile, draft) {
  if (!draft || typeof draft !== 'object') return false;
  const merged = mergeDraft(profile, draft);
  for (const key of TEXT_FACT_KEYS) {
    if ((merged[key] || null) !== (profile[key] || null)) return true;
  }
  const liveB = effectiveBehavior(profile);
  const mergedB = effectiveBehavior(merged);
  if (liveB.tone !== mergedB.tone) return true;
  if (liveB.responseLength !== mergedB.responseLength) return true;
  if (liveB.priceDisclosure !== mergedB.priceDisclosure) return true;
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

function formatResponseLengthLabel(value, isDefault) {
  const v = value || DEFAULT_BEHAVIOR.responseLength;
  const label = v === 'short' ? 'short' : 'standard';
  return isDefault ? `${label} (default)` : label;
}

function formatPriceDisclosureLabel(value, isDefault) {
  const v = value || DEFAULT_BEHAVIOR.priceDisclosure;
  const label =
    v === 'on_request'
      ? 'only when the customer asks about pricing'
      : 'when useful and relevant';
  return isDefault ? `${label} (default)` : label;
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

  const storedTone = profile.tone;
  const storedLen = normalizeResponseLength(profile.responseLength);
  const storedPrice = normalizePriceDisclosure(profile.priceDisclosure);
  const eff = effectiveBehavior(profile);
  lines.push('Conversation settings:');
  lines.push(
    `  Tone: ${storedTone ? storedTone : `${eff.tone} (default)`}`
  );
  lines.push(
    `  Reply length: ${formatResponseLengthLabel(eff.responseLength, !storedLen)}`
  );
  lines.push(
    `  Prices: ${formatPriceDisclosureLabel(eff.priceDisclosure, !storedPrice)}`
  );
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
