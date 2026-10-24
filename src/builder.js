import OpenAI from 'openai';
import {
  BEHAVIOR_KEYS,
  CONFIG_CAPABILITIES,
  DEMO_SCOPE,
  draftChangesOnlySettings,
  draftReviewKey,
  formatSummary,
  hasEnoughForFirstBot,
  identityResetFlag,
  IDENTITY_KEYS,
  mergeDraft,
  normalizeCommonQuestions,
  normalizeIdentityText,
  normalizePriceDisclosure,
  normalizeResponseLength,
  PRICE_DISCLOSURE_LABELS,
  PRICE_DISCLOSURE_VALUES,
  RESPONSE_LENGTH_LABELS,
  RESPONSE_LENGTH_VALUES,
} from './profile.js';

const INTAKE_GATE_QUESTION =
  'Before we finalize: should the customer bot collect any information from the customer in chat (for example name, phone number, preferred time)? If yes, list what. If not, say none.';

const RESPONSE_LENGTH_ENUM = RESPONSE_LENGTH_VALUES.map((v) => `"${v}"`).join('|');
const PRICE_DISCLOSURE_ENUM = PRICE_DISCLOSURE_VALUES.map((v) => `"${v}"`).join('|');

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

Your job: understand the business and the outcome the owner wants, clarify what is unclear, extract facts into a draft, and reach a useful first bot without an unnecessarily long interview.

Discover when relevant (partial info is OK — do not force every category):
- What the business does
- ownerGoal — the outcome the owner wants this customer bot to achieve (only when the owner has clarified it)
- Services and offerings
- Prices (if available) AND how the price applies when relevant (e.g. per unit vs flat / per booking)
- Opening hours or availability
- Location or service area
- Common customer questions (FAQ: each item is a question customers ask PLUS the owner's answer — the Business Bot may only tell customers those answers)
- Information the bot should collect from the customer (intake: name, phone, preferred day/time, etc. — the bot should ASK for these, not treat them as FAQ answers)
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
- Start by understanding the business and the owner's desired outcome — not by listing features to enable.
- If the owner is vague ("I need a bot"), help them clarify the goal with one concise question. Leave draft.ownerGoal null until they clarify; NEVER invent a goal.
- When they dump many facts in one message, absorb what you can into the draft and ask only the missing high-value follow-ups (one or two).
- Ask one or two relevant questions at a time. Adapt to what they already said. Never repeat answered questions.
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
- ownerGoal:
  - Set or update only from what the owner clearly stated as their desired outcome.
  - Leave null if they have not clarified a goal. Do not invent or guess a goal.
  - When they later clarify or change the goal, update ownerGoal and ask for approval again if already reviewed.
- Before readyForReview / approve, you MUST have asked (once) whether the bot should collect any information from the customer, and set informationToCollect to an array (possibly empty) based on their answer.
- When the owner later clarifies an unknown or changes a fact OR conversation setting (supported and clear, or after they accepted an offered alternative), IMMEDIATELY update the relevant draft fields (e.g. put the full pricing rule into services[].price; put the full FAQ answer into commonQuestions[].answer; update tone/responseLength/priceDisclosure), remove any resolved items from unknowns, set readyForReview=true, show a short summary of what changed, and ask them to approve. Do not ignore a clear clarification to ask about a different topic first. Preserve unrelated settings and business facts.
- When you have enough for a useful first customer bot (identity + at least one offering or clear description) AND informationToCollect is an array (possibly empty), set readyForReview=true and present a concise summary that includes known facts, ownerGoal when set, conversation settings when set, AND explicit unknowns, asking them to approve, correct, or say "approve". ownerGoal and conversation settings are helpful but NOT required for readyForReview.
- If they correct facts, update the draft and confirm.
- If they say approve / looks good / yes after a summary of an already-pending draft (or after a clarification summary that did not introduce a new change this turn), set approved=true. If "yes" is accepting an offered alternative that you are applying now, that is a draft update + readyForReview — set approved=false.
- If they change something later (e.g. a new price, goal, or style), update draft, show the change, and ask for approval again (readyForReview=true, approved=false until they confirm). Draft-only changes are not live until approved. Distinguish proposed vs applied: live behavior changes only after approval.

You MUST respond with a single JSON object only (no markdown fences):
{
  "message": "what to show the owner (natural language)",
  "draft": {
    "name": string|null,
    "whatWeDo": string|null,
    "ownerGoal": string|null,
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
  "readyForReview": boolean,
  "approved": boolean
}
configRequests.field: the draft key the request is about (e.g. "tone", "priceDisclosure", "openingMessage", "commonQuestions"), or null if no field fits.

Merge new facts into draft — keep previous draft values unless the owner changed them.
Use null for unknown text fields. services/commonQuestions/unknowns should be arrays (possibly empty).
commonQuestions must be objects with question and answer (not bare topic strings). Prefer a full answer whenever the owner gave one.
informationToCollect must stay null until the owner answers the collect question; then it must be an array (empty if none).
ownerGoal must stay null until the owner clarifies their desired outcome; never invent it.
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

  // Preserve prior ownerGoal when model omits/nulls after it was set (null must not invent)
  if ((next.ownerGoal == null || next.ownerGoal === '') && prev.ownerGoal) {
    next.ownerGoal = prev.ownerGoal;
  } else if (next.ownerGoal === undefined) {
    next.ownerGoal = prev.ownerGoal ?? null;
  }

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
    ownerGoal: profile.ownerGoal ?? null,
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

  const intakeSettled = hasAnsweredInformationToCollect(currentDraft);
  const contextNote = [
    'Current draft profile JSON:',
    JSON.stringify(currentDraft, null, 2),
    profile.approvedAt
      ? `Last approved at: ${profile.approvedAt}`
      : 'Not yet approved.',
    hasEnoughForFirstBot(mergeDraft(profile, currentDraft))
      ? intakeSettled
        ? 'Hint: enough info may already exist for a first bot — consider readyForReview if appropriate.'
        : 'Hint: basics may be enough, but informationToCollect is still null — ask whether the bot should collect anything from the customer before readyForReview.'
      : 'Hint: still gathering basics.',
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

  // Application gate: cannot review/approve until owner answered intake collect question
  const intakeAnswered = hasAnsweredInformationToCollect(draft);
  let message = parsed.message || 'Tell me a bit more about your business.';
  if ((readyForReview || approved) && !intakeAnswered) {
    approved = false;
    readyForReview = false;
    if (!message.includes(INTAKE_GATE_QUESTION)) {
      message = `${message.trim()}\n\n${INTAKE_GATE_QUESTION}`;
    }
  }

  return {
    message,
    draft,
    readyForReview,
    approved,
    configRequests: normalizeConfigRequests(parsed.configRequests),
    usage: completion.usage,
    source: 'real-llm',
  };
}

const REVIEW_FOOTER =
  'Reply **approve** to create/update the customer bot, or tell me what to correct.';
const REVIEW_REQUIRED_NOTE =
  'Before I apply anything, please review the current version below.';

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
 * @returns turn fields plus reviewedDraftKey to persist on the profile
 */
export function applyReviewGate(profile, turn, userMessage) {
  const draft = turn.draft;
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
      reviewedDraftKey: key,
    };
  }

  let message = turn.message;
  let readyForReview = !!turn.readyForReview;
  if (wantsApprove && intakeAnswered && !reviewCurrent) {
    readyForReview = true;
    // Bare approve of an already-pending (unchanged) draft → stock "please review".
    // "yes" that also applies an offered alternative changes the draft this turn —
    // keep the model's pending-change preview; the summary still appends below.
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
    return {
      ...turn,
      draft,
      approved: false,
      readyForReview: true,
      message: `${message.trim()}\n\n---\n${formatSummary({ ...profile, draft })}\n---\n${REVIEW_FOOTER}`,
      reviewedDraftKey: key,
    };
  }
  return {
    ...turn,
    draft,
    approved: false,
    readyForReview,
    reviewedDraftKey: reviewCurrent ? key : null,
  };
}

export function openingMessage() {
  return {
    message:
      "Hi! Think of me as a new teammate learning how your business handles customer questions. Tell me what you do and what you want this customer bot to achieve — I'll ask a few smart follow-ups. When we have enough, I'll show a summary to approve, then you can type /test to try it as a customer.",
    source: 'app',
  };
}
