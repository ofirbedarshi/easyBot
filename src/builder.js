import OpenAI from 'openai';
import {
  draftDiffersFromLive,
  formatSummary,
  hasEnoughForFirstBot,
  mergeDraft,
  normalizeCommonQuestions,
  normalizePriceDisclosure,
  normalizeResponseLength,
} from './profile.js';

const INTAKE_GATE_QUESTION =
  'Before we finalize: should the customer bot collect any information from the customer in chat (for example name, phone number, preferred time)? If yes, list what. If not, say none.';

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
- Answer questions from approved business facts
- Clarify what the customer needs
- Collect listed intake details in chat
- Prepare the owner to follow up by suggesting the customer message the owner directly
It cannot: book calendars, take payments, update a CRM, send emails/SMS for the owner, or save/deliver an inquiry record. Never claim those exist.

Conversation settings (behavior — not business facts):
- tone: free-text how the bot should sound (e.g. "warm", "professional"). Expression only — NEVER put services, benefits, guarantees, capabilities, or intake permissions into tone.
- responseLength: "short" when the owner wants brief/concise/short replies; "standard" otherwise. Prefer "short" for "warm and short", "professional and concise", "keep it brief".
- priceDisclosure: only two supported values:
  - "relevant" — mention approved prices when useful/relevant; do not dump prices into unrelated answers.
  - "on_request" — mention prices ONLY when the customer asks about pricing, cost, a quote, a total, or what an amount buys (including clear pricing follow-ups). A general description or booking request alone must NOT trigger prices.
- Map natural language: "prices only when asked" / "only mention prices when customers ask" → on_request; "mention prices when relevant" / "include prices when useful" → relevant.
- If the owner asks for unsupported price behavior (never disclose prices, always lead with prices, hide all prices forever), clearly explain the two supported options and ask which they want. Do NOT invent a third policy and do NOT set priceDisclosure to an unsupported value.
- Style/settings cannot establish service attributes, benefits, guarantees, capabilities, or extra intake. If a style request also contains a business fact, update the fact fields separately and keep settings as settings.
- Settings are optional for a first bot. Do not force a long interview about them. When the owner later changes only style or price disclosure, update those draft fields, leave business facts unchanged, set readyForReview=true, show what changed, and ask for approval again (approved=false until they confirm).

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
  - Do NOT imply the unsupported capability exists or that an inquiry will be saved or delivered to the owner by the system.
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
- When the owner later clarifies an unknown or changes a fact OR conversation setting, IMMEDIATELY update the relevant draft fields (e.g. put the full pricing rule into services[].price; put the full FAQ answer into commonQuestions[].answer; update tone/responseLength/priceDisclosure), remove any resolved items from unknowns, set readyForReview=true, show a short summary of what changed, and ask them to approve. Do not ignore a clear clarification to ask about a different topic first.
- When you have enough for a useful first customer bot (identity + at least one offering or clear description) AND informationToCollect is an array (possibly empty), set readyForReview=true and present a concise summary that includes known facts, ownerGoal when set, conversation settings when set, AND explicit unknowns, asking them to approve, correct, or say "approve". ownerGoal and conversation settings are helpful but NOT required for readyForReview.
- If they correct facts, update the draft and confirm.
- If they say approve / looks good / yes after a summary (or after a clarification summary), set approved=true.
- If they change something later (e.g. a new price, goal, or style), update draft, show the change, and ask for approval again (readyForReview=true, approved=false until they confirm). Draft-only changes are not live until approved.

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
    "responseLength": "short"|"standard"|null,
    "priceDisclosure": "relevant"|"on_request"|null
  },
  "readyForReview": boolean,
  "approved": boolean
}

Merge new facts into draft — keep previous draft values unless the owner changed them.
Use null for unknown text fields. services/commonQuestions/unknowns should be arrays (possibly empty).
commonQuestions must be objects with question and answer (not bare topic strings). Prefer a full answer whenever the owner gave one.
informationToCollect must stay null until the owner answers the collect question; then it must be an array (empty if none).
ownerGoal must stay null until the owner clarifies their desired outcome; never invent it.
unknowns must preserve explicit undecided topics even if they are easy to omit from a short summary.
responseLength and priceDisclosure must be one of the allowed enum values or null — never invent other policies.
When the owner changes only tone or length, keep the previous priceDisclosure value in the draft (do not clear it).`;

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

  return next;
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

  const draft = reconcileDraft(parsed.draft || currentDraft, currentDraft);

  const mergedPreview = mergeDraft(profile, draft);

  // Soft guard: if model marks approved without enough info, require review instead
  let approved = !!parsed.approved;
  let readyForReview = !!parsed.readyForReview;
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
  } else if (
    // Enforce short approve phrases when draft is reviewable — model often forgets approved=true
    !approved &&
    intakeAnswered &&
    hasEnoughForFirstBot(mergedPreview) &&
    isOwnerApproveMessage(userMessage) &&
    (readyForReview ||
      draftDiffersFromLive(profile, draft) ||
      !profile.approvedAt)
  ) {
    approved = true;
    readyForReview = true;
  } else if (readyForReview && !approved && !/approve/i.test(message)) {
    // Pass draft on the profile so Live vs Pending labeling works after first approve
    message +=
      '\n\n---\n' +
      formatSummary({ ...profile, draft }) +
      '\n---\nReply **approve** to create/update the customer bot, or tell me what to correct.';
  }

  return {
    message,
    draft,
    readyForReview,
    approved,
    usage: completion.usage,
    source: 'real-llm',
  };
}

export function openingMessage() {
  return {
    message:
      "Hi! Think of me as a new teammate learning how your business handles customer questions. Tell me what you do and what you want this customer bot to achieve — I'll ask a few smart follow-ups. When we have enough, I'll show a summary to approve, then you can type /test to try it as a customer.",
    source: 'app',
  };
}
