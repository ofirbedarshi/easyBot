/**
 * Shared blind evidence + model payloads for semantic and UX judges.
 * Expected verdicts/reasons stay in test metadata — never in model inputs.
 */
import {
  businessFactsView,
  behaviorSettingsView,
  normalizeCommonQuestions,
} from './profile.js';
import crypto from 'crypto';

/** Top-level keys that must never appear on a model-bound payload. */
export const FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
  'expectHint',
  'expectVerdict',
  'expected',
  'expect',
  'rationale',
  'reason',
  'pass',
  'forceUnreliable',
  'note', // case-specific hints — contract lives in system prompt only
]);

/** Operational / draft keys that must never appear inside approved evidence. */
export const FORBIDDEN_EVIDENCE_KEYS = Object.freeze([
  'draft',
  'chatflowId',
  'approvedAt',
  'flowiseSyncedAt',
  'flowiseSyncOk',
  'flowiseSyncPending',
  'flowiseSyncRequestedAt',
]);

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function collectForbiddenKeys(obj, forbidden, path = '', found = []) {
  if (!obj || typeof obj !== 'object') return found;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) =>
      collectForbiddenKeys(item, forbidden, `${path}[${i}]`, found)
    );
    return found;
  }
  for (const key of Object.keys(obj)) {
    const here = path ? `${path}.${key}` : key;
    if (forbidden.includes(key)) {
      found.push(here);
    } else {
      collectForbiddenKeys(obj[key], forbidden, here, found);
    }
  }
  return found;
}

/**
 * Snapshot of approved configuration for judging a reply.
 * Separates facts, unknowns, objective, intake whitelist, and behavior settings.
 * Excludes draft and operational metadata. Deep-cloned so later profile edits
 * do not mutate the evidence used for this reply.
 *
 * @param {object} profile — live approved profile (or seed shaped like one)
 */
export function approvedEvidence(profile) {
  const p = profile || {};
  const factsView = businessFactsView(p);
  const businessFacts = {
    name: factsView.name,
    whatWeDo: factsView.whatWeDo,
    services: deepClone(factsView.services),
    hours: factsView.hours,
    locationOrArea: factsView.locationOrArea,
    commonQuestions: deepClone(
      normalizeCommonQuestions(factsView.commonQuestions)
    ),
  };
  return deepClone({
    businessFacts,
    unknowns: Array.isArray(factsView.unknowns) ? factsView.unknowns : [],
    objective: factsView.ownerGoal ?? null,
    intakeWhitelist: Array.isArray(factsView.informationToCollect)
      ? factsView.informationToCollect
      : factsView.informationToCollect === null
        ? null
        : [],
    behaviorSettings: behaviorSettingsView(p),
  });
}

/**
 * Normalize prior turns for model input.
 * @param {Array<{role?:string,text?:string}>|null|undefined} turns
 */
export function normalizePriorConversation(turns) {
  if (!Array.isArray(turns) || !turns.length) return null;
  return turns.map((t) => ({
    role: t?.role || 'unknown',
    text: t?.text != null ? String(t.text) : '',
  }));
}

/**
 * Build the exact user JSON sent to the semantic judge model.
 * Whitelist only — no expected verdicts, hints, or case rationales.
 */
export function buildSemanticPayload({
  stage,
  evidence = null,
  question = null,
  priorConversation = null,
  conversationContext = null,
  outputText,
  disclosureLedger = null,
  extractedDraft = null,
} = {}) {
  const prior =
    normalizePriorConversation(priorConversation) ||
    normalizePriorConversation(conversationContext);

  const payload = {
    stage: stage || null,
    question: question != null ? question : null,
    priorConversation: prior,
    outputUnderTest: outputText != null ? String(outputText) : null,
    disclosureLedger: disclosureLedger ? deepClone(disclosureLedger) : null,
    extractedDraft: extractedDraft ? deepClone(extractedDraft) : null,
    businessFacts: evidence?.businessFacts
      ? deepClone(evidence.businessFacts)
      : null,
    unknowns: evidence ? deepClone(evidence.unknowns ?? []) : null,
    objective: evidence ? evidence.objective ?? null : null,
    intakeWhitelist: evidence
      ? deepClone(evidence.intakeWhitelist ?? [])
      : null,
    behaviorSettings: evidence?.behaviorSettings
      ? deepClone(evidence.behaviorSettings)
      : null,
  };
  assertBlindPayload(payload, { kind: 'semantic' });
  return payload;
}

/**
 * Build the exact user JSON sent to the UX judge model.
 * Style settings only — never business facts.
 */
export function buildUxPayload({
  channel,
  scope = 'reply',
  userMessage = null,
  outputText = null,
  priorConversation = null,
  transcript = null,
  behaviorSettings = null,
} = {}) {
  const includeStyleMatch = !!(
    behaviorSettings &&
    (behaviorSettings.tone ||
      behaviorSettings.responseLength ||
      behaviorSettings.priceDisclosure)
  );
  const payload = {
    channel: channel || null,
    scope: scope || 'reply',
    userMessage: userMessage != null ? userMessage : null,
    outputUnderTest: outputText != null ? String(outputText) : null,
    priorConversation: normalizePriorConversation(priorConversation),
    transcript: Array.isArray(transcript)
      ? normalizePriorConversation(transcript)
      : null,
    behaviorSettings: behaviorSettings
      ? {
          tone: behaviorSettings.tone ?? null,
          responseLength: behaviorSettings.responseLength ?? null,
          priceDisclosure: behaviorSettings.priceDisclosure ?? null,
        }
      : null,
    includeStyleMatch,
  };
  assertBlindPayload(payload, { kind: 'ux' });
  return payload;
}

/**
 * Validate model-bound payload structure.
 * Checks forbidden metadata field names at defined locations only.
 * Does NOT scan string values for words like "reason" inside facts or chat text.
 *
 * @param {object} payload
 * @param {{ kind?: 'semantic'|'ux' }} [opts]
 */
export function assertBlindPayload(payload, opts = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('assertBlindPayload: payload must be a plain object');
  }
  const bad = collectForbiddenKeys(payload, FORBIDDEN_PAYLOAD_KEYS);
  if (bad.length) {
    throw new Error(
      `assertBlindPayload: forbidden metadata keys in model payload: ${bad.join(', ')}`
    );
  }
  const evidenceRoots = [
    payload.businessFacts,
    payload.unknowns,
    payload.objective,
    payload.intakeWhitelist,
    payload.behaviorSettings,
    payload.evidence,
  ].filter((x) => x != null && typeof x === 'object');
  for (const root of evidenceRoots) {
    const opBad = collectForbiddenKeys(root, FORBIDDEN_EVIDENCE_KEYS);
    if (opBad.length) {
      throw new Error(
        `assertBlindPayload: operational/draft keys in evidence: ${opBad.join(', ')}`
      );
    }
  }
  if (opts.kind === 'ux') {
    if (payload.businessFacts != null || payload.approvedConfig != null) {
      throw new Error(
        'assertBlindPayload: UX payload must not include business facts'
      );
    }
  }
  return true;
}

/**
 * Resolve evidence from new `evidence` arg or legacy `approvedConfig` profile blob.
 */
export function resolveEvidence(args) {
  if (args.evidence && typeof args.evidence === 'object') {
    return deepClone(args.evidence);
  }
  if (args.approvedConfig && typeof args.approvedConfig === 'object') {
    const base = { ...args.approvedConfig };
    if (args.approvedBehaviorSettings || args.behaviorSettings) {
      const b = args.approvedBehaviorSettings || args.behaviorSettings;
      if (b.tone != null) base.tone = b.tone;
      if (b.responseLength != null) base.responseLength = b.responseLength;
      if (b.priceDisclosure != null) base.priceDisclosure = b.priceDisclosure;
    }
    if (args.unknowns != null) base.unknowns = args.unknowns;
    return approvedEvidence(base);
  }
  if (args.approvedBehaviorSettings || args.behaviorSettings) {
    return approvedEvidence({
      ...(args.approvedBehaviorSettings || args.behaviorSettings),
    });
  }
  return null;
}

/**
 * Map legacy expectHint / expectVerdict into expected metadata (never model-bound).
 */
export function resolveExpected(args) {
  if (args.expected && typeof args.expected === 'object') {
    return {
      verdict: args.expected.verdict || args.expected.expectVerdict || 'PASS',
      reason: args.expected.reason || args.expected.expectHint || null,
    };
  }
  return {
    verdict: args.expectVerdict || 'PASS',
    reason: args.expectHint || null,
  };
}

export function sha256Text(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}
