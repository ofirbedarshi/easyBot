/**
 * UX judge: scores Builder and Business Bot text the way a non-technical
 * business owner would feel them. Separate from the factual judge.
 * Pass only at score 4 or 5. Does not judge whether facts are true.
 */
import OpenAI from 'openai';
import { DEMO_HANDOFF } from './customerPrompt.js';
import { resolveJudgeMode, judgeModelName } from './judge.js';

export const UX_JUDGE_VERSION = '1.0.0';

const SHARED_DIMS = ['ease', 'simplicity', 'warmth', 'feel'];
const BUILDER_DIMS = [...SHARED_DIMS, 'arrangement'];
const BOT_DIMS = [...SHARED_DIMS, 'answer_first', 'shop_voice'];

const JARGON_RE =
  /\b(json|flowise|draft\.|as an ai|approved business facts|chatflow|system prompt|informationtocollect|readyforreview)\b/i;

/**
 * @param {'builder'|'business_bot'} channel
 */
export function uxDimensionKeys(channel) {
  return channel === 'builder' ? BUILDER_DIMS : BOT_DIMS;
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(1, Math.min(5, Math.round(x)));
}

function emptyUxDimensions(channel, score = null) {
  const dims = {};
  for (const key of uxDimensionKeys(channel)) {
    dims[key] = { score, note: '' };
  }
  return dims;
}

/**
 * Soft average cannot hide one bad part: any dim 1–2 caps overall at 3.
 */
export function applyUxSoftCap(score, dimensions) {
  let s = clampScore(score);
  if (s == null) return null;
  const dims = dimensions || {};
  for (const key of Object.keys(dims)) {
    const d = clampScore(dims[key]?.score);
    if (d != null && d <= 2 && s > 3) {
      s = 3;
      break;
    }
  }
  return s;
}

function countQuestions(text) {
  const t = String(text || '');
  const marks = (t.match(/\?/g) || []).length;
  const numbered = (t.match(/^\s*\d+[\).\]]\s+/gm) || []).length;
  return Math.max(marks, numbered);
}

function wrapUxResult(partial, mode, model, channel) {
  const dimensions = {
    ...emptyUxDimensions(channel),
    ...(partial.dimensions || {}),
  };
  for (const key of uxDimensionKeys(channel)) {
    const d = dimensions[key] || { score: null, note: '' };
    dimensions[key] = {
      score: clampScore(d.score),
      note: d.note != null ? String(d.note) : '',
    };
  }
  let score = applyUxSoftCap(partial.score, dimensions);
  if (score == null) score = 3;

  const unreliable = !!partial.unreliable;
  const pass = !unreliable && score >= 4;

  return {
    score,
    pass,
    rationale: partial.rationale || '',
    quotes: Array.isArray(partial.quotes) ? partial.quotes : [],
    dimensions,
    model,
    mode,
    judgeVersion: UX_JUDGE_VERSION,
    unreliable,
    channel: channel || partial.channel || null,
    scope: partial.scope || null,
  };
}

/**
 * Stub UX judge: labelled heuristic for offline dry-runs. Not a real feel judgment.
 */
function stubUxJudge(args) {
  const text = String(args.outputText || '');
  const lower = text.toLowerCase();
  const channel = args.channel;
  const scope = args.scope || 'reply';
  const questions = countQuestions(text);
  const longWall = scope === 'reply' && text.length > 900;
  const jargon = JARGON_RE.test(text);
  const setupWizard =
    channel === 'business_bot' &&
    /(should the (customer )?bot collect|approved business facts|as an ai)/i.test(
      lower
    );

  let score = 4;
  let rationale =
    scope === 'overall' ? 'stub: overall transcript ok' : 'stub: short plain reply';

  if (jargon || setupWizard) {
    score = 2;
    rationale = jargon
      ? 'stub: jargon / process talk'
      : 'stub: setup-wizard voice to customer';
  } else if (scope === 'reply' && channel === 'builder' && questions > 2) {
    score = 2;
    rationale = 'stub: more than two questions in one Builder turn';
  } else if (longWall) {
    score = 2;
    rationale = 'stub: wall of text';
  } else if (text.length < 8) {
    score = 3;
    rationale = 'stub: empty or near-empty';
  } else if (
    text.includes(DEMO_HANDOFF) ||
    /cannot confirm|don't know|not sure/i.test(lower)
  ) {
    score = 4;
    rationale = 'stub: plain gap or demo handoff OK';
  }

  const dims = emptyUxDimensions(channel, score);
  dims.ease.note = rationale;
  return wrapUxResult(
    {
      score,
      rationale,
      quotes: text ? [text.slice(0, 160)] : [],
      dimensions: dims,
      channel,
      scope,
    },
    'stub',
    'stub',
    channel
  );
}

const SYSTEM_UX = `You are a non-technical business owner using easyBot for the first time.
You are NOT a designer, NOT a tester, and NOT a factual fact-checker.
Score ONLY how the words feel to use: ease, simplicity, warmth, overall feel.
Do NOT score whether prices, policies, or facts are correct.

Channels:
- builder: you are the owner being interviewed to set up a customer chatbot. Replies should acknowledge what you said, ask one or two questions, and keep summaries easy to scan.
- business_bot: you are a customer talking to the shop's bot. Hold this channel to a higher bar: answer first (or plainly admit a gap), sound like the shop, never like a setup wizard.

Scopes:
- reply: judge one visible assistant message (plus the user line it answers when given).
- overall: judge the ordered conversation for that channel. Repeated questions after they were answered hurt arrangement/ease.

Score integers 1–5:
5 — easy to follow, warm, plain, well arranged
4 — good enough that a busy owner would keep going
3 — usable but awkward
2 — hard: confusing, cold, or too much at once
1 — would quit

Shared dimensions (each 1–5 with a short note):
- ease — one obvious next step, no hunting
- simplicity — short, everyday words
- warmth — friendly, not cold, not scolding
- feel — would keep going

Builder also scores:
- arrangement — acknowledges what was just said, then one or two questions; does not repeat; summary easy to scan

Business Bot also scores (stricter):
- answer_first — the answer (or the plain gap) comes before extra talk
- shop_voice — sounds like the business, not a setup wizard

Do NOT lower the score only because:
- the reply uses the required demo handoff inviting the customer to leave a message for the owner
- it admits a gap in plain words
- it is short
- it mentions approve, /test, /end, or /reset once in plain language

DO lower the score when:
- more than two questions in one Builder turn
- jargon or process talk (JSON, draft, Flowise, "approved business facts", "as an AI", asking the customer whether the bot should collect something)
- a wall of text or a spec-like list
- the same question comes back after it was answered (overall)
- the customer has to dig for the point

If ANY dimension is 1 or 2, overall score MUST be 3 or below (soft average cannot hide one bad part).

Return JSON only:
{
  "score": 1|2|3|4|5,
  "rationale": "one or two sentences an owner would recognize",
  "quotes": ["exact bits from the text under test"],
  "dimensions": {
    "ease": {"score":1-5,"note":"..."},
    "simplicity": {"score":1-5,"note":"..."},
    "warmth": {"score":1-5,"note":"..."},
    "feel": {"score":1-5,"note":"..."}
  }
}
Include arrangement for builder. Include answer_first and shop_voice for business_bot.`;

function formatTranscript(turns) {
  if (!Array.isArray(turns) || !turns.length) return '';
  return turns
    .map((t) => {
      const role = t.role || 'unknown';
      const text = t.text != null ? String(t.text) : '';
      return `${role}: ${text}`;
    })
    .join('\n');
}

async function realUxJudge(args) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = judgeModelName();
  const channel = args.channel;
  const scope = args.scope || 'reply';

  const payload = {
    channel,
    scope,
    userMessage: args.userMessage || null,
    outputUnderTest: args.outputText || null,
    transcript: args.transcript || null,
    note:
      'Judge feel and arrangement only. Facts being wrong or right is out of scope. Demo handoff sentence is allowed.',
  };

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_UX },
      { role: 'user', content: JSON.stringify(payload) },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content || '{}');
  } catch {
    return wrapUxResult(
      {
        score: 3,
        rationale: 'ux judge parse failed',
        quotes: [],
        dimensions: emptyUxDimensions(channel, 3),
        channel,
        scope,
      },
      'real',
      model,
      channel
    );
  }

  return wrapUxResult(
    {
      score: parsed.score,
      rationale: parsed.rationale || '',
      quotes: parsed.quotes || [],
      dimensions: parsed.dimensions || emptyUxDimensions(channel),
      channel,
      scope,
    },
    'real',
    model,
    channel
  );
}

/**
 * Primary UX judge entry.
 *
 * @param {object} args
 * @param {'builder'|'business_bot'} args.channel
 * @param {'reply'|'overall'} [args.scope]
 * @param {string} [args.outputText] — visible assistant message (reply scope)
 * @param {string} [args.userMessage] — user line answered (reply scope)
 * @param {Array<{role:string,text?:string}>} [args.transcript] — channel turns (overall scope)
 * @param {boolean} [args.forceUnreliable] — mark unreliable when UX calibration failed
 */
export async function judgeUx(args) {
  const channel = args.channel === 'builder' ? 'builder' : 'business_bot';
  const scope = args.scope === 'overall' ? 'overall' : 'reply';

  let outputText = args.outputText;
  if (scope === 'overall' && (outputText == null || outputText === '')) {
    outputText = formatTranscript(args.transcript);
  }

  const payload = {
    ...args,
    channel,
    scope,
    outputText,
  };

  const mode = resolveJudgeMode();
  let result =
    mode === 'real' ? await realUxJudge(payload) : stubUxJudge(payload);

  if (args.forceUnreliable) {
    // Unreliable UX checks must not fail the product run.
    result = {
      ...result,
      unreliable: true,
      skippedUnreliable: true,
      pass: true,
      rationale: `[ux evaluator unreliable — calibration failed] ${result.rationale || ''}`.trim(),
    };
  }

  return result;
}

/**
 * Helper for runners: record-friendly UX payload.
 */
export function uxJudgeFields(j) {
  return {
    verdict: j.pass ? 'PASS' : 'FAIL',
    score: j.score,
    rationale: j.rationale,
    quotes: j.quotes,
    dimensions: j.dimensions,
    mode: j.mode,
    model: j.model,
    judgeVersion: j.judgeVersion,
    unreliable: j.unreliable,
    skippedUnreliable: !!j.skippedUnreliable,
    channel: j.channel,
    scope: j.scope,
  };
}
