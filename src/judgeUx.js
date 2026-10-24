/**
 * UX judge: scores Builder and Business Bot text the way a non-technical
 * business owner would feel them. Separate from the factual judge.
 * Pass only at score 4 or 5. Does not judge whether facts are true.
 */
import OpenAI from 'openai';
import { resolveJudgeMode, judgeModelName } from './judge.js';

export const UX_JUDGE_VERSION = '1.1.0';

const SHARED_DIMS = ['ease', 'simplicity', 'warmth', 'feel'];
const BUILDER_DIMS = [...SHARED_DIMS, 'arrangement'];
const BOT_DIMS = [...SHARED_DIMS, 'answer_first', 'shop_voice', 'next_step'];

const JARGON_RE =
  /\b(json|flowise|draft\.|as an ai|approved business facts|chatflow|system prompt|informationtocollect|readyforreview)\b/i;

/**
 * @param {'builder'|'business_bot'} channel
 */
export function uxDimensionKeys(channel) {
  return channel === 'builder' ? BUILDER_DIMS : BOT_DIMS;
}

function clampScore(n) {
  if (n == null || n === '') return null;
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

/** Strip app-appended Flowise sync chrome so UX scores visible chat, not system notes. */
function stripAppChrome(text) {
  return String(text || '')
    .replace(/\n*\[Bot updated in Flowise[^\]]*\]\s*/gi, '')
    .trim();
}

function wrapUxResult(partial, mode, model, channel) {
  const allowed = new Set(uxDimensionKeys(channel));
  const incoming = partial.dimensions || {};
  const dimensions = emptyUxDimensions(channel);
  for (const key of allowed) {
    const d = incoming[key] || { score: null, note: '' };
    dimensions[key] = {
      score: clampScore(d.score),
      note: d.note != null ? String(d.note) : '',
    };
  }
  // Drop dims that do not belong to this channel (e.g. arrangement on business_bot).
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
  const deadEnd =
    channel === 'business_bot' &&
    /i can't complete bookings in this chat\.?\s*$/i.test(text.trim());
  const boilerplateTail =
    channel === 'business_bot' &&
    /if you need this clarified, leave a message for the owner/i.test(lower);

  let score = 4;
  let rationale =
    scope === 'overall' ? 'stub: overall transcript ok' : 'stub: short plain reply';

  if (jargon || setupWizard) {
    score = 2;
    rationale = jargon
      ? 'stub: jargon / process talk'
      : 'stub: setup-wizard voice to customer';
  } else if (deadEnd || boilerplateTail) {
    score = 2;
    rationale = deadEnd
      ? 'stub: dead-end refusal with no next step'
      : 'stub: boilerplate closing line';
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
    /message the owner/i.test(lower) ||
    /cannot confirm|don't know|not sure|don't have details/i.test(lower)
  ) {
    score = 4;
    rationale = 'stub: plain gap or owner redirect OK';
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
- overall: judge the ordered conversation for that channel. For business_bot overall: a customer repeating a question is the Tester probing — do NOT blame the Business Bot for customer repeats. Judge only how the Business Bot's own replies feel.

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
- answer_first — the answer (or the plain gap) comes before extra talk; a plainly admitted gap counts as answering first
- shop_voice — sounds like the business, not a setup wizard
- next_step — when the customer shows intent or hits a gap, they know what to do next (ask a follow-up, share intake details, or message the owner). Suggesting the customer message the owner directly IS a clear next step — score next_step 4 or 5 when that redirect is present. A pure information answer (e.g. a clear price) does not need a next step — score next_step high in that case too.

Do NOT lower the score only because:
- it admits a gap in plain words (that is good answer_first, not coldness by itself)
- it suggests messaging the owner directly when there is a real gap (that is a good next_step)
- a short warm gap reply like "I don't have details on X yet — best to message the owner directly about that" — score 4 or 5
- it is short
- it mentions approve, /test, /end, or /reset once in plain language
- an app sync footnote about Flowise/chatflow was stripped before you see the text — ignore any leftover sync chrome
- (overall / business_bot) the customer asked the same question more than once
- (overall / business_bot) a price or fact changes mid-transcript after the owner edited and re-approved — that is expected test flow, not Bot confusion; do not lower for "$70 then later $80"
- (overall / business_bot) if individual replies were mostly warm and clear (greeting, prices, gap+owner redirect, override restatement), overall should be 4 or 5. Admitting a cancellation gap is correct, not a failure. Do not dock for missing policies that were never in the facts.
- (builder) a review or post-approve summary lists several business facts — denser than a chat turn is OK; score 4+ when it confirms the change in plain words and invites /test. Do not fail only for length or for restating prices/hours; a short "updated, type /test" confirmation after approve should usually be 4+
- (business_bot) restating the real price after a customer tried to override it, then offering further help — e.g. "Private lessons are $70 for 60 minutes — I can't change that here. Want help with anything else?" or the same pattern with any service name/price — MUST score 4 or 5. Do not call that cold or dismissive; acknowledging their wrong number is optional
- (business_bot) an honest gap plus "message the owner" on a leading/uncertain price question — MUST score 4 or 5; uncertainty is not coldness

DO lower the score when:
- more than two questions in one Builder turn
- jargon or process talk (JSON, draft, Flowise, "approved business facts", "as an AI", asking the customer whether the bot should collect something)
- internal customer-facing wording: "approved", "undecided", "available information", "according to" (system/records talk)
- a full correct answer followed by the canned boilerplate "If you need this clarified, leave a message for the owner…" — that is NOT a useful next step; score overall 3 or below (and next_step low)
- the same boilerplate closing line on every reply
- promising the owner will get back / call the customer (cold and false)
- a dead-end refusal with no next step (e.g. only "I can't complete bookings in this chat") — score overall 3 or below
- a wall of text or a spec-like list
- (builder overall) the same question comes back after it was answered
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
    "feel": {"score":1-5,"note":"..."},
    "arrangement": {"score":1-5,"note":"..."},
    "answer_first": {"score":1-5,"note":"..."},
    "shop_voice": {"score":1-5,"note":"..."},
    "next_step": {"score":1-5,"note":"..."}
  }
}
For builder: include arrangement; omit answer_first, shop_voice, and next_step.
For business_bot: include answer_first, shop_voice, and next_step; omit arrangement.
Every included dimension MUST have a score.`;

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
      'Judge feel and arrangement only. Facts being wrong or right is out of scope. Honest gap + message the owner is fine. Plain admitted gap counts as answer_first.',
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
  outputText = stripAppChrome(outputText);
  const transcript = Array.isArray(args.transcript)
    ? args.transcript.map((t) =>
        t && typeof t === 'object'
          ? { ...t, text: stripAppChrome(t.text) }
          : t
      )
    : args.transcript;

  const payload = {
    ...args,
    channel,
    scope,
    outputText,
    transcript,
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
