#!/usr/bin/env node
/**
 * Opt-in Builder correction replay (real OpenAI, costs money).
 *
 * Two interviews against the production Builder:
 *   1. Salon-style: five prices, then correct one and add exclusions
 *   2. Generic: offerings + served / not-served areas, then correct one price
 *
 * Usage:
 *   OPENAI_BUILDER_MODEL=gpt-6-luna node scripts/replay-builder-corrections.js
 *   node scripts/replay-builder-corrections.js --model gpt-6-luna --runs 1
 *   node scripts/replay-builder-corrections.js --scenario generic-areas --runs 3
 *
 * Not part of the default test suite.
 */
import 'dotenv/config';
import { applyReviewGate, openingMessage, runBuilderTurn } from '../src/builder.js';
import { topicJustAsked } from '../src/builderTopics.js';
import { businessBotReply } from '../src/businessBot.js';
import { renderReview } from '../src/ownerNav.js';
import { emptyProfile, mergeDraft } from '../src/profile.js';

const ARGS = parseArgs(process.argv.slice(2));
const MODEL = ARGS.model || process.env.OPENAI_BUILDER_MODEL || 'gpt-6-luna';
const RUNS = ARGS.runs ?? 1;
const BUDGET = ARGS.budget ?? 0.5;

const PRICES = {
  'gpt-6-luna': { in: 0.1, out: 0.5 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
};

const SALON = {
  id: 'salon-correction',
  messages: [
    'hair salon in columbus ohio',
    'Scissors and Sage Salon',
    'answer questions and take messages when people want to book',
    'yes - name, phone, preferred time',
    'mostly prices. womens cut 45, mens 28, kids under 10 are 25. blowout 35. long or thick hair is 15 extra.',
    'dollars',
    'open tue-sat 9 to 6, closed sunday and monday. weekdays by appointment, saturdays walk-ins are fine',
    'wait, mens cut is 30 not 28. also: no nails, no braids or extensions, no chemical straightening. color only after a free 15 min consultation, never quote color prices in chat. cancel policy is 24h notice',
    'show me the updated summary',
  ],
  afterCorrectionFrom: 7,
  scoreDraft(draft) {
    const services = Array.isArray(draft.services) ? draft.services : [];
    const blob = flattenDraft(draft).toLowerCase();
    const womens = services.find((s) => /women/i.test(s?.name || ''));
    const mens = services.find((s) => /men/i.test(s?.name || '') && !/women/i.test(s?.name || ''));
    const kids = services.find((s) => /kid|child/i.test(s?.name || ''));
    const blowout = services.find((s) => /blow/i.test(s?.name || ''));
    return {
      womens45: !!(womens && /45/.test(String(womens.price || ''))),
      mens30: !!(mens && /30/.test(String(mens.price || ''))),
      mensNot28: !(mens && /28/.test(String(mens.price || ''))),
      kidsKept: !!(kids && /25/.test(String(kids.price || ''))),
      blowoutKept: !!(blowout && /35/.test(String(blowout.price || ''))),
      noNails: /nail/i.test(blob),
      colorPolicy:
        /color/i.test(blob) &&
        /consult/i.test(blob) &&
        /(price|quote|chat)/i.test(blob),
      serviceCount: services.length,
    };
  },
  customerQuestions: [
    { q: 'how much is a womens haircut?', must: [/45/], deny: /i don'?t know/i },
    { q: 'do you also do gel manicures?', must: [/nail|manicur/i], deny: /i don'?t know/i },
    {
      q: 'how much would it be to color my whole head?',
      must: [/consult/i],
      deny: /i don'?t know the price|message the owner/i,
    },
  ],
};

const GENERIC = {
  id: 'generic-areas',
  messages: [
    'home repair business in dayton ohio',
    'Oak Street Repair',
    'answer customer questions',
    'none',
    'plumbing service call 89, electrical 110, carpentry 75. we work dayton and kettering. we do not serve huber heights or springfield.',
    'wait, plumbing is 95 not 89. also we do not offer roofing.',
    'show me the updated summary',
  ],
  afterCorrectionFrom: 5,
  scoreDraft(draft) {
    const services = Array.isArray(draft.services) ? draft.services : [];
    const blob = flattenDraft(draft).toLowerCase();
    const plumbing = services.find((s) => /plumb/i.test(s?.name || ''));
    const electrical = services.find((s) => /electr/i.test(s?.name || ''));
    const carpentry = services.find((s) => /carp/i.test(s?.name || ''));
    return {
      plumbing95: !!(plumbing && /95/.test(String(plumbing.price || ''))),
      electricalKept: !!(electrical && /110/.test(String(electrical.price || ''))),
      carpentryKept: !!(carpentry && /75/.test(String(carpentry.price || ''))),
      notHuber: /huber/i.test(blob),
      notSpringfield: /springfield/i.test(blob),
      noRoofing: /roof/i.test(blob),
      serviceCount: services.length,
    };
  },
  customerQuestions: [
    { q: 'do you serve huber heights?', must: [/huber/i], deny: /i don'?t know/i },
    { q: 'can you do a roof repair?', must: [/roof/i], deny: /i don'?t know/i },
    { q: 'how much is electrical?', must: [/110/], deny: /i don'?t know/i },
  ],
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i];
    else if (a === '--runs') out.runs = Number(argv[++i]);
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--scenario') {
      out.scenario = String(argv[++i] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === '--help') out.help = true;
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

function costOf(model, usage) {
  const p = PRICES[model] || PRICES['gpt-4o-mini'];
  const input = usage?.prompt_tokens || 0;
  const output = usage?.completion_tokens || 0;
  return (input * p.in + output * p.out) / 1e6;
}

function yes(v) {
  return v ? 'yes' : 'NO';
}

async function runInterview(scenario, model) {
  const profile = emptyProfile();
  const buildHistory = [{ role: 'assistant', content: openingMessage().message, nav: null }];
  const turns = [];
  let spent = 0;
  let draftAfterCorrection = null;
  let reviewAfterCorrection = null;

  for (let i = 0; i < scenario.messages.length; i++) {
    const userMessage = scenario.messages[i];
    const raw = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage,
      model,
    });
    spent += costOf(model, raw.usage);
    const turn = applyReviewGate(profile, raw, userMessage, {
      justAsked: topicJustAsked(buildHistory),
    });
    profile.draft = turn.draft;
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
    turns.push({
      userMessage,
      message: turn.message,
      readyForReview: turn.readyForReview,
      presentReview: turn.presentReview,
      usage: raw.usage,
      latencyMs: raw.latencyMs,
      newFacts: raw.modelJson?.newFacts,
      ownerEdits: raw.modelJson?.ownerEdits,
      configRequests: raw.configRequests,
      rawLocationOrArea: raw.modelJson?.draft?.locationOrArea ?? null,
      storedLocationOrArea: turn.draft?.locationOrArea ?? null,
      storedOtherFacts: turn.draft?.otherFacts ?? [],
    });
    const rawArea = raw.modelJson?.draft?.locationOrArea ?? null;
    const storedArea = turn.draft?.locationOrArea ?? null;
    console.log(
      `  t${i} newFacts=${JSON.stringify(raw.modelJson?.newFacts)} ownerEdits=${JSON.stringify(raw.modelJson?.ownerEdits)} rawArea=${JSON.stringify(rawArea)} storedArea=${JSON.stringify(storedArea)} otherFacts=${JSON.stringify(turn.draft?.otherFacts || [])}`
    );
    if (i === scenario.afterCorrectionFrom) {
      console.log('  correction-turn message:', String(turn.message).replace(/\s+/g, ' ').slice(0, 280));
      console.log('  correction-turn configRequests:', JSON.stringify(raw.configRequests));
      console.log('  correction-turn delta.services:', JSON.stringify(raw.modelJson?.draft?.services));
    }
    if (i >= scenario.afterCorrectionFrom && !draftAfterCorrection) {
      draftAfterCorrection = structuredClone(turn.draft);
      reviewAfterCorrection = renderReview({ ...profile, draft: turn.draft });
    }
  }

  const draft = profile.draft;
  const score = scenario.scoreDraft(draft);
  const correctionTurn = turns[scenario.afterCorrectionFrom];
  if (correctionTurn && 'colorPolicy' in score) {
    score.didNotRefuseConfig = !/can'?t configure|cannot configure|i can'?t (set|configure)/i.test(
      correctionTurn.message || ''
    );
  }
  const review = renderReview({ ...profile, draft });
  return {
    profile,
    draft,
    score,
    review,
    draftAfterCorrection,
    reviewAfterCorrection,
    turns,
    spent,
  };
}

function approve(profile) {
  const merged = mergeDraft(profile, profile.draft);
  Object.assign(profile, merged);
  profile.approvedAt = new Date().toISOString();
  return profile;
}

async function askCustomer(profile, questions) {
  const out = [];
  let spent = 0;
  let history = [];
  for (const { q, must, deny } of questions) {
    const answer = await businessBotReply({ profile, history, question: q });
    spent += 0.002;
    history = [
      ...history,
      { role: 'user', content: q },
      { role: 'assistant', content: answer },
    ];
    const ok = must.every((re) => re.test(answer)) && !(deny && deny.test(answer));
    out.push({ q, answer, ok });
  }
  return { answers: out, spent };
}

function printScore(label, score) {
  console.log(`  ${label}:`);
  for (const [k, v] of Object.entries(score)) {
    if (typeof v === 'boolean') console.log(`    ${k}: ${yes(v)}`);
    else console.log(`    ${k}: ${v}`);
  }
}

if (ARGS.help) {
  console.log(
    'Usage: node scripts/replay-builder-corrections.js [--model gpt-6-luna] [--runs 1] [--budget 0.5] [--scenario salon-correction,generic-areas]'
  );
  process.exit(0);
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing');
  process.exit(1);
}

console.log(`Correction replay: model=${MODEL} runs=${RUNS} cap $${BUDGET.toFixed(2)}\n`);

let spent = 0;
let failed = 0;
const summaries = [];

const SCENARIOS = [SALON, GENERIC].filter((s) => {
  if (!ARGS.scenario?.length) return true;
  return ARGS.scenario.includes(s.id);
});
if (ARGS.scenario?.length && !SCENARIOS.length) {
  console.error(`No matching --scenario. Known: ${[SALON, GENERIC].map((s) => s.id).join(', ')}`);
  process.exit(1);
}

for (const scenario of SCENARIOS) {
  for (let run = 1; run <= RUNS; run++) {
    if (spent >= BUDGET) {
      console.log(`Stopped before ${scenario.id} #${run} (budget).`);
      failed += 1;
      continue;
    }
    console.log(`=== ${scenario.id} #${run} ===`);
    try {
      const result = await runInterview(scenario, MODEL);
      spent += result.spent;
      printScore('draft after interview', result.score);
      console.log('  services:', JSON.stringify(result.draft.services));
      console.log('  locationOrArea:', result.draft.locationOrArea);
      console.log('  otherFacts:', JSON.stringify(result.draft.otherFacts));
      console.log('  commonQuestions:', JSON.stringify(result.draft.commonQuestions));
      console.log('  review services line:');
      const svcLine = String(result.review)
        .split('\n')
        .find((l) => l.startsWith('Services:'));
      console.log(`    ${svcLine || '(none)'}`);
      if (result.reviewAfterCorrection && result.reviewAfterCorrection !== result.review) {
        const earlier = String(result.reviewAfterCorrection)
          .split('\n')
          .find((l) => l.startsWith('Services:'));
        if (earlier) console.log(`  review services line (first post-correction): ${earlier}`);
      }

      const live = approve({ ...result.profile, draft: result.draft });
      const customer = await askCustomer(live, scenario.customerQuestions);
      spent += customer.spent;
      for (const a of customer.answers) {
        console.log(`  customer Q: ${a.q}`);
        console.log(`    A: ${a.answer.replace(/\s+/g, ' ').slice(0, 240)}`);
        console.log(`    cite-ok: ${yes(a.ok)}`);
      }
      const draftOk = Object.entries(result.score)
        .filter(([, v]) => typeof v === 'boolean')
        .every(([, v]) => v);
      const customerOk = customer.answers.every((a) => a.ok);
      if (!draftOk || !customerOk) failed += 1;
      summaries.push({
        id: scenario.id,
        run,
        score: result.score,
        draftOk,
        customerOk,
        spent: result.spent + customer.spent,
      });
      console.log(`  $${(result.spent + customer.spent).toFixed(4)}\n`);
    } catch (err) {
      failed += 1;
      console.error(`  ERROR: ${err.message}\n`);
      summaries.push({ id: scenario.id, run, error: err.message });
    }
  }
}

console.log('## Correction replay summary\n');
for (const s of summaries) {
  if (s.error) {
    console.log(`- ${s.id} #${s.run}: ERROR ${s.error}`);
    continue;
  }
  console.log(
    `- ${s.id} #${s.run}: draft=${s.draftOk ? 'PASS' : 'FAIL'} customer=${s.customerOk ? 'PASS' : 'FAIL'} $${s.spent.toFixed(4)} ${JSON.stringify(s.score)}`
  );
}
console.log(`\nTotal spent: $${spent.toFixed(3)} (cap $${BUDGET.toFixed(2)})`);
process.exit(failed ? 1 : 0);
