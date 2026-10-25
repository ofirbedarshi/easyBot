/**
 * Live-model check: Business Bot must not turn a missing fact into a "no",
 * and must still use facts that are present. Scores replies only — no
 * production keyword matching.
 *
 *   node scripts/eval-closed-world-gaps.js --dump-prompts <file>
 *   node scripts/eval-closed-world-gaps.js [--baseline <file>] [--live]
 *
 * Default: compare --baseline (frozen current-prompt strings) vs live
 * buildCustomerSystemPrompt. Models default to gpt-4o-mini / 4.1-mini / 4o.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import {
  cachedChatCompletionShape,
  createChatCompletion,
  reasoningTokensFromUsage,
} from '../src/openaiChat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CAP_USD = 1.0;
const RUNS = 3;
const CONCURRENCY = 2;

const PRICES = {
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-6-sol': { input: 2, output: 10 },
  'gpt-6-luna': { input: 0.1, output: 0.5 },
};
const MODELS = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'];

const BASE = {
  name: "Rosa's Bakery",
  whatWeDo: 'Family bakery in Portland, famous for sourdough and custom cakes',
  ownerGoal: 'answer_questions',
  services: [
    { name: 'Sourdough loaf', price: '$9', notes: null },
    { name: 'Croissant', price: '$4.50', notes: null },
    { name: 'Custom cake', price: 'from $65', notes: '5 days notice' },
  ],
  hours: 'Tue–Sun 7am–3pm, closed Monday',
  locationOrArea: 'Portland, Oregon',
  commonQuestions: [
    {
      question: 'Do you have gluten-free?',
      answer: "No, we can't guarantee gluten-free. Wheat is everywhere in the kitchen.",
    },
  ],
  informationToCollect: [],
  unknowns: [],
  otherFacts: [],
  tone: 'warm',
};

const PROFILES = {
  base: BASE,
  delivery: {
    ...BASE,
    otherFacts: [
      'We deliver only within 3 miles for orders over $40, delivery fee $8.',
    ],
  },
  milkEggs: {
    ...BASE,
    otherFacts: ['We use milk and eggs.'],
  },
  vegan: {
    ...BASE,
    otherFacts: ['We have vegan muffins.'],
  },
};

const SCORE_BY_ID = {
  missing_delivery: scoreMissingDelivery,
  missing_vegan: scoreMissingVegan,
  overstate_vegan: scoreOverstateVegan,
  has_delivery: scoreHasDelivery,
  has_vegan: scoreHasVegan,
  has_price: scoreHasPrice,
  has_gluten_faq: scoreHasGlutenFaq,
};

const CASES = [
  {
    id: 'missing_delivery',
    group: 'gap',
    profile: 'base',
    question: 'Do you deliver?',
    score: scoreMissingDelivery,
  },
  {
    id: 'missing_vegan',
    group: 'gap',
    profile: 'base',
    question: 'Do you have vegan options?',
    score: scoreMissingVegan,
  },
  {
    id: 'overstate_vegan',
    group: 'gap',
    profile: 'milkEggs',
    question: 'Do you have vegan options?',
    score: scoreOverstateVegan,
  },
  {
    id: 'has_delivery',
    group: 'facts',
    profile: 'delivery',
    question: 'I want 5 sourdough loaves, that is $45. I live 2 miles away. Can you deliver?',
    score: scoreHasDelivery,
  },
  {
    id: 'has_vegan',
    group: 'facts',
    profile: 'vegan',
    question: 'Do you have vegan options?',
    score: scoreHasVegan,
  },
  {
    id: 'has_price',
    group: 'facts',
    profile: 'base',
    question: 'How much is a sourdough loaf?',
    score: scoreHasPrice,
  },
  {
    id: 'has_gluten_faq',
    group: 'facts',
    profile: 'base',
    question: 'Do you have gluten-free?',
    score: scoreHasGlutenFaq,
  },
];

function isListedGap(text) {
  return /not (listed|mentioned)|don'?t (have|mention) .{0,50}(listed|mentioned)|no .{0,24}(listed|mentioned)|don'?t have (information|details|info)\b|do not have (information|details|info)\b|can'?t confirm|cannot confirm|approved facts don'?t|don'?t have .{0,24}information/i.test(
    text
  );
}

function deniesDelivery(text) {
  if (isListedGap(text)) return false;
  return /does not offer delivery|don'?t offer delivery|do not offer delivery|no delivery|we don'?t deliver|we do not deliver|cannot deliver|can'?t deliver|delivery is not|not able to deliver|don'?t (do|provide) delivery|we('re| are) not (set up to )?deliver/i.test(
    text
  );
}

function deniesVegan(text) {
  if (isListedGap(text) && !/available|as we use|so we (don'?t|do not|can'?t)/i.test(text)) {
    return false;
  }
  return /no vegan|don'?t (have|offer) vegan|do not (have|offer) vegan|aren'?t vegan|we do not have vegan|not vegan|no\b[^.!?]{0,40}vegan option/i.test(
    text
  );
}

function isUnknownGap(text) {
  return (
    isListedGap(text) ||
    /don'?t know|do not know|not sure|i('m| am) not (sure|certain)|check with (the )?owner|ask (the )?owner|message (the )?owner|don'?t have that|do not have that|no (approved )?information|haven'?t been told|i('ll| will) (check|ask)/i.test(
      text
    )
  );
}

function scoreMissingDelivery(text) {
  if (deniesDelivery(text)) return { pass: false, tag: 'false_no' };
  if (isUnknownGap(text)) return { pass: true, tag: 'unknown' };
  return { pass: false, tag: 'unclear' };
}

function scoreMissingVegan(text) {
  const transfer = /wheat|gluten/i.test(text);
  if (deniesVegan(text)) {
    return { pass: false, tag: transfer ? 'false_no_transfer' : 'false_no' };
  }
  if (transfer) return { pass: false, tag: 'transfer' };
  if (isUnknownGap(text)) return { pass: true, tag: 'unknown' };
  return { pass: false, tag: 'unclear' };
}

function scoreOverstateVegan(text) {
  const milkEggs = /milk/i.test(text) && /eggs?/i.test(text);
  if (deniesVegan(text)) return { pass: false, tag: 'overstate_no' };
  if (!milkEggs) return { pass: false, tag: milkEggs ? 'unclear' : 'withheld_fact' };
  return { pass: true, tag: 'restated' };
}

function scoreHasDelivery(text) {
  if (deniesDelivery(text)) return { pass: false, tag: 'false_no' };
  const conditions =
    /3 miles/i.test(text) ||
    /\$?40\b/.test(text) ||
    /\$?8\b/.test(text);
  if (conditions) return { pass: true, tag: 'stated' };
  if (isUnknownGap(text)) return { pass: false, tag: 'withheld_fact' };
  return { pass: false, tag: 'unclear' };
}

function scoreHasVegan(text) {
  if (deniesVegan(text)) return { pass: false, tag: 'false_no' };
  if (/vegan muffins?/i.test(text)) return { pass: true, tag: 'stated' };
  if (isUnknownGap(text)) return { pass: false, tag: 'withheld_fact' };
  return { pass: false, tag: 'unclear' };
}

function scoreHasPrice(text) {
  if (/\$9\b|\b9 dollars\b/i.test(text)) return { pass: true, tag: 'stated' };
  if (isUnknownGap(text)) return { pass: false, tag: 'withheld_fact' };
  return { pass: false, tag: 'unclear' };
}

function scoreHasGlutenFaq(text) {
  if (/can'?t guarantee|cannot guarantee|wheat is everywhere/i.test(text)) {
    return { pass: true, tag: 'stated' };
  }
  if (isUnknownGap(text)) return { pass: false, tag: 'withheld_fact' };
  return { pass: false, tag: 'unclear' };
}

function parseArgs(argv) {
  const args = {
    dump: null,
    baseline: null,
    live: false,
    models: MODELS,
    rescore: null,
    cap: DEFAULT_CAP_USD,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dump-prompts') args.dump = argv[++i];
    else if (a === '--baseline') args.baseline = argv[++i];
    else if (a === '--live') args.live = true;
    else if (a === '--models') args.models = argv[++i].split(',');
    else if (a === '--rescore') args.rescore = argv[++i];
    else if (a === '--cap') args.cap = Number(argv[++i]);
  }
  if (args.rescore) return args;
  if (!args.dump && !args.baseline && !args.live) {
    args.baseline = path.join(
      __dirname,
      'fixtures',
      'closed-world-baseline-prompts.json'
    );
    args.live = true;
  }
  return args;
}

function builtPrompts() {
  const out = {};
  for (const [id, profile] of Object.entries(PROFILES)) {
    out[id] = buildCustomerSystemPrompt(profile);
  }
  return out;
}

function costUsd(model, promptTokens, completionTokens) {
  const p = PRICES[model];
  if (!p) return 0;
  return (promptTokens * p.input + completionTokens * p.output) / 1_000_000;
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function promptVariants(args) {
  const variants = [];
  if (args.baseline) {
    const raw = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
    variants.push({ name: 'current', prompts: raw.prompts || raw });
  }
  if (args.live) {
    variants.push({ name: 'reworded', prompts: builtPrompts() });
  }
  return variants;
}

function jobsFor(args) {
  const jobs = [];
  for (const variant of promptVariants(args)) {
    for (const model of args.models) {
      for (const c of CASES) {
        const system = variant.prompts[c.profile];
        if (!system) throw new Error(`missing prompt for profile ${c.profile} (${variant.name})`);
        for (let run = 1; run <= RUNS; run += 1) {
          jobs.push({ variant: variant.name, model, caseId: c.id, run, system, case: c });
        }
      }
    }
  }
  return jobs;
}

function summarize(rows, spend) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.variant}\t${row.model}`;
    if (!groups.has(key)) {
      groups.set(key, {
        variant: row.variant,
        model: row.model,
        gap: [],
        facts: [],
        latencies: [],
        costs: [],
        byCase: {},
      });
    }
    const g = groups.get(key);
    g.latencies.push(row.ms);
    g.costs.push(row.usd);
    if (!g.byCase[row.caseId]) g.byCase[row.caseId] = [];
    g.byCase[row.caseId].push(row);
    if (row.group === 'gap') g.gap.push(row);
    else g.facts.push(row);
  }

  const lines = [];
  lines.push('variant\tmodel\tgap_fails\tfacts_ok\tmedian_ms\t$/reply\teffort\treasoning_tok_med\tgap_fail_cases');
  for (const g of groups.values()) {
    const falseNo = g.gap.filter((r) => !r.pass).length;
    const factsOk = g.facts.filter((r) => r.pass).length;
    const failedCases = [
      ...new Set(g.gap.filter((r) => !r.pass).map((r) => r.caseId)),
    ];
    const efforts = [
      ...new Set(g.gap.concat(g.facts).map((r) => r.effort).filter(Boolean)),
    ];
    const reasoning = g.gap.concat(g.facts).map((r) => r.reasoningTokens || 0);
    lines.push(
      [
        g.variant,
        g.model,
        `${falseNo}/${g.gap.length}`,
        `${factsOk}/${g.facts.length}`,
        Math.round(median(g.latencies)),
        (median(g.costs) || 0).toFixed(5),
        efforts.join(',') || 'n/a',
        String(Math.round(median(reasoning))),
        failedCases.join(',') || 'none',
      ].join('\t')
    );
  }
  lines.push('');
  lines.push(`spend_usd\t${spend.toFixed(4)}`);
  lines.push('');
  lines.push('case\tvariant\tmodel\tpass\ttag\tms\treply');
  for (const row of rows) {
    const reply = (row.reply || '').replace(/\s+/g, ' ').slice(0, 180);
    lines.push(
      [row.caseId, row.variant, row.model, row.pass ? 'PASS' : 'FAIL', row.tag, row.ms, reply].join(
        '\t'
      )
    );
  }
  return { text: lines.join('\n'), groups };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rescore) {
    const payload = JSON.parse(fs.readFileSync(args.rescore, 'utf8'));
    const rows = (payload.rows || []).map((row) => {
      const fn = SCORE_BY_ID[row.caseId];
      if (!fn || !row.reply) return row;
      const scored = fn(row.reply);
      return { ...row, pass: scored.pass, tag: scored.tag };
    });
    const { text } = summarize(rows, payload.spend || 0);
    console.log(text);
    return;
  }

  if (args.dump) {
    const payload = {
      capturedAt: new Date().toISOString(),
      prompts: builtPrompts(),
    };
    fs.mkdirSync(path.dirname(args.dump), { recursive: true });
    fs.writeFileSync(args.dump, JSON.stringify(payload, null, 2));
    console.log(`dumped ${Object.keys(payload.prompts).length} prompts to ${args.dump}`);
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const jobs = jobsFor(args);
  let spend = 0;
  const cap = Number(args.cap) || DEFAULT_CAP_USD;
  const runJob = async (job) => {
    if (spend >= cap) {
      return {
        ...job,
        group: job.case.group,
        pass: false,
        tag: 'skipped_cap',
        ms: 0,
        usd: 0,
        effort: '',
        reasoningTokens: 0,
        reply: '',
      };
    }
    const t0 = Date.now();
    const { completion, request } = await createChatCompletion(client, {
      model: job.model,
      messages: [
        { role: 'system', content: job.system },
        { role: 'user', content: job.case.question },
      ],
    });
    const ms = Date.now() - t0;
    const reply = (completion.choices?.[0]?.message?.content || '').trim();
    const usage = completion.usage || {};
    const reasoningTokens = reasoningTokensFromUsage(usage);
    const usd = costUsd(
      job.model,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0
    );
    spend += usd;
    const scored = job.case.score(reply);
    const shape = cachedChatCompletionShape(job.model) || {};
    return {
      variant: job.variant,
      model: job.model,
      caseId: job.case.id,
      group: job.case.group,
      run: job.run,
      pass: scored.pass,
      tag: scored.tag,
      ms,
      usd,
      effort: request.reasoning_effort || shape.reasoning_effort || (request.temperature === 0 ? 'temp0' : ''),
      reasoningTokens,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      reply,
    };
  };
  const rows = [];
  const byModel = new Map();
  for (const job of jobs) {
    if (!byModel.has(job.model)) byModel.set(job.model, []);
    byModel.get(job.model).push(job);
  }
  for (const modelJobs of byModel.values()) {
    rows.push(...(await mapPool(modelJobs, CONCURRENCY, runJob)));
  }

  const { text, groups } = summarize(rows, spend);
  const outDir = path.join(__dirname, '..', 'data', 'test-results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `closed-world-gaps-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify({ spend, rows }, null, 2));
  console.log(text);
  console.log(`\nwrote ${jsonPath}`);

  const liveMini = [...groups.values()].find(
    (g) => g.variant === 'reworded' && g.model === 'gpt-4o-mini'
  );
  if (liveMini) {
    const falseNo = liveMini.gap.filter((r) => !r.pass).length;
    const factsOk = liveMini.facts.filter((r) => r.pass).length;
    if (falseNo === 0 && factsOk === liveMini.facts.length) {
      console.log('\nPASS bar: gpt-4o-mini reworded 0 false-no and all facts-present ok');
    } else {
      console.log(
        `\nPASS bar missed: gpt-4o-mini reworded false-no ${falseNo}/${liveMini.gap.length}, facts ${factsOk}/${liveMini.facts.length}`
      );
      process.exitCode = 2;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
