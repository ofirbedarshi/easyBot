#!/usr/bin/env node
/**
 * Live replay: Builder interview reaction-then-question (real OpenAI).
 *
 *   OPENAI_MODEL=gpt-6-luna node scripts/replay-builder-reaction.js
 *
 * Not part of the default test suite. A few cents at gpt-6-luna prices.
 * Judges only interview turns (skips app/nav/review/goal-fallback).
 */
import 'dotenv/config';
import {
  adjustChatParamsOnError,
  applyReviewGate,
  getClient,
  openingMessage,
  runBuilderTurn,
} from '../src/builder.js';
import { REQUIRED_TOPICS, topicJustAsked } from '../src/builderTopics.js';
import { emptyProfile } from '../src/profile.js';
import { attachCostTracker } from './lib/modelCost.js';

const MODEL = process.env.OPENAI_MODEL || process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';

const OWNER_TURNS = [
  "We're a family-run bakery in the old town — my grandmother started it in the 1970s.",
  'We still deliver sourdough on a bicycle through the cobblestone streets.',
  "Custom cakes need three days' notice and we write names in chocolate script.",
  "The bakery is called Miller's Oven.",
  'Just answer customer questions about the menu, hours, and custom cakes.',
  'Sourdough loaves are $8, croissants $3.50, cakes from $45. Open Tuesday through Sunday 7am to 3pm, closed Monday.',
];

function isInterviewTurn(turn) {
  if (turn.presentReview) return false;
  const msg = String(turn.message || '');
  return !REQUIRED_TOPICS.some((topic) => {
    if (topic.askedMarker && msg.includes(topic.askedMarker)) return true;
    if (topic.question && msg.includes(topic.question)) return true;
    return false;
  });
}

/** True when a completed non-question sentence appears before the first '?'. */
function hasLeadBeforeQuestion(text) {
  const s = String(text || '');
  const q = s.indexOf('?');
  if (q <= 0) return false;
  return /[.!]/.test(s.slice(0, q));
}

async function judgeFirstSentence({ ownerMessage, builderReply }) {
  const client = getClient();
  const messages = [
    {
      role: 'system',
      content:
        'Judge one Builder interview reply. Look only at the first sentence of builderReply. Answer yes if that sentence refers to a concrete detail from ownerMessage. Answer no if it does not. Reply with only yes or no.',
    },
    {
      role: 'user',
      content: JSON.stringify({ ownerMessage, builderReply }),
    },
  ];
  let params = { model: MODEL, messages, max_completion_tokens: 256, store: false };
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try {
      const completion = await client.chat.completions.create(params);
      const text = String(completion.choices?.[0]?.message?.content || '')
        .trim()
        .toLowerCase();
      if (/^yes\b/.test(text)) return true;
      if (/^no\b/.test(text)) return false;
      return false;
    } catch (err) {
      lastErr = err;
      const next = adjustChatParamsOnError(params, err);
      if (!next) break;
      params = next;
    }
  }
  throw lastErr;
}

async function runInterview() {
  const profile = emptyProfile();
  const buildHistory = [{ role: 'assistant', content: openingMessage().message, nav: null }];
  const turns = [];
  let ownerName = null;

  console.log('======= Transcript =======\n');
  console.log(`[BUILDER]\n${openingMessage().message}\n`);

  for (const userMessage of OWNER_TURNS) {
    const raw = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage,
      model: MODEL,
    });
    if (raw.ownerName) ownerName = raw.ownerName;
    const turn = applyReviewGate(profile, raw, userMessage, {
      justAsked: topicJustAsked(buildHistory),
      ownerName,
    });
    profile.draft = turn.draft;
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
    const row = {
      ownerMessage: userMessage,
      builderReply: turn.message,
      presentReview: !!turn.presentReview,
      interview: isInterviewTurn(turn),
    };
    turns.push(row);
    console.log(`[OWNER] ${userMessage}`);
    console.log(`[BUILDER] ${turn.message}\n`);
  }

  return turns;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }
  const cost = attachCostTracker(MODEL);
  console.log(`Model: ${MODEL}\n`);

  const turns = await runInterview();
  const judged = turns.filter((t) => t.interview).slice(0, 3);

  console.log('======= Judged early interview turns =======\n');
  if (judged.length < 3) {
    console.error(
      `Need 3 interview turns to judge; found ${judged.length} (skipped app/nav/review/goal-fallback).`
    );
    cost.print();
    process.exit(1);
  }

  let yesCount = 0;
  for (let i = 0; i < judged.length; i++) {
    const t = judged[i];
    const structural = hasLeadBeforeQuestion(t.builderReply);
    const refers = await judgeFirstSentence({
      ownerMessage: t.ownerMessage,
      builderReply: t.builderReply,
    });
    const yes = structural && refers;
    if (yes) yesCount += 1;
    console.log(`turn ${i + 1}`);
    console.log(`  owner: ${t.ownerMessage}`);
    console.log(`  reply: ${t.builderReply.replace(/\s+/g, ' ').slice(0, 240)}`);
    console.log(`  structural_lead_before_?: ${structural ? 'yes' : 'no'}`);
    console.log(`  first_sentence_refers_to_detail: ${refers ? 'yes' : 'no'}`);
    console.log(`  judged: ${yes ? 'yes' : 'no'}\n`);
  }

  const pass = yesCount >= 2;
  console.log(`judged_yes ${yesCount}/3  pass=${pass}`);
  cost.print();
  if (!pass) {
    console.error('\nREPLAY FAIL');
    process.exit(1);
  }
  console.log('\nREPLAY PASS');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
