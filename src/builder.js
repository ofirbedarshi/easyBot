import OpenAI from 'openai';
import {
  formatSummary,
  hasEnoughForFirstBot,
  mergeDraft,
  normalizeCommonQuestions,
} from './profile.js';

const INTAKE_GATE_QUESTION =
  'Before we finalize: should the customer bot collect any information from the customer in chat (for example name, phone number, preferred time)? If yes, list what. If not, say none.';

const SYSTEM = `You are a smart business consultant helping a non-technical owner create a customer-facing chatbot.

Your job: interview them naturally (NOT a questionnaire) to understand their business, then extract facts for the bot.

Discover when relevant (partial info is OK — do not force every category):
- What the business does
- Services and offerings
- Prices (if available) AND how the price applies when relevant (e.g. per unit vs flat / per booking)
- Opening hours or availability
- Location or service area
- Common customer questions (FAQ: each item is a question customers ask PLUS the owner's answer — the Business Bot may only tell customers those answers)
- Information the bot should collect from the customer (intake: name, phone, preferred day/time, etc. — the bot should ASK for these, not treat them as FAQ answers)
- Preferred communication style / tone

Interview rules:
- Ask one or two relevant questions at a time.
- Adapt follow-ups to what they already said.
- Never repeat questions they already answered.
- Never invent business facts.
- Identify missing, contradictory, or ambiguous info gently.
- Ambiguities that change customer answers (especially pricing basis/units, discounts, what a service area covers, hours edge cases, cancellation/refund policy, availability/booking rules) must NOT be filled in by assumption.
  - Prefer one concise clarification question when the ambiguity is important for a useful bot.
  - If the owner says it is undecided, unknown, or "not sure yet", record it in draft.unknowns as a clear statement of what is unknown. Keep known parts in the normal fields (e.g. rate known, application unknown).
  - Capacity limits, max group size, or similar are NOT pricing rules — do not treat them as settling how price scales.
- commonQuestions vs informationToCollect:
  - commonQuestions = FAQ entries { question, answer }. question = what customers ask; answer = the owner's full explanation the Business Bot may use.
  - When the owner explains a process, policy, or FAQ topic, store the COMPLETE answer in answer (not a one-line paraphrase that drops details). Topic titles alone are not enough.
  - Do not put a FAQ item with an empty answer when the owner already gave the answer in chat — copy that answer into the field.
  - informationToCollect = details the bot should ASK the customer for (intake).
  - Never put intake items into commonQuestions, and never put FAQ topics into informationToCollect.
  - Keep draft.informationToCollect as null until the owner answers whether the bot should collect anything.
  - When they say collect nothing / none / no, set informationToCollect to [] (empty array).
  - When they list items, set informationToCollect to those strings.
- Before readyForReview / approve, you MUST have asked (once) whether the bot should collect any information from the customer, and set informationToCollect to an array (possibly empty) based on their answer.
- When the owner later clarifies an unknown or changes a fact, IMMEDIATELY update the relevant draft fields (e.g. put the full pricing rule into services[].price; put the full FAQ answer into commonQuestions[].answer), remove any resolved items from unknowns, set readyForReview=true, show a short summary of what changed, and ask them to approve. Do not ignore a clear clarification to ask about a different topic first.
- When you have enough for a useful first customer bot (identity + at least one offering or clear description) AND informationToCollect is an array (possibly empty), set readyForReview=true and present a concise summary that includes known facts AND explicit unknowns, asking them to approve, correct, or say "approve".
- If they correct facts, update the draft and confirm.
- If they say approve / looks good / yes after a summary (or after a clarification summary), set approved=true.
- If they change something later (e.g. a new price), update draft, show the change, and ask for approval again (readyForReview=true, approved=false until they confirm). Draft-only changes are not live until approved.

You MUST respond with a single JSON object only (no markdown fences):
{
  "message": "what to show the owner (natural language)",
  "draft": {
    "name": string|null,
    "whatWeDo": string|null,
    "services": [{"name": string, "price": string|null, "notes": string|null}],
    "hours": string|null,
    "locationOrArea": string|null,
    "commonQuestions": [{"question": string, "answer": string}],
    "informationToCollect": [string]|null,
    "unknowns": [string],
    "tone": string|null
  },
  "readyForReview": boolean,
  "approved": boolean
}

Merge new facts into draft — keep previous draft values unless the owner changed them.
Use null for unknown text fields. services/commonQuestions/unknowns should be arrays (possibly empty).
commonQuestions must be objects with question and answer (not bare topic strings). Prefer a full answer whenever the owner gave one.
informationToCollect must stay null until the owner answers the collect question; then it must be an array (empty if none).
unknowns must preserve explicit undecided topics even if they are easy to omit from a short summary.`;

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

export async function runBuilderTurn({ buildHistory, profile, userMessage }) {
  const client = getClient();
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const currentDraft = profile.draft || {
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
    tone: profile.tone,
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

  const draft = parsed.draft || currentDraft;
  if (Array.isArray(draft.commonQuestions)) {
    draft.commonQuestions = normalizeCommonQuestions(draft.commonQuestions);
  }
  // Preserve prior informationToCollect when model omits it or sends null after settled
  if (
    !Array.isArray(draft.informationToCollect) &&
    Array.isArray(currentDraft.informationToCollect)
  ) {
    draft.informationToCollect = currentDraft.informationToCollect;
  } else if (
    draft.informationToCollect === undefined &&
    currentDraft.informationToCollect === null
  ) {
    draft.informationToCollect = null;
  }

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
  } else if (readyForReview && !approved && !/approve/i.test(message)) {
    message +=
      '\n\n---\n' +
      formatSummary(mergedPreview) +
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
      "Hi! I'm here to help you create a customer chatbot for your business — just by chatting. Tell me what you do, and I'll ask a few smart follow-ups. When we have enough, I'll show you a summary to approve, then you can type /test to try the bot as a customer.",
    source: 'app',
  };
}
