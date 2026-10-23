/**
 * Adaptive Tester-as-Owner: reads Builder reply, answers from fixture knowledge
 * without dumping all facts or hidden secrets.
 */
import OpenAI from 'openai';
import { redactSecrets } from './fixtures.js';

export function ownerModelName() {
  return (
    process.env.OWNER_MODEL ||
    process.env.OPENAI_MODEL ||
    'gpt-4o-mini'
  );
}

/**
 * @param {object} args
 * @param {object} args.fixture
 * @param {object} args.disclosureLedger
 * @param {string} args.builderReply
 * @param {boolean} [args.readyForReview]
 * @param {string} [args.mode] — 'interview' | 'repair' | 'approve'
 * @param {string} [args.repairHint]
 */
export async function nextOwnerMessage(args) {
  const fixture = args.fixture;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = ownerModelName();

  const system = `You are simulating a business OWNER talking to a Builder chatbot (Tester role).
You are NOT the Builder and NOT the customer bot.

Speaking style: ${fixture.speakingStyle}
Opening hint (first message only if Builder just greeted): ${fixture.openingHint}

FULL OWNER KNOWLEDGE (Tester-only — reveal gradually):
${JSON.stringify(fixture.fullKnowledge, null, 2)}

DISCLOSURE POLICY:
- Max ~${fixture.disclosurePolicy.maxFactsPerTurn} new facts per turn
- Prefer answering the Builder's latest question
- Never dump optionalFacts unless Builder asks
- NEVER reveal hiddenNeverDisclose
- For explicitUnknowns: say you have not decided / are unsure — do not invent
- Before approving, ensure you have mentioned each item in fullKnowledge.explicitUnknowns as undecided at least once across the conversation
- Do not paste the entire knowledge dump in one message
- Do NOT invent extra unknowns that are not in fullKnowledge.explicitUnknowns

INTAKE vs FAQ (important — do not mix):
- If Builder asks whether the bot should collect / ask the customer for information (name, phone, preferred time/day, details to gather, etc.):
  - If fullKnowledge.informationToCollect is a non-empty array: tell them those exact items are what the bot should collect. Do NOT call them "common questions".
  - If fullKnowledge.informationToCollect is missing or empty: say the bot does not need to collect anything from the customer ("none").
- If Builder asks about common questions / what customers usually ask: answer from optionalFacts / FAQ only. Do NOT volunteer the informationToCollect list as common questions.
- Never volunteer informationToCollect until Builder asks about collecting or asking the customer for details.

Current disclosure ledger (already told Builder):
${JSON.stringify(args.disclosureLedger, null, 2)}

Mode: ${args.mode || 'interview'}
${args.repairHint ? `Repair guidance: ${args.repairHint}` : ''}

Return JSON only:
{
  "message": "natural owner reply to send to Builder",
  "newlyDisclosed": ["short fact strings newly stated"],
  "newlyUnknowns": ["unknowns you stated as undecided this turn"],
  "wantsApprove": boolean,
  "stalledReason": null or short string if you cannot usefully continue
}`;

  const user = JSON.stringify({
    builderReply: args.builderReply,
    readyForReview: !!args.readyForReview,
    note:
      args.mode === 'approve'
        ? 'If the summary looks faithful to what you disclosed (including unknowns), set wantsApprove true and message can be "approve" or a short approval.'
        : args.mode === 'repair'
          ? 'Correct the Builder per repair guidance; do not approve yet.'
          : 'Continue the interview naturally.',
  });

  const completion = await client.chat.completions.create({
    model,
    temperature: 0.4,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch {
    parsed = {
      message: fixture.openingHint,
      newlyDisclosed: [],
      newlyUnknowns: [],
      wantsApprove: false,
      stalledReason: 'owner_parse_failed',
    };
  }

  const message = redactSecrets(String(parsed.message || '').trim());
  let newlyUnknowns = Array.isArray(parsed.newlyUnknowns)
    ? parsed.newlyUnknowns.map(String)
    : [];
  // When approving / ready, ensure fixture unknowns are reflected in ledger updates
  if (args.readyForReview || args.mode === 'approve') {
    const have = new Set(
      (args.disclosureLedger?.explicitUnknowns || []).map((u) =>
        String(u).toLowerCase()
      )
    );
    for (const u of fixture.fullKnowledge?.explicitUnknowns || []) {
      const key = String(u).toLowerCase();
      if (![...have].some((h) => h.includes(key.slice(0, 12)) || key.includes(h.slice(0, 12)))) {
        newlyUnknowns.push(u);
      }
    }
  }
  return {
    message,
    newlyDisclosed: Array.isArray(parsed.newlyDisclosed)
      ? parsed.newlyDisclosed.map(String)
      : [],
    newlyUnknowns,
    wantsApprove: !!parsed.wantsApprove,
    stalledReason: parsed.stalledReason || null,
    model,
    source: 'adaptive-owner',
  };
}

/** Merge owner turn into disclosure ledger (mutates). */
export function applyDisclosures(ledger, ownerTurn, fixture) {
  if (!ledger.disclosures) ledger.disclosures = [];
  if (!ledger.explicitUnknowns) ledger.explicitUnknowns = [];
  if (!ledger.known) ledger.known = {};
  if (!ledger.neverDisclosed) {
    ledger.neverDisclosed = [
      ...(fixture.fullKnowledge?.hiddenNeverDisclose || []),
    ];
  }

  ledger.disclosures.push({
    text: ownerTurn.message,
    facts: ownerTurn.newlyDisclosed || [],
  });

  for (const u of ownerTurn.newlyUnknowns || []) {
    if (u && !ledger.explicitUnknowns.includes(u)) {
      ledger.explicitUnknowns.push(u);
    }
  }
  // Also seed fixture unknowns once owner has started talking
  for (const u of fixture.fullKnowledge?.explicitUnknowns || []) {
    const mentioned =
      (ownerTurn.message || '').toLowerCase().includes('undecided') ||
      (ownerTurn.message || '').toLowerCase().includes('not sure') ||
      (ownerTurn.message || '').toLowerCase().includes('haven\'t decided') ||
      (ownerTurn.newlyUnknowns || []).length > 0;
    if (mentioned && !ledger.explicitUnknowns.some((x) => x === u)) {
      // Only add fixture unknown if owner signalled uncertainty this turn
      const key = u.toLowerCase().split(/\s+/).find((w) => w.length > 5);
      if (
        key &&
        (ownerTurn.message || '').toLowerCase().includes(key.slice(0, 6))
      ) {
        ledger.explicitUnknowns.push(u);
      }
    }
  }

  return ledger;
}
