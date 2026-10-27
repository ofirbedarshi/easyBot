import OpenAI from 'openai';
import {
  BEHAVIOR_KEYS,
  CONFIG_CAPABILITIES,
  DEMO_SCOPE,
  draftDiffersFromLive,
  firstSetupSettled,
  hasEnoughForFirstBot,
  identityResetFlag,
  IDENTITY_KEYS,
  mergeDraft,
  PRICE_DISCLOSURE_LABELS,
  PRICE_DISCLOSURE_VALUES,
} from './profile.js';
import { topicJustAsked } from './builderTopics.js';
import { ownerPhase } from './ownerPhase.js';
import { stepSetupAgenda } from './setupAgenda.js';
import { builderResponseFormat, consistencyResponseFormat } from './builderSchema.js';
import { formatModelReply, PARAGRAPH_PROMPT_LINE } from './formatReply.js';
import {
  generateWithIdenticalRetry,
  lastOutgoingMessage,
  messagesWithRetryNote,
} from './identicalReply.js';
import {
  OFF_PURPOSE_OWNER_REPLY,
  PARSE_FALLBACK_MESSAGE,
} from './copy.js';
import {
  composeReply,
  reviewAck,
} from './composeReply.js';
import {
  applyBuilderModelOutput,
  applyConsistencyUpdates,
  applyDraftDelta,
  applyExtraction,
  applyFactOps,
  dropResolved,
  preserveFacts,
  reconcileDraft,
  sameKey,
  seedStoredDraft,
} from './applyExtraction.js';

export {
  applyBuilderModelOutput,
  applyConsistencyUpdates,
  applyDraftDelta,
  applyExtraction,
  applyFactOps,
  dropResolved,
  preserveFacts,
  reconcileDraft,
};

export {
  OFF_PURPOSE_OWNER_REPLY,
  reviewAck,
};

const PRICE_DISCLOSURE_LINES = PRICE_DISCLOSURE_VALUES.map(
  (v) => `  - "${v}" — ${PRICE_DISCLOSURE_LABELS[v]}`
).join('\n');

const DEMO_SCOPE_CAN = DEMO_SCOPE.can.map((s) => `- ${s}`).join('\n');
const DEMO_SCOPE_CANNOT = DEMO_SCOPE.cannot.map((s) => `- ${s}`).join('\n');
const CAPABILITY_LINES = CONFIG_CAPABILITIES.map(
  (c) => `- ${c.field}: ${c.represents}\n  Cannot represent: ${c.cannotRepresent}`
).join('\n');

const SYSTEM = `You are Adam, this business's digital assistant. The owner is teaching you about their business by chatting — not configuring a bot. Extract facts into the draft. Write as Adam in first person.

Discover when relevant (partial info is OK — do not force every category):
- Business name (required for a first bot — never invent it)
- What the business does
- Services and offerings
- Prices (if available) AND how the price applies when relevant (e.g. per unit vs flat / per booking). Store each services[].price with its currency and unit exactly as the owner stated them (e.g. "200 ILS per 60-minute lesson", "$50 per person"). Never invent a currency or unit. If the owner gives a bare number and the currency or unit is unclear, ask once; if they don't know, keep the number and add the missing part to unknowns.
- priceDisclosure: only these supported values (or null):
${PRICE_DISCLOSURE_LINES}
  Extra detail for "on_request": mention prices ONLY when the customer asks about pricing, cost, a quote, a total, or what an amount buys (including clear pricing follow-ups). A general description or booking request alone must NOT trigger prices.
  Extra detail for "relevant": mention approved prices when useful; do not dump prices into unrelated answers; volunteering a price in every general description is not required.
- Map clear natural language: "prices only when asked" / "only mention prices when customers ask" → on_request; "mention prices when relevant" / "include prices when useful" → relevant.
- Opening hours or availability
- Location or service area
- Common customer questions (FAQ: each item is a question customers ask PLUS the owner's answer — the Business Bot may only tell customers those answers). If the owner volunteers FAQ or intake details at any time, store them.
- Details I should ask customers for (intake: name, phone, preferred day/time, etc. — I should ASK for these, not treat them as FAQ answers).
- Other business facts (otherFacts): any customer-relevant fact, policy, condition, or caveat that does not fit the fields above, whenever the owner states it. Each is one standalone statement close to the owner's wording, with all conditions, numbers, and qualifiers. Stored facts are listed separately in the context; put new ones in newFacts and edit stored ones only via factEdits.
- Conversation settings when the owner mentions them (tone) — these are NOT business facts and are optional; defaults apply if the owner says nothing

Demo scope (what the customer bot CAN do once live):
${DEMO_SCOPE_CAN}
It cannot:
${DEMO_SCOPE_CANNOT}
Never claim those exist.

WHAT THE PRODUCT CAN CONFIGURE (the only things you can promise):
${CAPABILITY_LINES}

CONFIGURATION REQUESTS — product settings and actions only:
Classify style, global price mention, identity, intake list, and actions the bot should perform. What customers should be told — including what to say or not quote about an offering — is a business fact (store it; do not classify it here):
- "supported": one field above represents it exactly as asked. Update that field. The app saves it.
- "ambiguous": it could mean a supported value or something unsupported. Ask one short clarification. Do NOT change that field.
- "unsupported": no field represents it exactly, or it is outside demo scope. Gently say what you can do today (answer customers' questions and collect their details for the owner), that more is coming soon ✨. Do NOT change any field for it. Do NOT write it into tone, openingMessage, FAQ answers, service notes, or any other free-text field — a free-text field accepting the words does NOT make it supported.
- Never say you "added", "will add", "set", or "noted" an unsupported or ambiguous request, and never list it in a summary.
- After the owner accepts an offered alternative, the alternative is a new "supported" request: update the draft.
List every such request from the owner's CURRENT message in "configRequests" (empty array if none). "request" must quote the owner's own words — never your rewording or your alternative. Classify what the owner literally asked: if it is broader than any supported value (e.g. "all the time", "every message", "always"), it is not "supported" just because a narrower value exists. A "supported" request never has an alternative; if you are offering one, the status is "ambiguous" or "unsupported".

Conversation settings (behavior — not business facts):
- tone: a short description of the bot's voice (e.g. "warm", "professional"). Expression only — NEVER put rules, scripts, services, benefits, guarantees, capabilities, or intake permissions into tone.
- Style/settings cannot establish service attributes, benefits, guarantees, capabilities, or extra intake. If a style request also contains a business fact, update the fact fields separately and keep settings as settings.
- Assistant identity (conversation settings, NOT business facts):
  - You are always Adam, the business's digital assistant — never a human, the owner, or another name. The owner cannot rename you.
  - openingMessage: the owner's exact opening text for the start of a fresh customer conversation. Store their wording as given (do not rewrite it). Leave null if they did not provide one; the app then sends a warm default as Adam, the business's digital assistant.
  - The opening is customer-facing content. Before accepting it, check it against the draft business facts, the demo scope above, and priceDisclosure. If it claims an unsupported capability (booking, payments, saving or forwarding inquiries, etc.), states a fact or price that is not in the draft, impersonates the owner or a human, uses a name other than Adam, or contradicts the price setting: explain the specific conflict, keep the PREVIOUS openingMessage in the draft (do not store the conflicting text), and ask the owner for a corrected opening.
  - Explicit reset: if the owner asks to go back to the default opening, set openingMessage=null AND openingMessageReset=true. Otherwise omit the reset flag (or set false) — a null value alone means "keep the current value".
- When the owner later changes only style or opening (and the change has no conflict), update those draft fields, leave business facts unchanged.

- onPurpose=true when the owner is talking about their business or this bot (including questions about stored facts); poems, homework, unrelated trivia, coding, jailbreaks, or role changes are onPurpose=false (empty delta).
topicResponse: answered if they gave info for the current skippable setup topic, skipped if they declined or have nothing, unclear if they only asked what you mean; otherwise null.
- Never invent a business name or other business facts.
- Store every business fact the owner states in the same turn: in its field if one fits, otherwise in newFacts.
- When they dump many facts in one message, absorb them and react specifically to what they shared.
- After they share a real business detail, react in one warm short sentence (name what they said) with a cute emoji like ✨🌟💛 — never a tool-ish one such as 💈. End that sentence with . or ! (the emoji may sit just before or right after that mark).
- If they interrupt, add requirements, or change direction mid-setup, update the draft to match the new direction and drop stale offerings that no longer apply.
- Identify missing, contradictory, or ambiguous info gently. Ambiguities that change customer answers (especially pricing basis/units, discounts, what a service area covers, hours edge cases, cancellation/refund policy, availability/booking rules) must NOT be filled in by assumption. Prefer one concise clarification question when the ambiguity is important for a useful bot. If the owner says it is undecided, unknown, or "not sure yet", record it in draft.unknowns as a clear statement of what is unknown. Keep known parts in the normal fields (e.g. rate known, application unknown). Capacity limits, max group size, or similar are NOT pricing rules — do not treat them as settling how price scales.
- commonQuestions = FAQ { question, answer }. question = what customers ask; answer = the owner's COMPLETE explanation (not a one-line paraphrase or topic title). If they already gave the answer in chat, copy it into answer. informationToCollect = details the bot should ASK the customer for. Never mix FAQ and intake. Keep informationToCollect null until the owner lists details to collect; [] if they say collect nothing; otherwise the listed strings.
- When the owner later clarifies an unknown or changes a fact or conversation setting (supported and clear, or after they accepted an offered alternative), immediately update the relevant draft fields (e.g. put the full pricing rule into services[].price; put the full FAQ answer into commonQuestions[].answer; update tone/priceDisclosure), remove resolved unknowns, and reply with a one-line acknowledgment only — no summary, no questions, no bullet list (the app shows the summary and options). Do not ignore a clear clarification to ask about a different topic first. Preserve unrelated settings and business facts.

You MUST respond with a single JSON object matching the schema (all keys required; no markdown fences).
draft is a delta: null means unchanged this turn (reset flags: false unless the owner asked to clear that identity field). Do not re-emit unchanged text or unchanged list items. Code keeps previous values and merges.
- services / commonQuestions: only new or changed items this turn (empty array if none). Removals and non-additive edits also go in ownerEdits.
- unknowns: only NEW undecided items this turn (empty array if none). Drop answered ones via resolvedUnknowns.
- informationToCollect: the full list if the owner answered or changed it this turn; null if they did not.
- newFacts (top-level, not inside draft): otherFacts the owner states this turn that are not already stored (empty array if none).
ownerEdits: stored services, FAQ, intake, name, whatWeDo, hours, or locationOrArea the owner's CURRENT message changes or removes. field = draft key; item = the stored key (null for text fields). Adding a new item is not an edit.
factEdits: stored otherFacts (by index shown in the context) the owner's CURRENT message corrects (text = corrected fact) or withdraws (text = null). Empty if none.
resolvedUnknowns: indexes of stored unknowns (numbered in the context) that the owner's CURRENT message answers; store the answer in its field. unknowns holds only what the owner said is undecided — never a stated fact.
onPurpose, configRequests: as specified above. Arrays empty if none.
${PARAGRAPH_PROMPT_LINE}`;

export { SYSTEM as BUILDER_SYSTEM };

export function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing — set it in .env');
  return new OpenAI({ apiKey: key });
}

/** Lowest efforts to try when a model rejects temperature / a given effort. */
export const BUILDER_REASONING_EFFORTS = ['none', 'minimal', 'low'];
const REASONING_COMPLETION_CAP = 4000;
const chatParamCache = new Map();

export function resetBuilderChatParamCache() {
  chatParamCache.clear();
}

function apiErrorText(err) {
  return [
    err?.message,
    err?.error?.message,
    err?.code,
    err?.error?.code,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Initial Chat Completions body for a Builder turn (classic models keep temperature). */
export function builderChatParams({ model, messages, response_format, temperature = 0.4 }) {
  return { model, messages, response_format, temperature };
}

/**
 * Adjust a Chat Completions body after a 4xx. Returns a new body or null if
 * the error is not a known parameter incompatibility.
 */
export function adjustChatParamsOnError(params, err) {
  const msg = apiErrorText(err);
  const next = { ...params };
  let changed = false;

  if (/temperature|top_p|top_logprobs|logprobs|presence_penalty|frequency_penalty/i.test(msg)) {
    if ('temperature' in next) {
      delete next.temperature;
      changed = true;
    }
    if (!next.reasoning_effort) {
      next.reasoning_effort = BUILDER_REASONING_EFFORTS[0];
      changed = true;
    }
    if (next.max_completion_tokens == null) {
      next.max_completion_tokens = REASONING_COMPLETION_CAP;
      changed = true;
    }
  }

  if (/max_tokens/i.test(msg) && !/max_completion_tokens/i.test(msg)) {
    delete next.max_tokens;
    next.max_completion_tokens = next.max_completion_tokens ?? REASONING_COMPLETION_CAP;
    changed = true;
  }

  if (/reasoning_effort|reasoning\.effort/i.test(msg)) {
    const cur = next.reasoning_effort || BUILDER_REASONING_EFFORTS[0];
    const i = BUILDER_REASONING_EFFORTS.indexOf(cur);
    const nxt = BUILDER_REASONING_EFFORTS[i + 1];
    if (nxt) {
      next.reasoning_effort = nxt;
      delete next.temperature;
      next.max_completion_tokens = next.max_completion_tokens ?? REASONING_COMPLETION_CAP;
      changed = true;
    }
  }

  return changed ? next : null;
}

async function createBuilderCompletion(client, base) {
  let params = chatParamCache.has(base.model)
    ? { ...chatParamCache.get(base.model), messages: base.messages, response_format: base.response_format }
    : builderChatParams(base);

  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const completion = await client.chat.completions.create(params);
      const stored = { ...params };
      delete stored.messages;
      chatParamCache.set(base.model, stored);
      return { completion, params };
    } catch (err) {
      lastErr = err;
      const next = adjustChatParamsOnError(params, err);
      if (!next) break;
      params = { ...next, messages: base.messages, response_format: base.response_format };
    }
  }
  throw lastErr;
}

function reasoningTokensFromUsage(usage) {
  const n = usage?.completion_tokens_details?.reasoning_tokens;
  return Number.isFinite(n) ? n : 0;
}

function parseJsonResponse(content) {
  let text = (content || '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  return JSON.parse(text);
}


/** True once the owner has answered the intake question (array, possibly empty). */
export function hasAnsweredInformationToCollect(draftOrProfile) {
  return Array.isArray(draftOrProfile?.informationToCollect);
}

const CONSISTENCY_TEXT_FIELDS = [
  'name',
  'whatWeDo',
  'hours',
  'locationOrArea',
  'openingMessage',
];

function textValue(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

function serviceSnapshot(row) {
  return { price: row?.price ?? null, notes: row?.notes ?? null };
}

/**
 * Already-stored values that this turn modified or removed.
 * Derived from the previous vs next draft only (no owner text).
 * Additions (new services, FAQ, otherFacts, or filling a blank field) are ignored.
 */
export function existingValueChanges(previousDraft, nextDraft) {
  const prev = previousDraft || {};
  const next = nextDraft || {};
  const changes = [];

  const prevServices = Array.isArray(prev.services) ? prev.services : [];
  const nextServices = Array.isArray(next.services) ? next.services : [];
  for (const old of prevServices) {
    if (!old?.name) continue;
    const found = nextServices.find((x) => x && sameKey(x.name, old.name));
    if (!found) {
      changes.push({
        field: 'services',
        item: old.name,
        oldValue: serviceSnapshot(old),
        newValue: null,
      });
      continue;
    }
    if (
      !sameKey(old.price ?? '', found.price ?? '') ||
      !sameKey(old.notes ?? '', found.notes ?? '')
    ) {
      changes.push({
        field: 'services',
        item: old.name,
        oldValue: serviceSnapshot(old),
        newValue: serviceSnapshot(found),
      });
    }
  }

  const prevFaq = Array.isArray(prev.commonQuestions) ? prev.commonQuestions : [];
  const nextFaq = Array.isArray(next.commonQuestions) ? next.commonQuestions : [];
  for (const old of prevFaq) {
    if (!old?.question) continue;
    const found = nextFaq.find((x) => x && sameKey(x.question, old.question));
    if (!found) {
      changes.push({
        field: 'commonQuestions',
        item: old.question,
        oldValue: old.answer ?? '',
        newValue: null,
      });
      continue;
    }
    if (!sameKey(old.answer ?? '', found.answer ?? '')) {
      changes.push({
        field: 'commonQuestions',
        item: old.question,
        oldValue: old.answer ?? '',
        newValue: found.answer ?? '',
      });
    }
  }

  for (const field of CONSISTENCY_TEXT_FIELDS) {
    const before = textValue(prev[field]);
    const after = textValue(next[field]);
    if (before && !sameKey(before, after)) {
      changes.push({
        field,
        item: null,
        oldValue: before,
        newValue: after || null,
      });
    }
  }

  const prevFacts = Array.isArray(prev.otherFacts) ? prev.otherFacts : [];
  const nextFacts = Array.isArray(next.otherFacts) ? next.otherFacts : [];
  for (let i = 0; i < prevFacts.length; i++) {
    const old = prevFacts[i];
    if (typeof old !== 'string' || !old.trim()) continue;
    if (nextFacts.some((x) => sameKey(x, old))) continue;
    changes.push({
      field: 'otherFacts',
      item: String(i),
      oldValue: old,
      newValue: null,
    });
  }

  return changes;
}

const CONSISTENCY_SYSTEM = `You keep stored business text consistent with the latest facts.
You receive facts that changed or were removed, and the current draft.
Return updates only for stored text that still states an old fact.
Do not invent facts. Do not add new items. Null or an empty array means no change.`;

function draftForConsistency(draft) {
  const d = draft || {};
  return {
    name: d.name ?? null,
    whatWeDo: d.whatWeDo ?? null,
    services: Array.isArray(d.services) ? d.services : [],
    hours: d.hours ?? null,
    locationOrArea: d.locationOrArea ?? null,
    commonQuestions: Array.isArray(d.commonQuestions) ? d.commonQuestions : [],
    otherFacts: Array.isArray(d.otherFacts) ? d.otherFacts : [],
    openingMessage: d.openingMessage ?? null,
  };
}

async function requestConsistencyUpdates({ nextDraft, changes, model }) {
  const client = getClient();
  const { completion } = await createBuilderCompletion(client, {
    model,
    messages: [
      { role: 'system', content: CONSISTENCY_SYSTEM },
      {
        role: 'user',
        content: JSON.stringify(
          { changes, draft: draftForConsistency(nextDraft) },
          null,
          2
        ),
      },
    ],
    response_format: consistencyResponseFormat(),
    temperature: 0,
  });
  const choice = completion.choices[0]?.message;
  if (choice?.refusal) throw new Error('refusal');
  return parseJsonResponse(choice?.content || '{}');
}

/**
 * When an existing stored value was modified or removed, ask a small structured
 * call to update other stored text that still states the old fact.
 * Add-only turns skip the call. Failures keep `nextDraft`.
 */
export async function runConsistencyPass(previousDraft, nextDraft, opts = {}) {
  const changes = existingValueChanges(previousDraft, nextDraft);
  if (!changes.length) {
    return { draft: nextDraft, ran: false, latencyMs: 0, changes };
  }
  const started = Date.now();
  try {
    const updates = opts.complete
      ? await opts.complete({ previousDraft, nextDraft, changes })
      : await requestConsistencyUpdates({
          nextDraft,
          changes,
          model: opts.model,
        });
    return {
      draft: applyConsistencyUpdates(nextDraft, updates),
      ran: true,
      latencyMs: Date.now() - started,
      changes,
    };
  } catch {
    return {
      draft: nextDraft,
      ran: true,
      latencyMs: Date.now() - started,
      changes,
    };
  }
}

const CONFIG_REQUEST_STATUSES = ['supported', 'ambiguous', 'unsupported'];
const SETTING_KEYS = [...BEHAVIOR_KEYS, ...IDENTITY_KEYS];

function normalizeConfigRequests(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const alternative =
        typeof r.alternative === 'string' && r.alternative.trim()
          ? r.alternative.trim()
          : null;
      let status = CONFIG_REQUEST_STATUSES.includes(r.status) ? r.status : 'ambiguous';
      // Offering an alternative means the request as asked was not accepted.
      if (status === 'supported' && alternative) status = 'ambiguous';
      return {
        request: String(r.request ?? '').trim(),
        status,
        field: typeof r.field === 'string' && r.field.trim() ? r.field.trim() : null,
        alternative,
      };
    });
}

function restoreField(next, prev, key) {
  next[key] =
    prev[key] === undefined ? null : JSON.parse(JSON.stringify(prev[key]));
  if (IDENTITY_KEYS.includes(key)) {
    const flag = identityResetFlag(key);
    next[flag] = prev[flag] === true;
  }
}

/**
 * A config request the Builder marked unsupported/ambiguous must not change the
 * draft. Restores its field, and — when any request is unresolved — restores
 * every setting field that changed this turn without a supported request
 * naming it (blocks writing unsupported behavior into free-text settings).
 */
export function enforceConfigRequests(draft, currentDraft, configRequests) {
  const requests = normalizeConfigRequests(configRequests);
  const unresolved = requests.filter((r) => r.status !== 'supported');
  if (!unresolved.length) return { draft, unresolved };

  const next = { ...draft };
  const prev = currentDraft || {};
  const supportedFields = new Set(
    requests.filter((r) => r.status === 'supported' && r.field).map((r) => r.field)
  );

  for (const r of unresolved) {
    if (r.field && (r.field in next || r.field in prev)) {
      restoreField(next, prev, r.field);
    }
  }
  for (const key of SETTING_KEYS) {
    if (supportedFields.has(key)) continue;
    if (JSON.stringify(next[key] ?? null) !== JSON.stringify(prev[key] ?? null)) {
      restoreField(next, prev, key);
    }
  }
  return { draft: next, unresolved };
}

export async function runBuilderTurn({
  buildHistory,
  profile,
  userMessage,
  model: modelOverride,
  mode = 'delta',
  consistencyComplete,
  client: clientOverride,
} = {}) {
  const client = clientOverride || getClient();
  const model = modelOverride || process.env.OPENAI_BUILDER_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const legacy = mode === 'legacy';

  const currentDraft = seedStoredDraft(
    profile.draft || {
      name: profile.name,
      whatWeDo: profile.whatWeDo,
      services: profile.services,
      hours: profile.hours,
      locationOrArea: profile.locationOrArea,
      commonQuestions: profile.commonQuestions,
      informationToCollect:
        profile.informationToCollect === undefined
          ? null
          : profile.informationToCollect,
      unknowns: profile.unknowns || [],
      otherFacts: profile.otherFacts || [],
      tone: profile.tone,
      priceDisclosure: profile.priceDisclosure ?? null,
      openingMessage: profile.openingMessage ?? null,
    },
    profile
  );

  const justAsked = topicJustAsked(buildHistory);
  const { otherFacts: storedFacts = [], ...draftForModel } = currentDraft;
  const contextNote = [
    'Current draft profile JSON:',
    JSON.stringify(draftForModel, null, 2),
    'Stored otherFacts (edit only via factEdits, by index):',
    storedFacts.length ? storedFacts.map((f, i) => `[${i}] ${f}`).join('\n') : '(none)',
    'Stored unknowns (report answered ones in resolvedUnknowns, by index):',
    currentDraft.unknowns?.length ? currentDraft.unknowns.map((u, i) => `[${i}] ${u}`).join('\n') : '(none)',
    profile.approvedAt
      ? `Ready since: ${profile.approvedAt}`
      : 'First-time setup still open.',
    ...(justAsked?.answerHint ? [`Hint: ${justAsked.answerHint}`] : []),
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: contextNote },
    ...buildHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];
  const responseFormat = legacy ? { type: 'json_object' } : builderResponseFormat();
  const previousOutgoing = lastOutgoingMessage(buildHistory);

  const completeOnce = async (retryNote) => {
    const started = Date.now();
    const { completion, params: requestParams } = await createBuilderCompletion(client, {
      model,
      messages: retryNote ? messagesWithRetryNote(messages, retryNote) : messages,
      response_format: responseFormat,
    });
    const latencyMs = Date.now() - started;
    const choice = completion.choices[0]?.message;
    const raw = choice?.content || '{}';
    let parsed;
    try {
      if (choice?.refusal) throw new Error('refusal');
      parsed = parseJsonResponse(raw);
    } catch {
      parsed = {
        message: raw && !choice?.refusal ? raw : PARSE_FALLBACK_MESSAGE,
        draft: currentDraft,
        newFacts: [],
        onPurpose: true,
        topicResponse: null,
      };
    }
    return { completion, requestParams, latencyMs, parsed };
  };

  const sentText = (parsed) =>
    parsed?.onPurpose === false
      ? OFF_PURPOSE_OWNER_REPLY
      : formatModelReply(parsed?.message || '');

  const { completion, requestParams, latencyMs, parsed } = await generateWithIdenticalRetry({
    generate: completeOnce,
    extractText: (result) => sentText(result.parsed),
    previousOutgoing,
    label: 'Builder',
  });

  if (parsed.onPurpose === false) {
    return {
      message: OFF_PURPOSE_OWNER_REPLY,
      draft: currentDraft,
      onPurpose: false,
      consistencyMs: 0,
      consistencyRan: false,
      configRequests: [],
      usage: completion.usage,
      latencyMs,
      modelJson: parsed,
      reasoningEffort: requestParams.reasoning_effort ?? null,
      reasoningTokens: reasoningTokensFromUsage(completion.usage),
      source: 'real-llm',
    };
  }

  const preserved = applyBuilderModelOutput(parsed, currentDraft, {
    mode: legacy ? 'legacy' : 'delta',
    live: profile,
  });

  const { draft: mergedDraft, unresolved } = enforceConfigRequests(
    preserved,
    currentDraft,
    parsed.configRequests
  );

  const pass = await runConsistencyPass(currentDraft, mergedDraft, {
    model,
    complete: consistencyComplete,
  });
  const draft = pass.draft;

  const message = formatModelReply(
    parsed.message || 'Tell me a bit more about your business.'
  );

  const topicResponse =
    parsed.topicResponse === 'answered' ||
    parsed.topicResponse === 'skipped' ||
    parsed.topicResponse === 'unclear'
      ? parsed.topicResponse
      : null;

  return {
    message,
    draft,
    onPurpose: true,
    consistencyMs: pass.latencyMs,
    consistencyRan: pass.ran,
    configRequests: normalizeConfigRequests(parsed.configRequests),
    topicResponse,
    usage: completion.usage,
    latencyMs,
    modelJson: parsed,
    reasoningEffort: requestParams.reasoning_effort ?? null,
    reasoningTokens: reasoningTokensFromUsage(completion.usage),
    source: 'real-llm',
  };
}


/**
 * Application save-card gate (runs after every Builder turn, real or stubbed).
 * Required topics are asked before the first save card. After ready, unresolved
 * config stays a model-only clarification; a changed draft gets a save card.
 * The session layer applies the draft immediately and appends the card or menu.
 */
export function applyReviewGate(profile, turn, userMessage, extras = {}) {
  return gateTurn(profile, turn, extras);
}

function askFixedTopic(turn, draft, topic, lead, { keepLead = false } = {}) {
  return {
    ...turn,
    draft: {
      ...draft,
      askedTopics: [...new Set([...draft.askedTopics, topic.key])],
    },
    presentReview: false,
    asksQuestion: true,
    message: composeReply({
      kind: 'ask_topic',
      modelText: turn.message,
      parts: { topic, ack: lead, draft, keepLead },
    }).reply,
  };
}

export function hasUnresolvedConfig(turn) {
  const requests = turn?.configRequests;
  if (!Array.isArray(requests) || !requests.length) return false;
  return requests.some((r) => r && r.status !== 'supported');
}

function gateTurn(profile, turn, extras = {}) {
  const priorAsked = Array.isArray(profile.draft?.askedTopics) ? profile.draft.askedTopics : [];
  const draft = {
    ...turn.draft,
    askedTopics: [...new Set([...priorAsked, ...(turn.draft?.askedTopics || [])])],
  };

  if (ownerPhase(null, profile) === 'ready') {
    if (hasUnresolvedConfig(turn)) {
      return {
        ...turn,
        draft,
        presentReview: false,
        asksQuestion: false,
      };
    }
    if (draftDiffersFromLive(profile, draft)) {
      return {
        ...turn,
        draft,
        presentReview: true,
        asksQuestion: false,
        message: reviewAck(turn.message),
      };
    }
    return {
      ...turn,
      draft,
      presentReview: false,
      asksQuestion: false,
    };
  }

  const agenda = stepSetupAgenda({
    priorAsked,
    draftAfterExtract: draft,
    modelMessage: turn.message,
    unresolvedConfig: hasUnresolvedConfig(turn),
    topicResponse: turn.topicResponse,
    justAsked: extras.justAsked,
    priorDraft: profile.draft,
  });
  const nextDraft = { ...draft, askedTopics: agenda.askedTopics };

  if (agenda.stay) {
    return {
      ...turn,
      draft: nextDraft,
      presentReview: false,
      asksQuestion: false,
    };
  }

  if (agenda.topic) {
    return askFixedTopic(turn, nextDraft, agenda.topic, agenda.ack, {
      keepLead: agenda.keepLead === true,
    });
  }

  if (agenda.step === 'identity' && agenda.question) {
    return {
      ...turn,
      draft: nextDraft,
      presentReview: false,
      asksQuestion: true,
      message: composeReply({ kind: 'ask_identity', modelText: turn.message }).reply,
    };
  }

  if (
    agenda.presentComplete &&
    firstSetupSettled(profile, nextDraft) &&
    hasEnoughForFirstBot(mergeDraft(profile, nextDraft))
  ) {
    return {
      ...turn,
      draft: nextDraft,
      presentReview: true,
      asksQuestion: false,
      message: reviewAck(turn.message),
    };
  }

  return {
    ...turn,
    draft: nextDraft,
    presentReview: false,
    asksQuestion: false,
  };
}

export function openingMessage() {
  return {
    message: composeReply({ kind: 'opening' }).reply,
    source: 'app',
  };
}
