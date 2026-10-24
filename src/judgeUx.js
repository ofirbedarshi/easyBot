/**
 * UX judge: scores Builder and Business Bot text the way a non-technical
 * business owner would feel them. Separate from the factual judge.
 * Pass only at score 4 or 5. Does not judge whether facts are true.
 * Whether a known answer was withheld belongs to the semantic judge.
 */
import OpenAI from 'openai';
import {
  resolveJudgeMode,
  judgeModelName,
  EVALUATION_UNRELIABLE,
} from './judge.js';
import { buildUxPayload, sha256Text } from './judgeEvidence.js';

export const UX_JUDGE_VERSION = '2.0.1';

const SHARED_DIMS = ['clarity', 'warmth', 'feel'];
const BUILDER_DIMS = [...SHARED_DIMS, 'ease', 'simplicity', 'arrangement'];
const BOT_DIMS = [
  'clarity',
  'relevance',
  'brevity',
  'repetition',
  'warmth',
  'feel',
  'shop_voice',
  'next_step',
];
const STYLE_MATCH_DIM = 'style_match';

const JARGON_RE =
  /\b(json|flowise|draft\.|as an ai|approved business facts|chatflow|system prompt|informationtocollect|readyforreview)\b/i;

/**
 * @param {'builder'|'business_bot'} channel
 * @param {{ includeStyleMatch?: boolean }} [opts]
 */
export function uxDimensionKeys(channel, opts = {}) {
  const base = channel === 'builder' ? BUILDER_DIMS : BOT_DIMS;
  if (opts.includeStyleMatch) return [...base, STYLE_MATCH_DIM];
  return base;
}

function clampScore(n) {
  if (n == null || n === '') return null;
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(1, Math.min(5, Math.round(x)));
}

function emptyUxDimensions(channel, score = null, opts = {}) {
  const dims = {};
  for (const key of uxDimensionKeys(channel, opts)) {
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

function wrapUxResult(partial, mode, model, channel, opts = {}) {
  const includeStyleMatch = !!opts.includeStyleMatch;
  const allowed = new Set(uxDimensionKeys(channel, { includeStyleMatch }));
  const incoming = partial.dimensions || {};
  const dimensions = emptyUxDimensions(channel, null, { includeStyleMatch });
  for (const key of allowed) {
    const d = incoming[key] || { score: null, note: '' };
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

function stubUxJudge(args, modelPayload) {
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
  const evasiveRedirect =
    channel === 'business_bot' &&
    /message the owner/i.test(lower) &&
    text.trim().length < 80 &&
    !/(don't have|do not have|can't confirm|cannot confirm|not sure)/i.test(
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
  } else if (deadEnd || boilerplateTail || evasiveRedirect) {
    score = 2;
    rationale = deadEnd
      ? 'stub: dead-end refusal with no next step'
      : evasiveRedirect
        ? 'stub: evasive generic redirect'
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
  }

  const includeStyleMatch = !!modelPayload.includeStyleMatch;
  const dims = emptyUxDimensions(channel, score, { includeStyleMatch });
  if (dims.clarity) dims.clarity.note = rationale;
  if (includeStyleMatch && dims.style_match) {
    const len = args.behaviorSettings?.responseLength;
    if (len === 'short' && text.length > 420) {
      dims.style_match = {
        score: 2,
        note: 'stub: long reply vs short setting',
      };
      score = applyUxSoftCap(score, dims) ?? 3;
      rationale = 'stub: reply too long for short style';
    } else {
      dims.style_match = { score, note: 'stub: style present' };
    }
  }
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
    channel,
    { includeStyleMatch }
  );
}

export const SYSTEM_UX = `You are a non-technical business owner using easyBot for the first time.
You are NOT a designer, NOT a tester, and NOT a factual fact-checker.
Score ONLY how the words feel to use: clarity, relevance, warmth, brevity, repetition, and style.
Do NOT score whether prices, policies, or facts are correct.
Do NOT decide whether a known business fact was withheld — that is the semantic judge's job. You have no business-facts evidence.

Channels:
- builder: you are the owner being interviewed to set up a customer chatbot. Replies should acknowledge what you said, ask one or two questions, and keep summaries easy to scan.
- business_bot: you are a customer talking to the shop's bot. Hold this channel to a higher bar: answer first (or plainly admit a gap), sound like the shop, never like a setup wizard.

Scopes:
- reply: judge one visible assistant message (plus the user line it answers when given), with optional priorConversation for repetition/context.
- overall: judge the ordered conversation for that channel. For business_bot overall: a customer repeating a question is the Tester probing — do NOT blame the Business Bot for customer repeats. Judge only how the Business Bot's own replies feel.

Score integers 1–5:
5 — easy to follow, warm, plain, well arranged
4 — good enough that a busy owner would keep going
3 — usable but awkward
2 — hard: confusing, cold, or too much at once
1 — would quit

Shared / Builder dimensions (each 1–5 with a short note):
- clarity — easy to understand; point is obvious
- warmth — friendly, not cold, not scolding
- feel — would keep going
- ease — one obvious next step, no hunting (builder)
- simplicity — short, everyday words (builder)
- arrangement — acknowledges what was just said, then one or two questions; does not repeat; summary easy to scan (builder)

Business Bot dimensions (each 1–5):
- clarity — plain, scannable wording
- relevance — addresses the customer's latest question; a gap admission or owner redirect is fine when it names the specific gap; a generic redirect that dodges the asked question scores low
- brevity — proportionate length; not a wall of text
- repetition — does not re-ask for details already given in priorConversation; does not recycle the same boilerplate closing on every reply
- warmth — friendly, not cold
- feel — would keep chatting with this shop
- shop_voice — sounds like the business, not a setup wizard or admin tool
- next_step — when intent or a named gap appears, the customer knows what to do next (follow-up, intake, or message the owner). A clear pure information answer may score next_step high without an extra CTA

When behaviorSettings are provided, ALSO score:
- style_match — reply matches the owner's tone and reply-length settings. Do NOT dock a professional/concise tone for being less effusive. Do NOT require volunteering prices.
- Under responseLength "short": prefer brief replies. A *substantial* violation of short style (long padded expansion, many elaborating sentences, chatty wall beyond a compact shop answer) MUST materially lower both brevity and style_match (typically into the 1–2 range so soft-cap can apply). Mild length overshoot alone is not enough.
- Do NOT equate multiple paragraphs with excessive length by itself — short can still use line breaks. Judge substance and padding, not paragraph count.
- Do NOT apply a blanket overall-score cap merely because any dimension scored 3. Soft-cap (overall ≤3) applies only when a dimension is 1 or 2.

Contextual criteria (no automatic high or low scores):
- A gap admission or "message the owner" alone neither guarantees a high score nor forces a penalty. Score on whether the gap is named, the reply fits the question, and the wording is clear.
- Observably evasive: a short generic "message the owner" that never names what is missing and ignores the customer's question → low relevance.
- Helpful observable gap reply: names the missing detail in plain words and offers a clear next step → can score well on relevance/clarity/next_step.
- Semantic correctness is out of scope: a factually wrong but clear, warm reply can still score UX high. Semantic FAIL + UX PASS is valid.

Lower the score when:
- more than two questions in one Builder turn
- jargon or process talk (JSON, draft, Flowise, "approved business facts", "as an AI", asking the customer whether the bot should collect something)
- internal customer-facing wording: "approved", "undecided", "available information", "according to" (system/records talk)
- canned boilerplate closings that add no useful next step (e.g. "If you need this clarified, leave a message for the owner…")
- promising the owner will get back / call the customer
- a dead-end refusal with no next step
- a wall of text or a spec-like list
- (builder overall) the same question comes back after it was answered
- the customer has to dig for the point
- re-asking for intake already answered in priorConversation

Do not lower solely because:
- the reply is short
- it mentions approve, /test, /end, or /reset once in plain language
- leftover Flowise sync chrome (stripped before you see the text)
- (overall / business_bot) the customer asked the same question more than once
- (overall / business_bot) a price changes mid-transcript after an owner edit — expected test flow
- (builder) a denser review summary that confirms changes in plain words

If ANY dimension is 1 or 2, overall score MUST be 3 or below (soft average cannot hide one bad part).

Return JSON only:
{
  "score": 1|2|3|4|5,
  "rationale": "one or two sentences an owner would recognize",
  "quotes": ["exact bits from the text under test"],
  "dimensions": {
    "clarity": {"score":1-5,"note":"..."},
    "relevance": {"score":1-5,"note":"..."},
    "brevity": {"score":1-5,"note":"..."},
    "repetition": {"score":1-5,"note":"..."},
    "warmth": {"score":1-5,"note":"..."},
    "feel": {"score":1-5,"note":"..."},
    "ease": {"score":1-5,"note":"..."},
    "simplicity": {"score":1-5,"note":"..."},
    "arrangement": {"score":1-5,"note":"..."},
    "shop_voice": {"score":1-5,"note":"..."},
    "next_step": {"score":1-5,"note":"..."},
    "style_match": {"score":1-5,"note":"..."}
  }
}
For builder: include clarity, warmth, feel, ease, simplicity, arrangement; omit relevance, brevity, repetition, shop_voice, next_step.
For business_bot: include clarity, relevance, brevity, repetition, warmth, feel, shop_voice, next_step; omit ease, simplicity, arrangement.
Include style_match ONLY when behaviorSettings were provided in the payload; otherwise omit it.
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

async function realUxJudge(args, modelPayload) {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = judgeModelName();
  const channel = args.channel;
  const scope = args.scope || 'reply';
  const includeStyleMatch = !!modelPayload.includeStyleMatch;
  const system = SYSTEM_UX;
  const user = JSON.stringify(modelPayload);

  const completion = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const rawContent = completion.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return {
      result: wrapUxResult(
        {
          score: 3,
          rationale: 'ux judge parse failed',
          quotes: [],
          dimensions: emptyUxDimensions(channel, 3, { includeStyleMatch }),
          channel,
          scope,
        },
        'real',
        model,
        channel,
        { includeStyleMatch }
      ),
      rawOutput: rawContent,
      judgeInput: {
        promptVersion: UX_JUDGE_VERSION,
        systemSha256: sha256Text(system),
        user: modelPayload,
      },
    };
  }

  return {
    result: wrapUxResult(
      {
        score: parsed.score,
        rationale: parsed.rationale || '',
        quotes: parsed.quotes || [],
        dimensions:
          parsed.dimensions ||
          emptyUxDimensions(channel, null, { includeStyleMatch }),
        channel,
        scope,
      },
      'real',
      model,
      channel,
      { includeStyleMatch }
    ),
    rawOutput: parsed,
    judgeInput: {
      promptVersion: UX_JUDGE_VERSION,
      systemSha256: sha256Text(system),
      user: modelPayload,
    },
  };
}

/**
 * Primary UX judge entry.
 *
 * @param {object} args
 * @param {'builder'|'business_bot'} args.channel
 * @param {'reply'|'overall'} [args.scope]
 * @param {string} [args.outputText]
 * @param {string} [args.userMessage]
 * @param {Array<{role:string,text?:string}>} [args.transcript]
 * @param {Array<{role:string,text?:string}>} [args.priorConversation]
 * @param {object} [args.behaviorSettings]
 * @param {boolean} [args.forceUnreliable]
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
  const priorConversation = Array.isArray(args.priorConversation)
    ? args.priorConversation.map((t) =>
        t && typeof t === 'object'
          ? { ...t, text: stripAppChrome(t.text) }
          : t
      )
    : args.priorConversation;

  const modelPayload = buildUxPayload({
    channel,
    scope,
    userMessage: args.userMessage,
    outputText,
    priorConversation,
    transcript,
    behaviorSettings: args.behaviorSettings || null,
  });

  const mode = resolveJudgeMode();
  let result;
  let rawOutput = null;
  let judgeInput = {
    promptVersion: UX_JUDGE_VERSION,
    systemSha256: sha256Text(SYSTEM_UX),
    user: modelPayload,
  };

  if (mode === 'real') {
    const judged = await realUxJudge(
      { ...args, channel, scope, outputText, transcript, priorConversation },
      modelPayload
    );
    result = judged.result;
    rawOutput = judged.rawOutput;
    judgeInput = judged.judgeInput;
  } else {
    result = stubUxJudge(
      { ...args, channel, scope, outputText, transcript, priorConversation },
      modelPayload
    );
    rawOutput = { score: result.score, rationale: result.rationale, stub: true };
  }

  if (args.forceUnreliable) {
    // Incomplete evaluation — not product PASS, not product FAIL.
    result = {
      ...result,
      unreliable: true,
      skippedUnreliable: false,
      pass: false,
      evaluationStatus: EVALUATION_UNRELIABLE,
      rationale: `[${EVALUATION_UNRELIABLE} — UX calibration failed] ${result.rationale || ''}`.trim(),
    };
  }

  return {
    ...result,
    evaluationStatus: result.unreliable
      ? EVALUATION_UNRELIABLE
      : result.evaluationStatus || null,
    judgeInput,
    rawOutput,
  };
}

/**
 * Helper for runners: record-friendly UX payload.
 */
export function uxJudgeFields(j) {
  const unreliable = !!j.unreliable;
  return {
    verdict: unreliable
      ? EVALUATION_UNRELIABLE
      : j.pass
        ? 'PASS'
        : 'FAIL',
    score: j.score,
    rationale: j.rationale,
    quotes: j.quotes,
    dimensions: j.dimensions,
    mode: j.mode,
    model: j.model,
    judgeVersion: j.judgeVersion,
    unreliable,
    skippedUnreliable: !!j.skippedUnreliable,
    evaluationStatus: j.evaluationStatus || (unreliable ? EVALUATION_UNRELIABLE : null),
    channel: j.channel,
    scope: j.scope,
    judgeInput: j.judgeInput || null,
    rawOutput: j.rawOutput || null,
  };
}
