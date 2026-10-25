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

export const OWNER_GOAL_QUESTION =
  "What's the main thing you'd like your bot to do for your business? For example: answer customer questions, help increase sales, guide customers toward booking an appointment, or collect contact details from interested customers. Feel free to answer in your own words.";

const RESPONSE_LENGTH_ENUM = RESPONSE_LENGTH_VALUES.map((v) => `"${v}"`).join('|');
const PRICE_DISCLOSURE_ENUM = PRICE_DISCLOSURE_VALUES.map((v) => `"${v}"`).join('|');
const OWNER_GOAL_ENUM = OWNER_GOAL_VALUES.map((v) => `"${v}"`).join('|');
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
- After the owner accepts an offered alternative, the alternative is a new "supported" request: update the draft, readyForReview=true, approved=false.
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
    - Fully supported (only answering questions and/or collecting details): set the matching value and goalSupported=true.
    - Anything else (booking, sales, payments, follow-ups, reminders, or a mix that includes one of them): set ownerGoal="${FALLBACK_OWNER_GOAL}", goalSupported=false, and goalUnsupportedPart = a short phrase of what the bot can't do (e.g. "book sessions"). Do NOT explain the limitation yourself — the app adds a fixed disclaimer.
  - On the answering turn, start with one short acknowledgment sentence (no restating capabilities), then continue with the next single interview question.
  - Set goalSupported=null on every turn where the owner did not answer or change the goal.
  - Leave ownerGoal null until the owner answers. Never invent a goal.
  - When they later change the goal, apply the same mapping and ask for approval again if already reviewed.
- When the owner later clarifies an unknown or changes a fact OR conversation setting (supported and clear, or after they accepted an offered alternative), IMMEDIATELY update the relevant draft fields (e.g. put the full pricing rule into services[].price; put the full FAQ answer into commonQuestions[].answer; update tone/responseLength/priceDisclosure), remove any resolved items from unknowns, set readyForReview=true. Your message MUST be a one-line acknowledgment only — no summary, no questions, no bullet list (the app shows the summary and options). Do not ignore a clear clarification to ask about a different topic first. Preserve unrelated settings and business facts.
- When you have enough for a useful first customer bot (non-empty business name + at least one offering or clear description), set readyForReview=true even if required topics are still open (the app asks them first). Your message MUST be one short acknowledgment sentence only (e.g. "Got it, thanks!") — no summary, no questions, no bullet list, no "ready for review". The app shows the summary and the options (Try my bot / Make changes). ownerGoal and conversation settings are helpful but NOT required for readyForReview. A description without a business name is not enough.
- If they correct facts, update the draft and confirm with a one-line acknowledgment (readyForReview as appropriate).
- If they say approve / looks good / yes after a summary of an already-pending draft (or after a clarification that did not introduce a new change this turn), set approved=true. If "yes" is accepting an offered alternative that you are applying now, that is a draft update + readyForReview — set approved=false.
- If they change something later (e.g. a new price, goal, or style), update draft, set readyForReview=true, approved=false, and reply with a one-line acknowledgment only (no summary, no questions). Draft-only changes are not live until approved. Distinguish proposed vs applied: live behavior changes only after approval.

You MUST respond with a single JSON object only (no markdown fences):
{
  "message": "what to show the owner (natural language)",
  "draft": {
    "name": string|null,
    "whatWeDo": string|null,
    "ownerGoal": ${OWNER_GOAL_ENUM}|null,
    "ownerGoalRequested": string|null,
    "services": [{"name": string, "price": string|null, "notes": string|null}],
    "hours": string|null,
    "locationOrArea": string|null,
    "commonQuestions": [{"question": string, "answer": string}],
    "informationToCollect": [string]|null,
    "unknowns": [string],
    "tone": string|null,
    "responseLength": ${RESPONSE_LENGTH_ENUM}|null,
    "priceDisclosure": ${PRICE_DISCLOSURE_ENUM}|null,
    "assistantName": string|null,
    "openingMessage": string|null,
    "assistantNameReset": boolean,
    "openingMessageReset": boolean
  },
  "configRequests": [{"request": string, "status": "supported"|"ambiguous"|"unsupported", "field": string|null, "alternative": string|null}],
  "askingTopic": ${REQUIRED_TOPICS.map((t) => `"${t.key}"`).join('|')}|null,
  "goalSupported": boolean|null,
  "goalUnsupportedPart": string|null,
  "readyForReview": boolean,
  "approved": boolean
}
configRequests.field: the draft key the request is about (e.g. "tone", "priceDisclosure", "openingMessage", "commonQuestions"), or null if no field fits.

Merge new facts into draft — keep previous draft values unless the owner changed them.
Use null for unknown text fields. services/commonQuestions/unknowns should be arrays (possibly empty).
commonQuestions must be objects with question and answer (not bare topic strings). Prefer a full answer whenever the owner gave one.
informationToCollect must stay null until the owner answers the collect question; then it must be an array (empty if none).
If the owner says to skip FAQ or has no common questions, leave commonQuestions as it is — do not invent entries.
ownerGoal must be one of the supported values, or null until the owner answers the goal question; never invent it.
unknowns must preserve explicit undecided topics even if they are easy to omit from a short summary.
responseLength and priceDisclosure must be one of the allowed enum values or null — never invent other policies.
When the owner changes only tone or length, keep the previous priceDisclosure value in the draft (do not clear it).
Keep previous assistantName and openingMessage in the draft unless the owner changed or explicitly reset them.`;

function getClient() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY missing — set it in .env');
  return new OpenAI({ apiKey: key });
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

/**
 * Narrow owner-approve phrasing (exact short messages only).
 * Broader "yes, but change X" stays model-driven.
 */
export function isOwnerApproveMessage(text) {
  const t = String(text || '').trim();
  return /^(approve|looks good|lgtm|yes\.?|ok\.?|okay\.?)$/i.test(t);
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

export async function runBuilderTurn({ buildHistory, profile, userMessage }) {
  const client = getClient();
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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
  const contextNote = [
    'Current draft profile JSON:',
    JSON.stringify(currentDraft, null, 2),
    profile.approvedAt
      ? `Last approved at: ${profile.approvedAt}`
      : 'Not yet approved.',
    enoughHint,
  ].join('\n');

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: contextNote },
    ...buildHistory.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
  ];

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages,
  });

  const raw = completion.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = parseJsonResponse(raw);
  } catch {
    parsed = {
      message: raw,
      draft: currentDraft,
      readyForReview: false,
      approved: false,
    };
  }

  const { draft, unresolved } = enforceConfigRequests(
    reconcileDraft(parsed.draft || currentDraft, currentDraft),
    currentDraft,
    parsed.configRequests
  );

  const mergedPreview = mergeDraft(profile, draft);

  // Soft guard: if model marks approved without enough info, require review instead
  let approved = !!parsed.approved && !unresolved.length;
  let readyForReview = !!parsed.readyForReview && !unresolved.length;
  if (approved && !hasEnoughForFirstBot(mergedPreview)) {
    approved = false;
    readyForReview = true;
  }

  const message = parsed.message || 'Tell me a bit more about your business.';

  return {
    message,
    draft,
    readyForReview,
    approved,
    configRequests: normalizeConfigRequests(parsed.configRequests),
    askingTopic: typeof parsed.askingTopic === 'string' ? parsed.askingTopic : null,
    goalSupported: typeof parsed.goalSupported === 'boolean' ? parsed.goalSupported : null,
    goalUnsupportedPart:
      typeof parsed.goalUnsupportedPart === 'string' && parsed.goalUnsupportedPart.trim()
        ? parsed.goalUnsupportedPart.trim()
        : null,
    usage: completion.usage,
    source: 'real-llm',
  };
}

const REVIEW_REQUIRED_NOTE =
  'Before I apply anything, please review the current version below.';

const REVIEW_FILLER =
  /\b(review|summary|summari[sz]e|approv\w*|set up|setup|ready|prepare|here'?s what|below)\b|סיכום|לאישור|מוכן/i;

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
 * True when a short owner-approve phrase may apply the current draft.
 * Requires a prior presented review of exactly this draft (reviewedDraftKey).
 * A "yes" that also introduces a new draft change this turn will not match
 * the prior key, so soft-approve does not fire — the change stays pending.
 */
export function shouldSoftApprove({ profile, draft, userMessage }) {
  if (!isOwnerApproveMessage(userMessage)) return false;
  if (!hasAnsweredInformationToCollect(draft)) return false;
  if (!hasEnoughForFirstBot(mergeDraft(profile, draft))) return false;
  const key = draftReviewKey(profile, draft);
  return !!profile.reviewedDraftKey && profile.reviewedDraftKey === key;
}

/**
 * Application approval gate (runs after every Builder turn, real or stubbed).
 * Approval is accepted only when the app already presented a review of exactly
 * this draft (profile.reviewedDraftKey). Any later draft change invalidates it.
 * Always keeps the turn's draft (so accepting an offered alternative can update
 * the pending draft); soft-approve only fires when that draft was already reviewed.
 * Settings-only edits to an approved business are presented for review even if
 * the model asked an unrelated question instead.
 *
 * When presenting a review, returns presentReview=true with an acknowledgment-only
 * message; the session layer appends the short summary and numbered menu.
 *
 * @returns turn fields plus reviewedDraftKey to persist on the profile
 */
export function applyReviewGate(profile, turn, userMessage) {
  const { turn: goalTurn, disclaimer } = applyGoalSupport(profile, turn, userMessage);
  const out = gateTurn(profile, goalTurn, userMessage);
  if (!disclaimer) return out;
  return { ...out, message: replaceBeforeQuestion(out.message, disclaimer) };
}

/** Goal wording the bot can't do, and the phrase used in the disclaimer. */
const UNSUPPORTED_GOAL_PATTERNS = [
  [/\b(book|booking|appointments?|schedul\w*|reserv\w*)\b/i, 'book appointments'],
  [/\b(sell|sales|selling|revenue|upsell\w*)\b/i, 'drive sales'],
  [/\b(pay|payments?|charge|checkout)\b/i, 'take payments'],
  [/\b(remind\w*|follow[- ]?ups?)\b/i, 'send reminders or follow-ups'],
];

/**
 * Unsupported bot goal: store the fallback goal and return the fixed disclaimer
 * (shown only on the turn the owner asked for something the bot can't do).
 * Uses the model's goalSupported=false, or — when the goal was set or changed this
 * turn — the owner's message matching unsupported wording.
 */
export function applyGoalSupport(profile, turn, userMessage) {
  const prevGoal = normalizeOwnerGoal(profile?.draft?.ownerGoal ?? profile?.ownerGoal);
  const goalSetNow =
    normalizeOwnerGoal(turn?.draft?.ownerGoal) !== null &&
    normalizeOwnerGoal(turn?.draft?.ownerGoal) !== prevGoal;
  const matched = goalSetNow
    ? UNSUPPORTED_GOAL_PATTERNS.find(([re]) => re.test(String(userMessage || '')))
    : null;
  if (turn?.goalSupported !== false && !matched) return { turn, disclaimer: null };
  const what = turn.goalUnsupportedPart || matched?.[1] || 'do that';
  return {
    turn: { ...turn, draft: { ...(turn.draft || {}), ownerGoal: FALLBACK_OWNER_GOAL } },
    disclaimer: `Noted! ${what} isn't available yet, so I'll set the bot to answer questions and collect details for now.`,
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

function gateTurn(profile, turn, userMessage) {
  const priorAsked = Array.isArray(profile.draft?.askedTopics) ? profile.draft.askedTopics : [];
  const draft = {
    ...turn.draft,
    askedTopics: [...new Set([...priorAsked, ...(turn.draft?.askedTopics || [])])],
  };

  // Required topics: before the first review, the app asks each open topic itself.
  const wantsReview =
    !!turn.readyForReview ||
    !!turn.approved ||
    (isOwnerApproveMessage(userMessage) && hasEnoughForFirstBot(mergeDraft(profile, draft)));
  const openTopic = wantsReview ? nextOpenTopic(profile, draft, priorAsked) : null;
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
      approved: false,
      readyForReview: false,
      presentReview: false,
      message: withSingleQuestion(lead, askTopic.question),
      reviewedDraftKey: null,
    };
  }

  const key = draftReviewKey(profile, draft);
  const reviewCurrent =
    !!profile.reviewedDraftKey && profile.reviewedDraftKey === key;
  const intakeAnswered = hasAnsweredInformationToCollect(draft);
  const enough = hasEnoughForFirstBot(mergeDraft(profile, draft));
  const wantsApprove = !!turn.approved || isOwnerApproveMessage(userMessage);

  // Soft-approve (short phrase) or model approved=true — both need a prior
  // review of exactly this draft. A "yes" that also changes the draft this
  // turn gets a new key and will not approve (see shouldSoftApprove).
  if (wantsApprove && intakeAnswered && enough && reviewCurrent) {
    return {
      ...turn,
      draft,
      approved: true,
      readyForReview: true,
      presentReview: false,
      reviewedDraftKey: key,
    };
  }

  let message = turn.message;
  let readyForReview = !!turn.readyForReview;
  if (wantsApprove && intakeAnswered && !reviewCurrent) {
    readyForReview = true;
    // Bare approve of an already-pending (unchanged) draft → stock "please review".
    // "yes" that also applies an offered alternative changes the draft this turn —
    // keep the model's acknowledgment; the app summary still appends below.
    const priorKey = profile.draft
      ? draftReviewKey(profile, profile.draft)
      : null;
    const draftChangedThisTurn = !priorKey || priorKey !== key;
    if (!draftChangedThisTurn || !String(turn.message || '').trim()) {
      message = REVIEW_REQUIRED_NOTE;
    }
  }
  if (intakeAnswered && profile.approvedAt && draftChangesOnlySettings(profile, draft)) {
    readyForReview = true;
  }

  if (readyForReview && intakeAnswered) {
    const ack = message === REVIEW_REQUIRED_NOTE ? message : reviewAck(message);
    return {
      ...turn,
      draft,
      approved: false,
      readyForReview: true,
      presentReview: true,
      message: ack,
      reviewedDraftKey: key,
    };
  }
  return {
    ...turn,
    draft,
    approved: false,
    readyForReview,
    presentReview: false,
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
