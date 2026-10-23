import OpenAI from 'openai';
import {
  formatSummary,
  hasEnoughForFirstBot,
  mergeDraft,
} from './profile.js';

const SYSTEM = `You are a smart business consultant helping a non-technical owner create a customer-facing chatbot.

Your job: interview them naturally (NOT a questionnaire) to understand their business, then extract facts for the bot.

Discover when relevant (partial info is OK — do not force every category):
- What the business does
- Services and offerings
- Prices (if available) AND how the price applies when relevant (e.g. per unit vs flat / per booking)
- Opening hours or availability
- Location or service area
- Common customer questions
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
- When the owner later clarifies an unknown or changes a fact, IMMEDIATELY update the relevant draft fields (e.g. put the full pricing rule into services[].price), remove any resolved items from unknowns, set readyForReview=true, show a short summary of what changed, and ask them to approve. Do not ignore a clear clarification to ask about a different topic first.
- When you have enough for a useful first customer bot (identity + at least one offering or clear description), set readyForReview=true and present a concise summary that includes known facts AND explicit unknowns, asking them to approve, correct, or say "approve".
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
    "commonQuestions": [string],
    "unknowns": [string],
    "tone": string|null
  },
  "readyForReview": boolean,
  "approved": boolean
}

Merge new facts into draft — keep previous draft values unless the owner changed them.
Use null for unknown fields. services/commonQuestions/unknowns should be arrays (possibly empty).
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
    unknowns: profile.unknowns || [],
    tone: profile.tone,
  };

  const contextNote = [
    'Current draft profile JSON:',
    JSON.stringify(currentDraft, null, 2),
    profile.approvedAt
      ? `Last approved at: ${profile.approvedAt}`
      : 'Not yet approved.',
    hasEnoughForFirstBot(mergeDraft(profile, currentDraft))
      ? 'Hint: enough info may already exist for a first bot — consider readyForReview if appropriate.'
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
  const mergedPreview = mergeDraft(profile, draft);

  // Soft guard: if model marks approved without enough info, require review instead
  let approved = !!parsed.approved;
  let readyForReview = !!parsed.readyForReview;
  if (approved && !hasEnoughForFirstBot(mergedPreview)) {
    approved = false;
    readyForReview = true;
  }

  let message = parsed.message || 'Tell me a bit more about your business.';
  if (readyForReview && !approved && !/approve/i.test(message)) {
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
