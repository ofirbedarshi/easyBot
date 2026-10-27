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
  'hours',
  'locationOrArea',
];

/**
 * Bot goal (`ownerGoal`): only what the Business Bot can actually do.
 * Anything else the owner asks for is mapped to `answer_and_collect`.
 */
export const OWNER_GOAL_VALUES = ['answer_questions', 'collect_details', 'answer_and_collect'];

export const OWNER_GOAL_LABELS = {
  answer_questions: 'Answer customer questions',
  collect_details: 'Collect details from interested customers',
  answer_and_collect: 'Answer customer questions and collect their details',
};

/** Goal used when the owner asks for something the bot cannot do. */
export const FALLBACK_OWNER_GOAL = 'answer_and_collect';

/** Stored goal value, or null (legacy free text and unknown values → null). */
export function normalizeOwnerGoal(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return OWNER_GOAL_VALUES.includes(s) ? s : null;
}

/** Conversation settings — expression, not business facts. */
export const BEHAVIOR_KEYS = ['tone'];

/** Fixed customer-facing name. Not configurable. */
export const ASSISTANT_NAME = 'Adam';

/**
 * Assistant identity settings — customer-facing introduction, not business facts.
 * null opening = the Adam default (`defaultCustomerOpening`).
 * Draft-only reset flags (`<key>Reset: true`) clear the live value on approval;
 * an omitted / null / blank draft value preserves the live value.
 */
export const IDENTITY_KEYS = ['openingMessage'];

export function identityResetFlag(key) {
  return `${key}Reset`;
}

export const PRICE_DISCLOSURE_VALUES = ['relevant', 'on_request'];

/**
 * Builder-prompt labels for the priceDisclosure enum.
 * Owner-facing section / review cards use PRICE_POLICY_OWNER_LABELS.
 */
export const PRICE_DISCLOSURE_LABELS = {
  relevant: 'when useful and relevant',
  on_request: 'only when the customer asks about pricing',
};

/** Owner-facing Price policy sentences (section cards + review). */
export const PRICE_POLICY_OWNER_LABELS = {
  relevant: "I mention prices when they're relevant",
  on_request: 'I share prices only when a customer asks',
};

/**
 * What the product can configure. Single source for the Builder prompt and the
 * config-request check. Settings and actions are supported only if a field
 * represents them exactly. Customer-facing policies belong in business facts.
 */
export const CONFIG_CAPABILITIES = [
  {
    field: 'tone',
    represents:
      'Overall voice/style of the Business Bot, as a short description (e.g. warm, calm, professional, playful).',
    cannotRepresent:
      'Rules, scripts, or formatting the bot must follow per message: things every reply must start/end with, emoji or symbol rules, rotating or fixed phrases, required wording, message structure, language choice, frequency rules, or any capability.',
  },
  {
    field: 'priceDisclosure',
    represents: `When approved prices are mentioned: ${PRICE_DISCLOSURE_VALUES.map((v) => `"${v}" (${PRICE_DISCLOSURE_LABELS[v]})`).join(' or ')}.`,
    cannotRepresent:
      'Prices in every reply, a global never-mention-any-prices policy, or discounts/prices not in the facts. How one offering is priced or quoted is a business fact.',
  },
  {
    field: 'openingMessage',
    represents:
      "The owner's text for the first reply of a fresh customer conversation only.",
    cannotRepresent:
      'Text added to every message, changing per message, or claims beyond approved facts and demo scope.',
  },
  {
    field: 'ownerGoal',
    represents: `The bot goal, one of: ${OWNER_GOAL_VALUES.map((v) => `"${v}" (${OWNER_GOAL_LABELS[v]})`).join(', ')}.`,
    cannotRepresent:
      'Booking, sales follow-up, payments, reminders, or any goal beyond answering questions and collecting the listed details.',
  },
  {
    field: 'informationToCollect',
    represents: 'Details the Business Bot asks the customer for in chat.',
    cannotRepresent:
      'Saving, sending, or delivering those details anywhere; collecting files or payments.',
  },
  {
    field: 'business facts',
    represents:
      'name, whatWeDo, services, hours, locationOrArea, commonQuestions, otherFacts, unknowns — facts and customer-facing policies (including how an offering is priced or quoted).',
    cannotRepresent:
      'Booking, payments, CRM, outbound messages, or per-message scripts and formatting.',
  },
];

/** What the Business Bot can and cannot do once approved (demo scope). */
export const DEMO_SCOPE = {
  can: [
    'Answer customer questions from approved business facts',
    'Clarify what the customer needs',
    'Collect the listed intake details in chat',
    'Suggest the customer message the owner directly',
  ],
  cannot: [
    'Book calendars or appointments',
    'Take payments',
    'Update a CRM or any external system',
    'Send emails, SMS, reminders, or follow-up messages on its own',
    'Save or deliver an inquiry record to the owner',
    'Send images, files, voice notes, or links not in approved facts',
  ],
};

/**
 * Effective defaults when a field is null / missing (legacy-safe).
 * Stored values stay null until the owner sets them.
 */
export const DEFAULT_BEHAVIOR = {
  tone: 'warm, friendly, and human',
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

/** Trimmed non-empty string, or null. */
export function normalizeIdentityText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s || null;
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
  if ('priceDisclosure' in profile || profile.priceDisclosure !== undefined) {
    profile.priceDisclosure = normalizePriceDisclosure(profile.priceDisclosure);
  }
  for (const key of IDENTITY_KEYS) {
    if (key in profile) profile[key] = normalizeIdentityText(profile[key]);
  }
  if ('ownerGoal' in profile) profile.ownerGoal = normalizeOwnerGoal(profile.ownerGoal);
  if (profile.draft && typeof profile.draft === 'object') {
    if ('ownerGoal' in profile.draft) {
      profile.draft.ownerGoal = normalizeOwnerGoal(profile.draft.ownerGoal);
    }
    for (const key of IDENTITY_KEYS) {
      if (key in profile.draft) {
        profile.draft[key] = normalizeIdentityText(profile.draft[key]);
      }
    }
    if (profile.draft.tone != null && typeof profile.draft.tone === 'string') {
      const t = profile.draft.tone.trim();
      profile.draft.tone = t || null;
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
 * Effective conversation settings for prompts / summaries.
 * Null stored values resolve to DEFAULT_BEHAVIOR.
 */
export function effectiveBehavior(profile) {
  const p = profile || {};
  const tone =
    typeof p.tone === 'string' && p.tone.trim()
      ? p.tone.trim()
      : DEFAULT_BEHAVIOR.tone;
  const priceDisclosure =
    normalizePriceDisclosure(p.priceDisclosure) ||
    DEFAULT_BEHAVIOR.priceDisclosure;
  return { tone, priceDisclosure };
}

/** Owner-facing Price policy sentence (null → default relevant wording). */
export function pricePolicyOwnerLabel(value) {
  const v =
    normalizePriceDisclosure(value) || DEFAULT_BEHAVIOR.priceDisclosure;
  return (
    PRICE_POLICY_OWNER_LABELS[v] || PRICE_POLICY_OWNER_LABELS.relevant
  );
}

/** Approved business facts only — no conversation settings. */
export function businessFactsView(profile) {
  const p = profile || {};
  return {
    name: p.name ?? null,
    whatWeDo: p.whatWeDo ?? null,
    ownerGoal: normalizeOwnerGoal(p.ownerGoal),
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
    otherFacts: Array.isArray(p.otherFacts) ? p.otherFacts : [],
    priceDisclosure:
      normalizePriceDisclosure(p.priceDisclosure) ||
      DEFAULT_BEHAVIOR.priceDisclosure,
  };
}

/** Approved assistant identity (null opening = Adam default). */
export function assistantIdentityView(profile) {
  const p = profile || {};
  const openingMessage = normalizeIdentityText(p.openingMessage);
  return {
    openingMessage,
    usesDefaultIntroduction: !openingMessage,
  };
}

/** Fixed second line of the default customer opening (code, not the model). */
export const DEFAULT_CUSTOMER_HELP_LINE = 'How can I help you? ✨';

/**
 * Warm default first-contact opening when the owner has not set openingMessage.
 * Always Adam; uses the approved business name, or "this business".
 * One message: intro and help line separated by a blank line.
 */
export function defaultCustomerOpening(profile) {
  const biz =
    typeof profile?.name === 'string' && profile.name.trim()
      ? profile.name.trim()
      : 'this business';
  return `Hi! I'm ${ASSISTANT_NAME}, ${biz}'s digital assistant 😊\n\n${DEFAULT_CUSTOMER_HELP_LINE}`;
}

/** Custom openingMessage if set; otherwise the warm default. */
export function customerOpeningText(profile) {
  const identity = assistantIdentityView(profile);
  return identity.openingMessage || defaultCustomerOpening(profile);
}

/** Conversation settings view (effective values) for prompts / summaries. */
export function behaviorSettingsView(profile) {
  return { ...effectiveBehavior(profile), ...assistantIdentityView(profile) };
}

export function emptyProfile() {
  return {
    name: null,
    whatWeDo: null,
    /**
     * Bot goal: one of OWNER_GOAL_VALUES, or null = not asked / not answered yet.
     */
    ownerGoal: null,
    /** The owner's own words when asked the goal (demo research only; never sent to the Business Bot). */
    ownerGoalRequested: null,
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
    /** Explicit gaps the owner left undecided or unclarified. */
    unknowns: [],
    /** Owner-stated facts, policies, or caveats that fit no other field, close to the owner's wording. */
    otherFacts: [],
    /** Free-text how the bot should sound. null = use DEFAULT_BEHAVIOR.tone. */
    tone: null,
    /**
     * Price disclosure: 'relevant' | 'on_request' | null.
     * null = use DEFAULT_BEHAVIOR.priceDisclosure ('relevant').
     */
    priceDisclosure: null,
    /** Custom opening for a fresh customer conversation. null = Adam default. */
    openingMessage: null,
    /** Ready timestamp: name + offering, and first-time required topics settled. */
    approvedAt: null,
    draft: null,
  };
}

/**
 * Defaults merged with the stored profile, keeping only top-level keys that
 * emptyProfile() defines so retired fields are dropped on load.
 */
export function withKnownProfileKeys(stored) {
  const profile = emptyProfile();
  for (const key of Object.keys(profile)) {
    if (stored && Object.hasOwn(stored, key)) profile[key] = stored[key];
  }
  return profile;
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
  return normalizeBehaviorSettings(
    normalizeProfileFaq(withKnownProfileKeys(parsed))
  );
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
  const goal = normalizeOwnerGoal(draft.ownerGoal);
  if (goal) next.ownerGoal = goal;
  else next.ownerGoal = normalizeOwnerGoal(next.ownerGoal);
  const requested = normalizeIdentityText(draft.ownerGoalRequested);
  if (requested) next.ownerGoalRequested = requested;
  for (const key of BEHAVIOR_KEYS) {
    if (key === 'tone') {
      if (draft.tone != null && draft.tone !== '') next.tone = draft.tone;
    }
  }
  {
    const n = normalizePriceDisclosure(draft.priceDisclosure);
    if (n != null) next.priceDisclosure = n;
  }
  for (const key of IDENTITY_KEYS) {
    const value = normalizeIdentityText(draft[key]);
    if (value != null) next[key] = value;
    else if (draft[identityResetFlag(key)] === true) next[key] = null;
  }
  if (Array.isArray(draft.services)) next.services = draft.services;
  if (Array.isArray(draft.commonQuestions)) {
    next.commonQuestions = normalizeCommonQuestions(draft.commonQuestions);
  }
  if (Array.isArray(draft.informationToCollect)) {
    next.informationToCollect = draft.informationToCollect;
  }
  if (Array.isArray(draft.unknowns)) next.unknowns = draft.unknowns;
  if (Array.isArray(draft.otherFacts)) next.otherFacts = draft.otherFacts;
  return next;
}

/**
 * Copy the merged draft onto live fields. The customer bot reads these.
 * Sets approvedAt the first time name + offering are present and first-time
 * required topics (FAQ asked/answered, intake is an array) are settled.
 * Mutates `profile` in place.
 */
export function applyDraftToLive(profile) {
  if (!profile?.draft) return profile;
  const merged = mergeDraft(profile, profile.draft);
  Object.assign(profile, merged, {
    ownerGoal: merged.ownerGoal ?? null,
    ownerGoalRequested: merged.ownerGoalRequested ?? null,
    services: merged.services || [],
    commonQuestions: merged.commonQuestions || [],
    informationToCollect: Array.isArray(merged.informationToCollect)
      ? merged.informationToCollect
      : profile.informationToCollect,
    unknowns: merged.unknowns || [],
    otherFacts: Array.isArray(merged.otherFacts) ? merged.otherFacts : [],
    priceDisclosure: merged.priceDisclosure ?? null,
    openingMessage: merged.openingMessage ?? null,
    draft: profile.draft,
  });
  if (hasEnoughForFirstBot(profile) && !profile.approvedAt && firstSetupSettled(profile)) {
    profile.approvedAt = new Date().toISOString();
  }
  return profile;
}

/**
 * FAQ asked or answered, and intake is an array. `draft` defaults to
 * `profile.draft` so the gate can check this turn before live fields update.
 */
export function firstSetupSettled(profile, draft = profile?.draft) {
  const asked = Array.isArray(draft?.askedTopics) ? draft.askedTopics : [];
  const faqList = Array.isArray(draft?.commonQuestions)
    ? draft.commonQuestions
    : profile?.commonQuestions;
  const faqDone =
    normalizeCommonQuestions(faqList).some((q) => q.answer.trim()) ||
    asked.includes('commonQuestions');
  const intake = Array.isArray(draft?.informationToCollect)
    ? draft.informationToCollect
    : profile?.informationToCollect;
  return faqDone && Array.isArray(intake);
}

function stableJson(value) {
  return JSON.stringify(value ?? null);
}

/** True when merging the draft would change live facts or behavior. */
export function draftDiffersFromLive(profile, draft) {
  if (!draft || typeof draft !== 'object') return false;
  const merged = mergeDraft(profile, draft);
  for (const key of TEXT_FACT_KEYS) {
    if ((merged[key] || null) !== (profile[key] || null)) return true;
  }
  if (normalizeOwnerGoal(merged.ownerGoal) !== normalizeOwnerGoal(profile.ownerGoal)) {
    return true;
  }
  const liveB = effectiveBehavior(profile);
  const mergedB = effectiveBehavior(merged);
  if (liveB.tone !== mergedB.tone) return true;
  if (liveB.priceDisclosure !== mergedB.priceDisclosure) return true;
  for (const key of IDENTITY_KEYS) {
    if (
      normalizeIdentityText(merged[key]) !== normalizeIdentityText(profile[key])
    ) {
      return true;
    }
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
  if (stableJson(merged.otherFacts || []) !== stableJson(profile.otherFacts || [])) {
    return true;
  }
  return false;
}

function formatFactsBlock(profile) {
  const lines = [];
  lines.push(`Business: ${profile.name || '(not set)'}`);
  lines.push(`What they do: ${profile.whatWeDo || '(not set)'}`);
  const goal = normalizeOwnerGoal(profile.ownerGoal);
  lines.push(`Bot goal: ${goal ? OWNER_GOAL_LABELS[goal] : '(not set)'}`);
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
  lines.push(`Price policy: ${pricePolicyOwnerLabel(profile.priceDisclosure)}`);
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
      lines.push("I'll ask customers for:");
      for (const item of profile.informationToCollect) {
        lines.push(`  • ${item}`);
      }
    } else {
      lines.push("I'll ask customers for: (none)");
    }
  }
  if (profile.unknowns?.length) {
    lines.push('Explicitly unknown / undecided (bot must not invent these):');
    for (const u of profile.unknowns) lines.push(`  • ${u}`);
  }
  if (profile.otherFacts?.length) {
    lines.push('Other business facts:');
    for (const f of profile.otherFacts) lines.push(`  • ${f}`);
  }

  const storedTone = profile.tone;
  const eff = effectiveBehavior(profile);
  lines.push('Conversation settings:');
  lines.push(
    `  Tone: ${storedTone ? storedTone : `${eff.tone} (default)`}`
  );
  const identity = assistantIdentityView(profile);
  lines.push(
    `  Opening: ${
      identity.openingMessage
        ? `“${identity.openingMessage}”`
        : `(default) “${defaultCustomerOpening(profile)}”`
    }`
  );
  return lines.join('\n');
}

/** Owner-facing summary of the current (live) profile. */
export function formatSummary(profile) {
  const draft = profile?.draft;
  const view = draft ? mergeDraft(profile, draft) : profile;
  return formatFactsBlock(view || emptyProfile());
}

/** True when the draft changes only conversation settings / identity, not facts. */
export function draftChangesOnlySettings(profile, draft) {
  if (!draftDiffersFromLive(profile, draft)) return false;
  const merged = mergeDraft(profile, draft);
  return (
    JSON.stringify(businessFactsView(merged)) ===
    JSON.stringify(businessFactsView(profile))
  );
}

export function hasEnoughForFirstBot(profile) {
  const hasName = !!(profile.name && String(profile.name).trim());
  const hasOffering =
    (profile.services && profile.services.length > 0) || !!profile.whatWeDo;
  return hasName && hasOffering;
}
