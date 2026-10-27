/**
 * Single merge: apply what the model extracted onto the stored draft.
 * Omission never deletes. Only an explicit op or an explicit field write deletes.
 */
import {
  IDENTITY_KEYS,
  identityResetFlag,
  normalizeCommonQuestions,
  normalizeIdentityText,
  normalizeOwnerGoal,
  normalizePriceDisclosure,
} from './profile.js';

/** Fold punctuation so "Men's cut" and "men’s cut" are the same key. */
export const foldKey = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u02BC`]/g, "'");

export const sameKey = (a, b) => foldKey(a) === foldKey(b);

/** True when `next` still contains all of `prev`, i.e. the change only adds detail. */
const extends_ = (next, prev) => foldKey(next).includes(foldKey(prev));

/** Loose identity for model-reported edit targets, which may abbreviate the stored key. */
const overlaps = (a, b) => {
  const x = foldKey(a);
  const y = foldKey(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

/**
 * An ownerEdit item matches a stored list key only when they are the same key,
 * or the edit is an abbreviation that overlaps exactly one stored item.
 * A null / blank item never matches a list row (it is for text fields only).
 */
function uniqueItemMatch(editItem, storedItem, storedItems) {
  if (!editItem || !storedItem) return false;
  if (sameKey(editItem, storedItem)) return true;
  if (!overlaps(editItem, storedItem)) return false;
  const hits = storedItems.filter((s) => s && overlaps(editItem, s));
  return hits.length === 1;
}

function listEdit(edits, field, item, storedItems) {
  if (!item) return null;
  return (
    (Array.isArray(edits) ? edits : []).find(
      (e) => e && e.field === field && e.item && uniqueItemMatch(e.item, item, storedItems)
    ) || null
  );
}

function textFieldEdited(edits, field) {
  return (Array.isArray(edits) ? edits : []).some((e) => e && e.field === field);
}

function textFieldRemoved(edits, field) {
  return (Array.isArray(edits) ? edits : []).some(
    (e) => e && e.field === field && e.action === 'remove'
  );
}

/**
 * Upsert incoming keyed objects onto the previous list. Previous order is kept;
 * new items append. An empty incoming array means no list changes this turn.
 */
function upsertKeyedList(prevList, incoming, key) {
  const prev = Array.isArray(prevList) ? prevList.filter(Boolean) : [];
  if (!Array.isArray(incoming) || incoming.length === 0) return [...prev];
  const result = [];
  const used = new Set();
  for (const old of prev) {
    const i = incoming.findIndex((x, idx) => x && !used.has(idx) && sameKey(x[key], old[key]));
    if (i === -1) {
      result.push(old);
      continue;
    }
    used.add(i);
    result.push(incoming[i]);
  }
  for (let i = 0; i < incoming.length; i++) {
    if (!used.has(i) && incoming[i]) result.push(incoming[i]);
  }
  return result;
}

/** Union string lists: keep previous items, append new ones. Does not drop. */
function unionStrings(prevList, incoming) {
  const prev = Array.isArray(prevList)
    ? prevList.filter((x) => typeof x === 'string' && x.trim())
    : [];
  if (!Array.isArray(incoming)) return prev;
  const result = [...prev];
  for (const item of incoming) {
    const text = typeof item === 'string' ? item.trim() : '';
    if (text && !result.some((x) => sameKey(x, text))) result.push(item);
  }
  return result;
}

const DELTA_TEXT_KEYS = [
  'name',
  'whatWeDo',
  'ownerGoal',
  'ownerGoalRequested',
  'hours',
  'locationOrArea',
  'tone',
  'priceDisclosure',
];

const TEXT_FACT_FIELDS = ['name', 'whatWeDo', 'hours', 'locationOrArea'];

/**
 * Seed code-owned lists from the stored draft, falling back to live.
 * A missing `otherFacts` key must not become [] and wipe live later.
 */
export function seedStoredDraft(storedDraft, live) {
  const stored = storedDraft && typeof storedDraft === 'object' ? { ...storedDraft } : {};
  if (!Array.isArray(stored.otherFacts)) {
    stored.otherFacts = Array.isArray(live?.otherFacts) ? [...live.otherFacts] : [];
  }
  if (!Array.isArray(stored.unknowns) && Array.isArray(live?.unknowns)) {
    stored.unknowns = [...live.unknowns];
  }
  if (!Array.isArray(stored.askedTopics) && Array.isArray(live?.draft?.askedTopics)) {
    stored.askedTopics = [...live.draft.askedTopics];
  }
  return stored;
}

/**
 * Write phase: null / omitted scalars mean unchanged. services / FAQ upsert.
 * informationToCollect: [] = collect nothing; a non-empty array unions onto stored
 * (omitted items stay until ownerEdits remove). unknowns append.
 */
export function applyDraftDelta(delta, currentDraft) {
  const d = delta && typeof delta === 'object' ? delta : {};
  const prev = currentDraft || {};
  const next = { ...prev };

  for (const key of DELTA_TEXT_KEYS) {
    if (d[key] != null && d[key] !== '') next[key] = d[key];
  }
  if (Array.isArray(d.services)) next.services = upsertKeyedList(prev.services, d.services, 'name');
  if (Array.isArray(d.commonQuestions)) {
    next.commonQuestions = upsertKeyedList(prev.commonQuestions, d.commonQuestions, 'question');
  }
  if (Array.isArray(d.informationToCollect)) {
    if (d.informationToCollect.length === 0) {
      next.informationToCollect = [];
    } else {
      next.informationToCollect = unionStrings(prev.informationToCollect, d.informationToCollect);
    }
  }
  if (Array.isArray(d.unknowns)) {
    const list = Array.isArray(prev.unknowns) ? [...prev.unknowns] : [];
    for (const u of d.unknowns) {
      const text = typeof u === 'string' ? u.trim() : '';
      if (text && !list.some((x) => sameKey(x, text))) list.push(text);
    }
    next.unknowns = list;
  }
  for (const key of IDENTITY_KEYS) {
    const flag = identityResetFlag(key);
    if (d[flag] === true) {
      next[key] = null;
      next[flag] = true;
    } else if (d[key] != null && d[key] !== '') {
      next[key] = d[key];
      next[flag] = false;
    }
  }
  return next;
}

/**
 * Ops + guards. ownerEdits change/remove services, FAQ, intake, and text fields.
 * Unreported shortenings revert unless skipGuards (consistency pass).
 */
export function preserveFacts(draft, currentDraft, ownerEdits, incomingDelta, { skipGuards = false } = {}) {
  if (!currentDraft) return draft;
  const next = { ...draft };
  const prev = currentDraft;
  const edits = Array.isArray(ownerEdits) ? ownerEdits : [];
  const delta = incomingDelta && typeof incomingDelta === 'object' ? incomingDelta : {};

  const guardList = (field, key, valueKeys) => {
    if (!Array.isArray(prev[field])) return;
    const incoming = Array.isArray(next[field]) ? next[field] : [];
    const rawDelta = Array.isArray(delta[field]) ? delta[field] : [];
    const proposed = new Set(rawDelta.filter((x) => x && x[key]).map((x) => foldKey(x[key])));
    const storedItems = prev[field].map((x) => x?.[key]).filter(Boolean);
    const used = new Set();
    const list = [];
    for (const old of prev[field]) {
      if (!old) continue;
      const edit = listEdit(edits, field, old[key], storedItems);
      const i = incoming.findIndex((x, idx) => x && !used.has(idx) && sameKey(x[key], old[key]));
      if (edit?.action === 'remove') {
        if (i !== -1) used.add(i);
        continue;
      }
      if (i === -1) {
        if (!edit) list.push(old);
        continue;
      }
      used.add(i);
      if (skipGuards || edit || proposed.has(foldKey(old[key]))) {
        list.push(incoming[i]);
        continue;
      }
      const kept = { ...incoming[i] };
      for (const k of valueKeys) if (old[k] && !extends_(kept[k], old[k])) kept[k] = old[k];
      list.push(kept);
    }
    for (let i = 0; i < incoming.length; i++) {
      if (!used.has(i) && incoming[i]) list.push(incoming[i]);
    }
    next[field] = list;
  };
  guardList('services', 'name', ['price', 'notes']);
  guardList('commonQuestions', 'question', ['answer']);

  if (Array.isArray(next.informationToCollect) && next.informationToCollect.length > 0) {
    const storedItems = Array.isArray(prev.informationToCollect) ? prev.informationToCollect : [];
    next.informationToCollect = next.informationToCollect.filter(
      (item) => listEdit(edits, 'informationToCollect', item, storedItems)?.action !== 'remove'
    );
  }

  for (const field of TEXT_FACT_FIELDS) {
    if (textFieldRemoved(edits, field)) {
      next[field] = null;
      continue;
    }
    if (skipGuards) continue;
    if (!prev[field] || extends_(next[field], prev[field]) || textFieldEdited(edits, field)) {
      continue;
    }
    const proposed = typeof delta[field] === 'string' && delta[field].trim();
    const shortening = !!(proposed && extends_(prev[field], next[field]));
    if (!proposed || shortening) next[field] = prev[field];
  }
  return next;
}

/** Remove stored unknowns the model reported as answered (by index into the stored list). */
export function dropResolved(unknowns, stored, resolved) {
  const list = Array.isArray(unknowns) ? unknowns : [];
  const prev = Array.isArray(stored) ? stored : [];
  const gone = (Array.isArray(resolved) ? resolved : [])
    .filter((i) => Number.isInteger(i) && i >= 0 && i < prev.length)
    .map((i) => prev[i]);
  return list.filter((u) => !gone.some((g) => sameKey(g, u)));
}

/**
 * Apply this turn's otherFacts changes to the stored list. The model never re-emits
 * the list, so stored facts cannot silently disappear, shorten, or duplicate.
 * Edit indexes refer to the list shown to the model this turn; invalid edits are ignored.
 */
export function applyFactOps(facts, newFacts, edits) {
  const list = Array.isArray(facts) ? [...facts] : [];
  const removed = new Set();
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!Number.isInteger(e?.index) || e.index < 0 || e.index >= list.length) continue;
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (text) list[e.index] = text;
    else if (e.text === null) removed.add(e.index);
  }
  const next = list.filter((_, i) => !removed.has(i));
  for (const f of Array.isArray(newFacts) ? newFacts : []) {
    const text = typeof f === 'string' ? f.trim() : '';
    if (text && !next.some((x) => sameKey(x, text))) next.push(text);
  }
  return next;
}

/**
 * Preserve settled fields and normalize behavior enums after a Builder model turn.
 */
export function reconcileDraft(draft, currentDraft) {
  const next = { ...(draft || {}) };
  const prev = currentDraft || {};

  if (Array.isArray(next.commonQuestions)) {
    next.commonQuestions = normalizeCommonQuestions(next.commonQuestions);
  }

  next.askedTopics = Array.isArray(prev.askedTopics) ? [...prev.askedTopics] : [];

  if (!Array.isArray(next.informationToCollect) && Array.isArray(prev.informationToCollect)) {
    next.informationToCollect = prev.informationToCollect;
  } else if (next.informationToCollect === undefined && prev.informationToCollect === null) {
    next.informationToCollect = null;
  }

  next.ownerGoal =
    normalizeOwnerGoal(next.ownerGoal) ?? normalizeOwnerGoal(prev.ownerGoal) ?? null;
  next.ownerGoalRequested =
    normalizeIdentityText(next.ownerGoalRequested) ??
    normalizeIdentityText(prev.ownerGoalRequested) ??
    null;

  if ((next.tone == null || next.tone === '') && prev.tone) {
    next.tone = prev.tone;
  } else if (next.tone === undefined) {
    next.tone = prev.tone ?? null;
  } else if (typeof next.tone === 'string') {
    next.tone = next.tone.trim() || prev.tone || null;
  }

  {
    const n = normalizePriceDisclosure(next.priceDisclosure);
    if (n != null) {
      next.priceDisclosure = n;
    } else if (prev.priceDisclosure != null) {
      next.priceDisclosure = normalizePriceDisclosure(prev.priceDisclosure);
    } else {
      next.priceDisclosure = null;
    }
  }

  for (const key of IDENTITY_KEYS) {
    const flag = identityResetFlag(key);
    const value = normalizeIdentityText(next[key]);
    if (value != null) {
      next[key] = value;
      next[flag] = false;
    } else if (next[flag] === true) {
      next[key] = null;
    } else if (prev[flag] === true) {
      next[key] = null;
      next[flag] = true;
    } else {
      next[key] = normalizeIdentityText(prev[key]);
      next[flag] = false;
    }
  }

  return next;
}

/**
 * Apply one model extraction onto the stored draft.
 * `mode: 'delta'` (production): null draft fields unchanged.
 * `mode: 'legacy'`: full draft snapshot, newFacts inside draft.
 * `skipGuards`: consistency pass — apply writes without reverting unreported shortenings.
 */
export function applyExtraction(storedDraft, modelOutput = {}, opts = {}) {
  const { mode = 'delta', live, skipGuards = false } = opts;
  const stored = seedStoredDraft(storedDraft, live);
  const parsed = modelOutput && typeof modelOutput === 'object' ? modelOutput : {};
  const incoming = parsed.draft && typeof parsed.draft === 'object' ? parsed.draft : {};
  const newFacts = mode === 'legacy' ? incoming.newFacts : parsed.newFacts;

  const draftIn =
    mode === 'legacy'
      ? parsed.draft && typeof parsed.draft === 'object'
        ? { ...stored, ...parsed.draft }
        : stored
      : applyDraftDelta(incoming, stored);

  const reconciled = reconcileDraft(draftIn || stored, stored);
  const { newFacts: _dropped, ...guarded } = preserveFacts(
    reconciled,
    stored,
    parsed.ownerEdits,
    mode === 'legacy' ? null : incoming,
    { skipGuards }
  );
  return {
    ...guarded,
    otherFacts: applyFactOps(stored.otherFacts, newFacts, parsed.factEdits),
    unknowns: dropResolved(guarded.unknowns, stored.unknowns, parsed.resolvedUnknowns),
  };
}

export function applyBuilderModelOutput(parsed, currentDraft, { mode = 'delta', live } = {}) {
  return applyExtraction(currentDraft, parsed, { mode, live });
}

/** Apply consistency-pass updates without the unreported-shortening guard. */
export function applyConsistencyUpdates(draft, updates) {
  const u = updates && typeof updates === 'object' ? updates : {};
  return applyExtraction(
    draft,
    {
      draft: {
        name: u.name ?? null,
        whatWeDo: u.whatWeDo ?? null,
        hours: u.hours ?? null,
        locationOrArea: u.locationOrArea ?? null,
        openingMessage: u.openingMessage ?? null,
        services: Array.isArray(u.services) ? u.services : [],
        commonQuestions: Array.isArray(u.commonQuestions) ? u.commonQuestions : [],
      },
      factEdits: Array.isArray(u.factEdits) ? u.factEdits : [],
      newFacts: [],
      ownerEdits: [],
      resolvedUnknowns: [],
    },
    { skipGuards: true }
  );
}
