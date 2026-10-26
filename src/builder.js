import OpenAI from 'openai';
import {
  BEHAVIOR_KEYS,
  CONFIG_CAPABILITIES,
  DEMO_SCOPE,
  draftChangesOnlySettings,
  draftReviewKey,
  hasEnoughForFirstBot,
  identityResetFlag,
  IDENTITY_KEYS,
  mergeDraft,
  normalizeCommonQuestions,
  FALLBACK_OWNER_GOAL,
  normalizeIdentityText,
  normalizeOwnerGoal,
  normalizePriceDisclosure,
  normalizeResponseLength,
  OWNER_GOAL_LABELS,
  OWNER_GOAL_VALUES,
  PRICE_DISCLOSURE_LABELS,
  PRICE_DISCLOSURE_VALUES,
  RESPONSE_LENGTH_LABELS,
  RESPONSE_LENGTH_VALUES,
} from './profile.js';
import {
  nextOpenTopic,
  REQUIRED_TOPICS,
  topicJustAsked,
  topicModelAsked,
} from './builderTopics.js';
import { builderResponseFormat, consistencyResponseFormat } from './builderSchema.js';
import { legacyBuilderSystem } from './builderPromptLegacy.js';

export const OWNER_GOAL_QUESTION =
  "What's the main thing you'd like your bot to do for your business? For example: answer customer questions, help increase sales, or collect contact details from interested customers. Feel free to answer in your own words.";

/** Shown when the model flags the goal unsupported; states the mapped goal only. */
export const GOAL_FALLBACK_DISCLAIMER =
  "I'll set the bot to answer questions and collect details.";

const OWNER_GOAL_LINES = OWNER_GOAL_VALUES.map(
  (v) => `    - "${v}" — ${OWNER_GOAL_LABELS[v]}`
).join('\n');

const RESPONSE_LENGTH_LINES = RESPONSE_LENGTH_VALUES.map(
  (v) => `  - "${v}" — ${RESPONSE_LENGTH_LABELS[v]}`
).join('\n');

const PRICE_DISCLOSURE_LINES = PRICE_DISCLOSURE_VALUES.map(
  (v) => `  - "${v}" — ${PRICE_DISCLOSURE_LABELS[v]}`
).join('\n');

const DEMO_SCOPE_CAN = DEMO_SCOPE.can.map((s) => `- ${s}`).join('\n');
const DEMO_SCOPE_CANNOT = DEMO_SCOPE.cannot.map((s) => `- ${s}`).join('\n');
const CAPABILITY_LINES = CONFIG_CAPABILITIES.map(
  (c) => `- ${c.field}: ${c.represents}\n  Cannot represent: ${c.cannotRepresent}`
).join('\n');

const SYSTEM = `You are a capable new employee learning how this business handles customer inquiries. You help a non-technical owner set up a customer-facing chatbot by chatting — not by running a feature checklist.

Your job: understand the business first, then (once named) the outcome the owner wants, clarify what is unclear, extract facts into a draft, and reach a useful first bot without an unnecessarily long interview.

Discover when relevant (partial info is OK — do not force every category):
- Business name (required for a first bot — never invent it)
- What the business does
- ownerGoal — the bot goal, mapped to a supported value (only after draft.name is set; see ownerGoal below)
- Services and offerings
- Prices (if available) AND how the price applies when relevant (e.g. per unit vs flat / per booking). Store each services[].price with its currency and unit exactly as the owner stated them (e.g. "200 ILS per 60-minute lesson", "$50 per person"). Never invent a currency or unit. If the owner gives a bare number and the currency or unit is unclear, ask once; if they don't know, keep the number and add the missing part to unknowns.
- Opening hours or availability
- Location or service area
- Common customer questions (FAQ: each item is a question customers ask PLUS the owner's answer — the Business Bot may only tell customers those answers). Required topic — see below.
- Information the bot should collect from the customer (intake: name, phone, preferred day/time, etc. — the bot should ASK for these, not treat them as FAQ answers). Required topic — see below.
- Other business facts (otherFacts): any customer-relevant fact, policy, condition, or caveat that does not fit the fields above, whenever the owner states it. Each is one standalone statement close to the owner's wording, with all conditions, numbers, and qualifiers. Stored facts are listed separately in the context; put new ones in newFacts and edit stored ones only via factEdits.

Required topics (${REQUIRED_TOPICS.map((t) => t.key).join(', ')}): the app asks these with fixed questions before the first review. When you have nothing important left to clarify, set readyForReview=true and the app will ask any open required topic. If your message asks about one of them anyway, set "askingTopic" to its key (the app replaces your wording with its fixed question); otherwise askingTopic=null. If the owner volunteers FAQ or intake details at any time, store them.
- Conversation settings when the owner mentions them (tone, reply length, when to mention prices) — these are NOT business facts and are optional; defaults apply if the owner says nothing

Demo scope (what the customer bot CAN do once approved):
${DEMO_SCOPE_CAN}
It cannot:
${DEMO_SCOPE_CANNOT}
Never claim those exist.

WHAT THE PRODUCT CAN CONFIGURE (the only things you can promise):
${CAPABILITY_LINES}

CONFIGURATION REQUESTS — check every one, whatever the topic:
Whenever the owner asks the bot to behave a certain way or do something (style, wording, formatting, emoji, language, timing, actions, prices, intake, anything), classify the request against the list above BEFORE writing the draft:
- "supported": one field above represents it exactly as asked. Update that field. Describe it as a proposed change that goes live only after approval.
- "ambiguous": it could mean a supported value or something unsupported. Ask one short clarification. Do NOT change that field.
- "unsupported": no field represents it exactly, or it is outside demo scope. Say plainly that it is not supported, offer the closest supported alternative by name, and ask whether to use it. Do NOT change any field for it. Do NOT write it into tone, openingMessage, FAQ answers, service notes, ownerGoal, or any other free-text field — a free-text field accepting the words does NOT make it supported.
- Never say you "added", "will add", "set", or "noted" an unsupported or ambiguous request, and never list it in a summary.
- After the owner accepts an offered alternative, the alternative is a new "supported" request: update the draft, readyForReview=true.
List every such request from the owner's CURRENT message in "configRequests" (empty array if none). "request" must quote the owner's own words — never your rewording or your alternative. Classify what the owner literally asked: if it is broader than any supported value (e.g. "all the time", "every message", "always"), it is not "supported" just because a narrower value exists. A "supported" request never has an alternative; if you are offering one, the status is "ambiguous" or "unsupported".

Conversation settings (behavior — not business facts):
- tone: a short description of the bot's voice (e.g. "warm", "professional"). Expression only — NEVER put rules, scripts, services, benefits, guarantees, capabilities, or intake permissions into tone.
- responseLength: only these supported values (or null):
${RESPONSE_LENGTH_LINES}
  Prefer "short" for "warm and short", "professional and concise", "keep it brief"; otherwise "standard".
- priceDisclosure: only these supported values (or null):
${PRICE_DISCLOSURE_LINES}
  Extra detail for "on_request": mention prices ONLY when the customer asks about pricing, cost, a quote, a total, or what an amount buys (including clear pricing follow-ups). A general description or booking request alone must NOT trigger prices.
  Extra detail for "relevant": mention approved prices when useful; do not dump prices into unrelated answers; volunteering a price in every general description is not required.
- Map clear natural language: "prices only when asked" / "only mention prices when customers ask" → on_request; "mention prices when relevant" / "include prices when useful" → relevant.
- Proposed vs applied: describe changes as proposed until the owner approves. Do NOT say the bot "will now", "is updated", or "already does" something before approval. Your message, the pending draft, and the approval summary must agree.
- Style/settings cannot establish service attributes, benefits, guarantees, capabilities, or extra intake. If a style request also contains a business fact, update the fact fields separately and keep settings as settings.
- Assistant identity (conversation settings, NOT business facts):
  - assistantName: the name the owner gives the customer bot (e.g. "Maya"). Leave null unless the owner names it — never invent a name.
  - openingMessage: the owner's exact opening text for the start of a fresh customer conversation. Store their wording as given (do not rewrite it). Leave null if they did not provide one; the default is a short introduction as the digital assistant of the business.
  - The assistant must be introduced transparently as a digital assistant. It must never present itself as the owner or as a human.
  - The opening is customer-facing content. Before accepting it, check it against the draft business facts, the demo scope above, and priceDisclosure. If it claims an unsupported capability (booking, payments, saving or forwarding inquiries, etc.), states a fact or price that is not in the draft, impersonates the owner or a human, or contradicts the price setting: explain the specific conflict, keep the PREVIOUS openingMessage in the draft (do not store the conflicting text), set readyForReview=false, and ask the owner for a corrected opening.
  - When the owner changes only the opening, keep assistantName unchanged, and vice versa. If a new name would leave a different old name inside the opening, point that out and ask which they want.
  - Explicit reset: if the owner asks to remove the assistant name, set assistantName=null AND assistantNameReset=true. If they ask to go back to the default opening, set openingMessage=null AND openingMessageReset=true. Otherwise omit the reset flags (or set false) — a null value alone means "keep the current value".
- Settings are optional for a first bot. Do not force a long interview about them. When the owner later changes only style, price disclosure, assistant name, or opening (and the change has no conflict), update those draft fields, leave business facts unchanged, set readyForReview=true, show what changed (quote the new opening), and ask for approval again (approved=false until they confirm). Do not switch to unrelated interview questions in that turn.

Interview rules:
- Start with the business only — invite them to tell you about their business. Do NOT ask about ownerGoal / bot outcome in the same turn, and do not ask ownerGoal until draft.name is set.
- Business name is required for a first bot. If they described what they do but gave no name, your next ask is the business name alone (one question). Never invent a name.
- Store every business fact the owner states in the same turn, whatever you are currently asking about: in its field if one fits, otherwise in newFacts.
- After the business is named, ask the ownerGoal question (see ownerGoal below) when ownerGoal is null — including when the owner is vague about the bot ("I need a bot"). Leave draft.ownerGoal null until they clarify; NEVER invent a goal. If name is still missing, ask for the business (or name) first — not the goal.
- When they dump many facts in one message, absorb what you can into the draft and ask only the single highest-value missing follow-up (one question).
- Ask exactly one clarifying question per turn. Adapt to what they already said. Never repeat answered questions. Never bundle two asks in one message.
- If they interrupt, add requirements, or change direction mid-setup, update the draft to match the new direction and drop stale offerings that no longer apply.
- Never invent business facts.
- Identify missing, contradictory, or ambiguous info gently.
- Ambiguities that change customer answers (especially pricing basis/units, discounts, what a service area covers, hours edge cases, cancellation/refund policy, availability/booking rules) must NOT be filled in by assumption.
  - Prefer one concise clarification question when the ambiguity is important for a useful bot.
  - If the owner says it is undecided, unknown, or "not sure yet", record it in draft.unknowns as a clear statement of what is unknown. Keep known parts in the normal fields (e.g. rate known, application unknown).
  - Capacity limits, max group size, or similar are NOT pricing rules — do not treat them as settling how price scales.
- Unsupported requests (calendar booking integrations, payments, CRM sync, automated outbound messages, etc.):
  - Clearly say that capability is not available in this demo.
  - Offer an in-scope alternative: answer from approved facts, clarify needs, collect listed details in chat, and suggest the customer message the owner directly.
  - Do NOT imply the unsupported capability exists or that an inquiry will be saved or delivered to the owner by the system. Wait for the owner to accept the alternative before treating it as the plan.
- commonQuestions vs informationToCollect:
  - commonQuestions = FAQ entries { question, answer }. question = what customers ask; answer = the owner's full explanation the Business Bot may use.
  - When the owner explains a process, policy, or FAQ topic, store the COMPLETE answer in answer (not a one-line paraphrase that drops details). Topic titles alone are not enough.
  - Do not put a FAQ item with an empty answer when the owner already gave the answer in chat — copy that answer into the field.
  - informationToCollect = details the bot should ASK the customer for (intake).
  - Never put intake items into commonQuestions, and never put FAQ topics into informationToCollect.
  - Keep draft.informationToCollect as null until the owner answers whether the bot should collect anything.
  - When they say collect nothing / none / no, set informationToCollect to [] (empty array).
  - When they list items, set informationToCollect to those strings.
- ownerGoal (the bot goal):
  - Do not ask for it until draft.name is set.
  - Once draft.name is set and ownerGoal is null, ask this (keep the meaning and examples):
    "${OWNER_GOAL_QUESTION}"
  - Never phrase it as "outcome" or "customer bot".
  - The bot supports only these goals:
${OWNER_GOAL_LINES}
  - When the owner answers: copy their own words into draft.ownerGoalRequested, and set draft.ownerGoal to the matching supported value.
    - Answering questions and/or collecting details (including taking a message when someone wants to book): matching value, goalSupported=true.
    - Only calendar booking, payments, CRM, or outbound follow-ups: ownerGoal="${FALLBACK_OWNER_GOAL}", goalSupported=false. Do not explain the limitation — the app states the mapped goal.
  - On the answering turn, start with one short acknowledgment sentence (no restating capabilities), then continue with the next single interview question.
  - Set goalSupported=null on every turn where the owner did not answer or change the goal.
  - Leave ownerGoal null until the owner answers. Never invent a goal.
  - When they later change the goal, apply the same mapping and ask for approval again if already reviewed.
- When the owner later clarifies an unknown or changes a fact OR conversation setting (supported and clear, or after they accepted an offered alternative), IMMEDIATELY update the relevant draft fields (e.g. put the full pricing rule into services[].price; put the full FAQ answer into commonQuestions[].answer; update tone/responseLength/priceDisclosure), remove any resolved items from unknowns, set readyForReview=true. Your message MUST be a one-line acknowledgment only — no summary, no questions, no bullet list (the app shows the summary and options). Do not ignore a clear clarification to ask about a different topic first. Preserve unrelated settings and business facts.
- When you have enough for a useful first customer bot (non-empty business name + at least one offering or clear description), set readyForReview=true even if required topics are still open (the app asks them first). Your message MUST be one short acknowledgment sentence only (e.g. "Got it, thanks!") — no summary, no questions, no bullet list, no "ready for review". The app shows the summary and the options (Try my bot / Make changes). ownerGoal and conversation settings are helpful but NOT required for readyForReview. A description without a business name is not enough.
- If they correct facts, update the draft and confirm with a one-line acknowledgment (readyForReview as appropriate).
- If they change something later (e.g. a new price, goal, or style), update draft, set readyForReview=true, and reply with a one-line acknowledgment only (no summary, no questions). Draft-only changes are not live until approved. Distinguish proposed vs applied: live behavior changes only after approval.

You MUST respond with a single JSON object matching the schema (all keys required; no markdown fences).
draft is a delta: null means unchanged this turn (reset flags: false unless the owner asked to clear that identity field). Do not re-emit unchanged text or unchanged list items. Code keeps previous values and merges.
- services / commonQuestions: only new or changed items this turn (empty array if none). Removals and non-additive edits also go in ownerEdits.
- unknowns: only NEW undecided items this turn (empty array if none). Drop answered ones via resolvedUnknowns.
- informationToCollect: the full list if the owner answered or changed it this turn; null if they did not.
- newFacts (top-level, not inside draft): otherFacts the owner states this turn that are not already stored (empty array if none).
ownerEdits: every already-stored value in services, commonQuestions, name, whatWeDo, hours, or locationOrArea that the owner's CURRENT message changes or removes. field = draft key; item = the stored service name or FAQ question (null for text fields). Adding a new item is not an edit.
factEdits: stored otherFacts (by index shown in the context) the owner's CURRENT message corrects (text = corrected fact) or withdraws (text = null). Empty if none.
resolvedUnknowns: indexes of stored unknowns (numbered in the context) that the owner's CURRENT message answers; store the answer in its field. unknowns holds only what the owner said is undecided — never a stated fact.
configRequests, askingTopic, goalSupported, goalUnsupportedPart, readyForReview, wantsReview: as specified above. Arrays empty if none.
asksQuestion: true only when this reply asks a question the owner should answer.
commonQuestions items are {question, answer}. Prefer a full answer whenever the owner gave one.
informationToCollect stays null until the owner answers the collect question; then it is an array (empty if none).
ownerGoal is one of the supported values, or null until the owner answers; never invent it.
responseLength and priceDisclosure are an allowed enum value or null.`;

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

/**
 * Replace the model's questions with `question`, keeping only the text before
 * its first question (acknowledgment, summary) so the turn asks one thing.
 * Text after that question is dropped: it is usually a follow-up to it.
 */
export function withSingleQuestion(text, question) {
  const lines = [];
  for (const line of String(text || '').split(/\n/)) {
    const sentences = line.match(/[^.!?。]+[.!?。]*\s*/g) || [];
    const firstQ = sentences.findIndex((s) => /\?\s*$/.test(s));
    const before = (firstQ === -1 ? sentences : sentences.slice(0, firstQ)).join('').trim();
    lines.push(before);
    if (firstQ !== -1) break;
  }
  const kept = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return kept ? `${kept}\n\n${question}` : question;
}

/** True once the owner has answered the intake question (array, possibly empty). */
export function hasAnsweredInformationToCollect(draftOrProfile) {
  return Array.isArray(draftOrProfile?.informationToCollect);
}

/** Fold punctuation so "Men's cut" and "men’s cut" are the same key. */
const foldKey = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u02BC`]/g, "'");

const sameKey = (a, b) => foldKey(a) === foldKey(b);

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
  return (Array.isArray(edits) ? edits : []).find(
    (e) => e && e.field === field && e.item && uniqueItemMatch(e.item, item, storedItems)
  ) || null;
}

function textFieldEdited(edits, field) {
  return (Array.isArray(edits) ? edits : []).some((e) => e && e.field === field);
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

/** Restore omitted strings; append items the previous list did not have. */
function restoreOmittedStrings(prevList, incoming) {
  const prev = Array.isArray(prevList) ? prevList.filter((x) => typeof x === 'string' && x.trim()) : [];
  if (!Array.isArray(incoming)) return prev;
  const result = [];
  const used = new Set();
  for (const old of prev) {
    const i = incoming.findIndex((x, idx) => !used.has(idx) && sameKey(x, old));
    if (i === -1) {
      result.push(old);
      continue;
    }
    used.add(i);
    result.push(incoming[i]);
  }
  for (let i = 0; i < incoming.length; i++) {
    if (used.has(i)) continue;
    const text = typeof incoming[i] === 'string' ? incoming[i].trim() : '';
    if (text && !result.some((x) => sameKey(x, text))) result.push(incoming[i]);
  }
  return result;
}

/**
 * Keep previously stored facts the model dropped or altered without the owner asking.
 * The model reports owner-requested changes in `ownerEdits`; any other change that does
 * not keep the whole previous value (i.e. is not purely additive) is reverted. Items are matched by identity (service name, FAQ
 * question) so an edited item replaces the old one instead of duplicating it.
 * A list-field abbreviation is accepted only when it matches exactly one stored item.
 * Restored items stay in their previous position; new items append.
 * `unknowns` are not guarded here; resolved ones are removed by dropResolved.
 * `otherFacts` are code-owned (see applyFactOps).
 * Relies on the model reporting edits; an unreported edit is reverted.
 */
export function preserveFacts(draft, currentDraft, ownerEdits, incomingDelta) {
  if (!currentDraft) return draft;
  const next = { ...draft };
  const prev = currentDraft;
  const edits = Array.isArray(ownerEdits) ? ownerEdits : [];
  const delta = incomingDelta && typeof incomingDelta === 'object' ? incomingDelta : {};

  const guardList = (field, key, valueKeys) => {
    if (!Array.isArray(prev[field])) return;
    const incoming = Array.isArray(next[field]) ? next[field] : [];
    const rawDelta = Array.isArray(delta[field]) ? delta[field] : [];
    const proposed = new Set(
      rawDelta.filter((x) => x && x[key]).map((x) => foldKey(x[key]))
    );
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
      if (edit || proposed.has(foldKey(old[key]))) {
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

  if (Array.isArray(prev.informationToCollect) && Array.isArray(next.informationToCollect)) {
    next.informationToCollect = restoreOmittedStrings(
      prev.informationToCollect,
      next.informationToCollect
    );
  }

  for (const field of ['name', 'whatWeDo', 'hours', 'locationOrArea']) {
    if (prev[field] && !extends_(next[field], prev[field]) && !textFieldEdited(edits, field)) {
      next[field] = prev[field];
    }
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

/** Apply consistency-pass updates without preserveFacts (app-owned). */
export function applyConsistencyUpdates(draft, updates) {
  const u = updates && typeof updates === 'object' ? updates : {};
  const next = applyDraftDelta(
    {
      name: u.name ?? null,
      whatWeDo: u.whatWeDo ?? null,
      hours: u.hours ?? null,
      locationOrArea: u.locationOrArea ?? null,
      openingMessage: u.openingMessage ?? null,
      services: Array.isArray(u.services) ? u.services : [],
      commonQuestions: Array.isArray(u.commonQuestions) ? u.commonQuestions : [],
    },
    draft
  );
  if (Array.isArray(u.factEdits) && u.factEdits.length) {
    next.otherFacts = applyFactOps(draft?.otherFacts, [], u.factEdits);
  }
  if (Array.isArray(next.commonQuestions)) {
    next.commonQuestions = normalizeCommonQuestions(next.commonQuestions);
  }
  return next;
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

const DELTA_TEXT_KEYS = [
  'name',
  'whatWeDo',
  'ownerGoal',
  'ownerGoalRequested',
  'hours',
  'locationOrArea',
  'tone',
  'responseLength',
  'priceDisclosure',
];

/**
 * Merge a schema-enforced draft delta into the stored draft.
 * Null / omitted scalars mean unchanged. services / commonQuestions are upserted
 * by identity (empty array = no list changes). informationToCollect restores
 * omitted items when a non-empty array is present; [] still means collect
 * nothing. unknowns are append-only
 * here; dropResolved removes answered ones. preserveFacts then applies ownerEdits
 * and restores any remaining omitted rows in their original position.
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
      next.informationToCollect = restoreOmittedStrings(
        prev.informationToCollect,
        d.informationToCollect
      );
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
 * Apply one Builder model JSON object to the stored draft.
 * `mode: 'delta'` (production): top-level newFacts, null draft fields unchanged.
 * `mode: 'legacy'`: full draft snapshot, newFacts inside draft (pre-schema path).
 */
export function applyBuilderModelOutput(parsed, currentDraft, { mode = 'delta' } = {}) {
  const incoming = parsed?.draft && typeof parsed.draft === 'object' ? parsed.draft : {};
  const newFacts = mode === 'legacy' ? incoming.newFacts : parsed?.newFacts;
  const draftIn =
    mode === 'legacy'
      ? parsed?.draft && typeof parsed.draft === 'object'
        ? parsed.draft
        : currentDraft
      : applyDraftDelta(incoming, currentDraft);

  const reconciled = reconcileDraft(draftIn || currentDraft, currentDraft);
  const { newFacts: _dropped, ...guarded } = preserveFacts(
    reconciled,
    currentDraft,
    parsed?.ownerEdits,
    mode === 'legacy' ? null : incoming
  );
  return {
    ...guarded,
    otherFacts: applyFactOps(currentDraft?.otherFacts, newFacts, parsed?.factEdits),
    unknowns: dropResolved(guarded.unknowns, currentDraft?.unknowns, parsed?.resolvedUnknowns),
  };
}

/**
 * Preserve settled fields and normalize behavior enums after a Builder model turn.
 * Exported for deterministic tests (style-only edits must not wipe priceDisclosure).
 */
export function reconcileDraft(draft, currentDraft) {
  const next = { ...(draft || {}) };
  const prev = currentDraft || {};

  if (Array.isArray(next.commonQuestions)) {
    next.commonQuestions = normalizeCommonQuestions(next.commonQuestions);
  }

  // App-owned: which required topics the app already asked (model never sets it)
  next.askedTopics = Array.isArray(prev.askedTopics) ? [...prev.askedTopics] : [];

  // Preserve prior informationToCollect when model omits it or sends null after settled
  if (
    !Array.isArray(next.informationToCollect) &&
    Array.isArray(prev.informationToCollect)
  ) {
    next.informationToCollect = prev.informationToCollect;
  } else if (
    next.informationToCollect === undefined &&
    prev.informationToCollect === null
  ) {
    next.informationToCollect = null;
  }

  // ownerGoal: supported values only; invalid/null/omit → keep previous (never invent)
  next.ownerGoal =
    normalizeOwnerGoal(next.ownerGoal) ?? normalizeOwnerGoal(prev.ownerGoal) ?? null;
  next.ownerGoalRequested =
    normalizeIdentityText(next.ownerGoalRequested) ??
    normalizeIdentityText(prev.ownerGoalRequested) ??
    null;

  // Tone: preserve when omitted / blanked after set
  if ((next.tone == null || next.tone === '') && prev.tone) {
    next.tone = prev.tone;
  } else if (next.tone === undefined) {
    next.tone = prev.tone ?? null;
  } else if (typeof next.tone === 'string') {
    next.tone = next.tone.trim() || prev.tone || null;
  }

  // responseLength: normalize; invalid/null/omit → keep previous
  {
    const n = normalizeResponseLength(next.responseLength);
    if (n != null) {
      next.responseLength = n;
    } else if (prev.responseLength != null) {
      next.responseLength = normalizeResponseLength(prev.responseLength);
    } else {
      next.responseLength = null;
    }
  }

  // priceDisclosure: normalize; invalid/null/omit → keep previous (protects style-only edits)
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

  // Identity: a new value wins; explicit reset flag clears (and stays pending
  // until replaced); omitted / null / blank keeps the previous value.
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
} = {}) {
  const client = getClient();
  const model = modelOverride || process.env.OPENAI_BUILDER_MODEL || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  const legacy = mode === 'legacy';

  const currentDraft = profile.draft || {
    name: profile.name,
    whatWeDo: profile.whatWeDo,
    ownerGoal: normalizeOwnerGoal(profile.ownerGoal),
    ownerGoalRequested: profile.ownerGoalRequested ?? null,
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
    responseLength: profile.responseLength ?? null,
    priceDisclosure: profile.priceDisclosure ?? null,
    assistantName: profile.assistantName ?? null,
    openingMessage: profile.openingMessage ?? null,
  };

  const mergedForHint = mergeDraft(profile, currentDraft);
  const hasName = !!(
    mergedForHint.name && String(mergedForHint.name).trim()
  );
  const enoughBasics = hasEnoughForFirstBot(mergedForHint);
  let enoughHint;
  if (!hasName) {
    enoughHint =
      'Hint: business name is still required before readyForReview — ask for the business name (one question), or invite them to tell you about their business if basics are empty.';
  } else if (enoughBasics) {
    enoughHint =
      'Hint: enough info may already exist for a first bot — set readyForReview=true unless something important needs clarifying (the app asks required topics itself).';
  } else {
    enoughHint = 'Hint: still gathering basics (need name plus what they do or at least one service).';
  }
  if (hasName && !normalizeOwnerGoal(currentDraft.ownerGoal)) {
    enoughHint +=
      '\nHint: ownerGoal is not set — unless the owner is correcting something or changing a setting, your next question should be the ownerGoal question. If the owner just answered it, map it to a supported goal as instructed, acknowledge briefly, and continue.';
  }
  const justAsked = topicJustAsked(buildHistory);
  if (justAsked) enoughHint += `\nHint: ${justAsked.answerHint}`;
  const { otherFacts: storedFacts = [], ...draftForModel } = currentDraft;
  const contextNote = [
    'Current draft profile JSON:',
    JSON.stringify(draftForModel, null, 2),
    'Stored otherFacts (edit only via factEdits, by index):',
    storedFacts.length ? storedFacts.map((f, i) => `[${i}] ${f}`).join('\n') : '(none)',
    'Stored unknowns (report answered ones in resolvedUnknowns, by index):',
    currentDraft.unknowns?.length ? currentDraft.unknowns.map((u, i) => `[${i}] ${u}`).join('\n') : '(none)',
    profile.approvedAt
      ? `Last approved at: ${profile.approvedAt}`
      : 'Not yet approved.',
    enoughHint,
  ].join('\n');

  const messages = [
    { role: 'system', content: legacy ? legacyBuilderSystem() : SYSTEM },
    { role: 'system', content: contextNote },
    ...buildHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const started = Date.now();
  const { completion, params: requestParams } = await createBuilderCompletion(client, {
    model,
    messages,
    response_format: legacy ? { type: 'json_object' } : builderResponseFormat(),
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
      message: raw && !choice?.refusal ? raw : 'Tell me a bit more about your business.',
      draft: currentDraft,
      newFacts: [],
      readyForReview: false,
      asksQuestion: false,
      wantsReview: false,
    };
  }

  const preserved = applyBuilderModelOutput(parsed, currentDraft, {
    mode: legacy ? 'legacy' : 'delta',
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

  const readyForReview = !!parsed.readyForReview && !unresolved.length;
  const asksQuestion = parsed.asksQuestion === true;
  const wantsReview = parsed.wantsReview === true;

  const message = parsed.message || 'Tell me a bit more about your business.';

  return {
    message,
    draft,
    readyForReview,
    asksQuestion,
    wantsReview,
    consistencyMs: pass.latencyMs,
    consistencyRan: pass.ran,
    configRequests: normalizeConfigRequests(parsed.configRequests),
    askingTopic: typeof parsed.askingTopic === 'string' ? parsed.askingTopic : null,
    goalSupported: typeof parsed.goalSupported === 'boolean' ? parsed.goalSupported : null,
    goalUnsupportedPart:
      typeof parsed.goalUnsupportedPart === 'string' && parsed.goalUnsupportedPart.trim()
        ? parsed.goalUnsupportedPart.trim()
        : null,
    usage: completion.usage,
    latencyMs,
    modelJson: parsed,
    reasoningEffort: requestParams.reasoning_effort ?? null,
    reasoningTokens: reasoningTokensFromUsage(completion.usage),
    source: 'real-llm',
  };
}

const REVIEW_FILLER =
  /\b(review|summary|summari[sz]e|approv\w*|set up|setup|ready|prepare|here'?s what|below)\b/i;

/**
 * Reduce model text on a review turn to one short acknowledgment sentence: no
 * questions, no bullet/numbered lines, no "here's the summary / ready for
 * review" filler (the app renders the summary and options).
 */
export function reviewAck(text) {
  const sentences = String(text || '')
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^\s*([-*•]|#{1,6}|\d+[.)])\s+/.test(line))
    .flatMap((line) => (line.match(/[^.!?。]+[.!?。]*\s*/g) || []).map((s) => s.trim()))
    .filter((s) => s && !/\?\s*$/.test(s) && !/:\s*$/.test(s));
  const kept = sentences.find((s) => !REVIEW_FILLER.test(s));
  return kept || '';
}

/**
 * Application review gate (runs after every Builder turn, real or stubbed).
 * The Builder never approves: approval happens only when the owner picks
 * "Try my bot" on a presented review of exactly this draft
 * (profile.reviewedDraftKey). Any later draft change invalidates that review.
 * Always keeps the turn's draft (so accepting an offered alternative can update
 * the pending draft). Settings-only edits to an approved business are presented
 * for review even if the model asked an unrelated question instead.
 *
 * When presenting a review, returns presentReview=true with an acknowledgment-only
 * message; the session layer appends the short summary and numbered menu.
 *
 * @returns turn fields plus reviewedDraftKey to persist on the profile
 */
export function applyReviewGate(profile, turn, userMessage) {
  const { turn: goalTurn, disclaimer } = applyGoalSupport(turn);
  const out = gateTurn(profile, goalTurn);
  if (!disclaimer) return out;
  return { ...out, message: replaceBeforeQuestion(out.message, disclaimer) };
}

/**
 * When the model flags the goal unsupported, store the fallback goal and
 * replace the model's ack with the mapped-goal line (that turn only).
 * The owner's wording is not inspected.
 */
export function applyGoalSupport(turn) {
  if (turn?.goalSupported !== false) return { turn, disclaimer: null };
  return {
    turn: { ...turn, draft: { ...(turn.draft || {}), ownerGoal: FALLBACK_OWNER_GOAL } },
    disclaimer: GOAL_FALLBACK_DISCLAIMER,
  };
}

/**
 * Replace the text before the first question sentence with `lead` (the model's
 * own acknowledgment may restate the unsupported goal). No question → `lead` only.
 */
export function replaceBeforeQuestion(text, lead) {
  const s = String(text || '').trim();
  const q = s.indexOf('?');
  if (q === -1) return lead;
  const start =
    Math.max(s.lastIndexOf('.', q), s.lastIndexOf('!', q), s.lastIndexOf('\n', q)) + 1;
  return [lead, s.slice(start).trim()].filter(Boolean).join('\n\n');
}

function gateTurn(profile, turn) {
  const priorAsked = Array.isArray(profile.draft?.askedTopics) ? profile.draft.askedTopics : [];
  const draft = {
    ...turn.draft,
    askedTopics: [...new Set([...priorAsked, ...(turn.draft?.askedTopics || [])])],
  };

  // Required topics: before the first review, the app asks each open topic itself.
  const openTopic =
    turn.readyForReview || turn.wantsReview
      ? nextOpenTopic(profile, draft, priorAsked)
      : null;
  const modelTopic = openTopic
    ? null
    : topicModelAsked(profile, draft, priorAsked, turn.message, turn.askingTopic);
  const askTopic = openTopic || modelTopic;
  if (askTopic) {
    const lead = openTopic ? reviewAck(turn.message) : turn.message;
    return {
      ...turn,
      draft: {
        ...draft,
        askedTopics: [...new Set([...draft.askedTopics, askTopic.key])],
      },
      readyForReview: false,
      presentReview: false,
      asksQuestion: true,
      message: withSingleQuestion(lead, askTopic.question),
      reviewedDraftKey: null,
    };
  }

  const key = draftReviewKey(profile, draft);
  const reviewCurrent =
    !!profile.reviewedDraftKey && profile.reviewedDraftKey === key;
  const intakeAnswered = hasAnsweredInformationToCollect(draft);
  let readyForReview = !!turn.readyForReview;
  const wantsReview = turn.wantsReview === true;
  if (intakeAnswered && profile.approvedAt && draftChangesOnlySettings(profile, draft)) {
    readyForReview = true;
  }

  if ((readyForReview || wantsReview) && intakeAnswered) {
    return {
      ...turn,
      draft,
      readyForReview: true,
      presentReview: true,
      wantsReview,
      asksQuestion: false,
      message: readyForReview ? reviewAck(turn.message) : '',
      reviewedDraftKey: key,
    };
  }
  return {
    ...turn,
    draft,
    readyForReview,
    presentReview: false,
    wantsReview,
    asksQuestion: !!turn.asksQuestion,
    reviewedDraftKey: reviewCurrent ? key : null,
  };
}

export function openingMessage() {
  return {
    message:
      "Hi! 👋 So glad you’re here.\nI’m here to help you build a smart assistant for your business that can answer customers even when you’re busy.✨\nYou’re one of the first to try the product, so you might still come across a few rough edges.\nReady to get started? Tell me a little about your business 😊",
    source: 'app',
  };
}
