#!/usr/bin/env node
/**
 * Opt-in Builder capture replay (real OpenAI, costs money).
 *
 * Two-turn Rosa interview, 12 runs per cell by default.
 * Usage:
 *   node scripts/replay-builder-capture.js
 *   node scripts/replay-builder-capture.js --models gpt-4o-mini --modes legacy,delta --runs 12
 *
 * Not part of the default test suite. Budget cap $2 unless --budget is set.
 */
import { runBuilderTurn, openingMessage } from '../src/builder.js';
import { emptyProfile } from '../src/profile.js';

const ARGS = parseArgs(process.argv.slice(2));
const MODELS = ARGS.models || ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1'];
const MODES = ARGS.modes || ['legacy', 'delta'];
const RUNS = ARGS.runs ?? 12;
const CONCURRENCY = ARGS.concurrency ?? 2;
const BUDGET = ARGS.budget ?? 2;

const PRICES = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-6-sol': { in: 2, out: 10 },
  'gpt-6-luna': { in: 0.1, out: 0.5 },
};

/** Prior Rosa two-turn × 12 delta row (same PR), for reference — not rerun. */
const PRIOR_DELTA = {
  'gpt-4.1-mini': {
    n: 12,
    year1998: '100%',
    nutFree: '100%',
    delivery: '100%',
    deliveryFull: '100%',
    newFactsKey: '100%',
    newFactsNonempty: '38%',
    medianLatencyMs: 1997,
    medianOutTok: 240,
    medianInTok: 5129,
    medianReasoningTok: 0,
    effort: '—',
    cost: 0.059,
  },
};

const INTRO =
  "I own Rosa's Bakery, a family bakery in Portland, Oregon, open since 1998, famous for our sourdough and custom cakes.";
const DUMP =
  "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--models') out.models = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--modes') out.modes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--runs') out.runs = Number(argv[++i]);
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--help') out.help = true;
  }
  return out;
}

function flattenDraft(draft) {
  const parts = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(draft);
  return parts.join('\n');
}

function scoreDraft(draft) {
  const text = flattenDraft(draft);
  return {
    year1998: /\b1998\b/.test(text),
    nutFree: /nut[-\s]?free/i.test(text),
    delivery: /deliver/i.test(text),
    delivery3mi: /3\s*-?\s*miles/i.test(text),
    delivery40: /\$?\s*40\b/.test(text),
    delivery8: /\$?\s*8\b/.test(text),
  };
}

function newFactsPresent(modelJson, mode) {
  if (!modelJson || typeof modelJson !== 'object') return false;
  if (mode === 'legacy') return Object.prototype.hasOwnProperty.call(modelJson.draft || {}, 'newFacts');
  return Object.prototype.hasOwnProperty.call(modelJson, 'newFacts');
}

function newFactsCount(modelJson, mode) {
  const list = mode === 'legacy' ? modelJson?.draft?.newFacts : modelJson?.newFacts;
  return Array.isArray(list) ? list.filter((x) => String(x || '').trim()).length : 0;
}

function costOf(model, usage) {
  const p = PRICES[model] || PRICES['gpt-4o-mini'];
  const input = usage?.prompt_tokens || 0;
  const output = usage?.completion_tokens || 0;
  return (input * p.in + output * p.out) / 1e6;
}

function median(nums) {
  if (!nums.length) return 0;
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function pct(n, d) {
  if (!d) return '0%';
  return `${Math.round((100 * n) / d)}%`;
}

async function oneInterview({ model, mode }) {
  const profile = emptyProfile();
  const buildHistory = [{ role: 'assistant', content: openingMessage().message, nav: null }];
  const turns = [];
  for (const userMessage of [INTRO, DUMP]) {
    const turn = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage,
      model,
      mode,
    });
    profile.draft = turn.draft;
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
    turns.push(turn);
  }
  return { draft: profile.draft, turns };
}

async function poolMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function summarize(cell) {
  const n = cell.runs.length;
  const after2 = cell.runs.map((r) => r.score);
  const lat = cell.runs.flatMap((r) => r.turns.map((t) => t.latencyMs));
  const outTok = cell.runs.flatMap((r) => r.turns.map((t) => t.usage?.completion_tokens || 0));
  const inTok = cell.runs.flatMap((r) => r.turns.map((t) => t.usage?.prompt_tokens || 0));
  const keys = cell.runs.flatMap((r) => r.turns.map((t) => t.newFactsKey));
  const nonempty = cell.runs.flatMap((r) => r.turns.map((t) => t.newFactsN > 0));
  const count = (fn) => after2.filter(fn).length;
  return {
    n,
    year1998: pct(count((s) => s.year1998), n),
    nutFree: pct(count((s) => s.nutFree), n),
    delivery: pct(count((s) => s.delivery), n),
    deliveryFull: pct(count((s) => s.delivery && s.delivery3mi && s.delivery40 && s.delivery8), n),
    newFactsKey: pct(keys.filter(Boolean).length, keys.length),
    newFactsNonempty: pct(nonempty.filter(Boolean).length, nonempty.length),
    medianLatencyMs: Math.round(median(lat)),
    medianOutTok: Math.round(median(outTok)),
    medianInTok: Math.round(median(inTok)),
    medianReasoningTok: Math.round(
      median(cell.runs.flatMap((r) => r.turns.map((t) => t.reasoningTokens || 0)))
    ),
    effort: [...new Set(cell.runs.flatMap((r) => r.turns.map((t) => t.reasoningEffort).filter(Boolean)))].join(',') || '—',
    cost: cell.cost,
  };
}

if (ARGS.help) {
  console.log(`Usage: node scripts/replay-builder-capture.js [--models a,b] [--modes legacy,delta] [--runs 12] [--concurrency 2] [--budget 2]`);
  process.exit(0);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing');
  process.exit(1);
}

const jobs = [];
for (const model of MODELS) {
  for (const mode of MODES) {
    for (let run = 1; run <= RUNS; run++) jobs.push({ model, mode, run });
  }
}

console.log(
  `Replay: ${MODELS.join(', ')} × ${MODES.join(', ')} × ${RUNS} runs × 2 turns (${jobs.length} interviews, cap $${BUDGET.toFixed(2)})\n`
);

const cells = new Map();
let spent = 0;
const results = await poolMap(jobs, CONCURRENCY, async (job) => {
  if (spent >= BUDGET) {
    return { job, skipped: true };
  }
  try {
    const { draft, turns } = await oneInterview(job);
    const usageCost = turns.reduce((s, t) => s + costOf(job.model, t.usage), 0);
    spent += usageCost;
    const row = {
      job,
      skipped: false,
      score: scoreDraft(draft),
      cost: usageCost,
      turns: turns.map((t) => ({
        latencyMs: t.latencyMs,
        usage: t.usage,
        newFactsKey: newFactsPresent(t.modelJson, job.mode),
        newFactsN: newFactsCount(t.modelJson, job.mode),
        reasoningEffort: t.reasoningEffort,
        reasoningTokens: t.reasoningTokens,
      })),
    };
    const key = `${job.model} ${job.mode}`;
    if (!cells.has(key)) cells.set(key, { model: job.model, mode: job.mode, runs: [], cost: 0 });
    const cell = cells.get(key);
    cell.runs.push(row);
    cell.cost += usageCost;
    const s = row.score;
    const effort = row.turns.map((t) => t.reasoningEffort || '—').join('/');
    console.log(
      `  ${job.model} ${job.mode} #${job.run}: 1998=${s.year1998} nut=${s.nutFree} deliver=${s.delivery} effort=${effort} $${usageCost.toFixed(4)}`
    );
    return row;
  } catch (err) {
    console.error(`  ${job.model} ${job.mode} #${job.run} ERROR: ${err.message}`);
    return { job, skipped: false, error: err.message };
  }
});

const skipped = results.filter((r) => r.skipped).length;
if (skipped) console.log(`\nStopped early: ${skipped} interviews skipped (budget).`);

console.log('\n## Capture replay\n');
console.log(
  '| Model | Mode | n | 1998 | nut-free | delivery | delivery+terms | newFacts key | newFacts nonempty | effort | median latency | median out tok | median reasoning tok | median in tok | cost |'
);
console.log('|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|');
const printed = new Set();
function printRow(model, mode, s, note = '') {
  printed.add(`${model} ${mode}`);
  const lat = s.medianLatencyMs === '—' ? '—' : `${s.medianLatencyMs}ms`;
  console.log(
    `| ${model} | ${mode}${note} | ${s.n} | ${s.year1998} | ${s.nutFree} | ${s.delivery} | ${s.deliveryFull} | ${s.newFactsKey} | ${s.newFactsNonempty} | ${s.effort} | ${lat} | ${s.medianOutTok} | ${s.medianReasoningTok} | ${s.medianInTok} | $${Number(s.cost).toFixed(3)} |`
  );
}
if (!MODELS.includes('gpt-4.1-mini') && PRIOR_DELTA['gpt-4.1-mini']) {
  printRow('gpt-4.1-mini', 'delta', PRIOR_DELTA['gpt-4.1-mini'], ' (prior)');
}
for (const model of MODELS) {
  for (const mode of MODES) {
    const cell = cells.get(`${model} ${mode}`);
    if (!cell) {
      printRow(model, mode, {
        n: 0,
        year1998: '—',
        nutFree: '—',
        delivery: '—',
        deliveryFull: '—',
        newFactsKey: '—',
        newFactsNonempty: '—',
        effort: '—',
        medianLatencyMs: '—',
        medianOutTok: '—',
        medianReasoningTok: '—',
        medianInTok: '—',
        cost: 0,
      });
      continue;
    }
    printRow(model, mode, summarize(cell));
  }
}
console.log(`\nTotal spent: $${spent.toFixed(3)} (cap $${BUDGET.toFixed(2)})`);
