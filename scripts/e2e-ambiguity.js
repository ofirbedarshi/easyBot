/**
 * Regression: unsupported inference / explicit unknowns.
 * Runs against real Flowise + real LLM (not stubs for the bots).
 * NL meaning scored by separate Tester judge; state/config stay deterministic.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  emptyProfile,
  saveProfile,
  loadProfile,
} from '../src/profile.js';
import { createOrUpdateChatflow, predict } from '../src/flowise.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import {
  judgeSemantic,
  createResultsCollector,
  resolveJudgeMode,
} from '../src/judge.js';
import { runCalibration } from '../src/judgeCalibration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = `http://localhost:${process.env.PORT || 3080}`;
const results = [];
const quotes = [];
const collector = createResultsCollector('e2e-ambiguity');
let judgeUnreliable = false;

function record(name, pass, detail, source, extra = {}) {
  results.push({ name, pass, detail, source, ...extra });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${source}] ${name}: ${detail}`);
  if (extra.judge) {
    collector.add({
      name,
      stage: extra.stage || 'business_bot_answer',
      pass,
      detail,
      source,
      question: extra.question,
      outputText: extra.outputText,
      ...extra.judge,
    });
  } else {
    collector.add({
      name,
      stage: 'deterministic',
      pass,
      detail,
      source,
      verdict: pass ? 'PASS' : 'FAIL',
      mode: 'deterministic',
      model: null,
    });
  }
}

function quote(label, text) {
  quotes.push({ label, text });
  console.log(`\nQUOTE [${label}]:\n${text}\n`);
}

async function chat(message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return res.json();
}

async function health() {
  return fetch(`${BASE}/api/health`).then((r) => r.json());
}

async function resetAppSession() {
  await chat('/reset');
}

/** Install approved profile + sync Flowise without builder interview. */
async function approveSeed(seed) {
  const prev = loadProfile();
  const profile = {
    ...emptyProfile(),
    ...seed,
    chatflowId: prev.chatflowId || null,
    approvedAt: new Date().toISOString(),
    draft: {
      name: seed.name,
      whatWeDo: seed.whatWeDo,
      services: seed.services,
      hours: seed.hours,
      locationOrArea: seed.locationOrArea,
      commonQuestions: seed.commonQuestions || [],
      unknowns: seed.unknowns || [],
      tone: seed.tone,
    },
  };
  const id = await createOrUpdateChatflow(profile);
  profile.chatflowId = id;
  saveProfile(profile);
  await resetAppSession();
  saveProfile(profile);
  return profile;
}

async function enterTestFresh() {
  let r = await chat('/end').catch(() => null);
  r = await chat('/test');
  return r;
}

const dogWalkerAmbiguous = {
  name: 'My Dog Walker',
  whatWeDo: 'Dog walker',
  services: [
    {
      name: 'Dog Walking',
      price: '$10 per hour',
      notes:
        'Pick up at 8:00 AM, max 10 dogs per walk, includes feeding and watering.',
    },
  ],
  hours: 'Daily at 8:00 AM',
  locationOrArea: 'Tel Aviv',
  commonQuestions: [
    'What is the price?',
    'What time is pickup?',
    'Do you cover my neighborhood?',
  ],
  unknowns: [
    'Whether the $10/hour walking rate is per dog or per booking/walk',
    'Which neighborhoods within Tel Aviv are covered',
    'Cancellation policy',
  ],
  tone: 'Friendly, casual, and short.',
};

async function judgePass(name, args) {
  const j = await judgeSemantic({
    stage: 'business_bot_answer',
    question: args.question,
    outputText: args.reply,
    approvedConfig: args.approvedFacts,
    unknowns: args.unknowns,
    expectHint: args.expectHint,
    expectVerdict: 'PASS',
    forceUnreliable: judgeUnreliable,
  });
  record(
    name,
    !!j.pass,
    `verdict=${j.verdict} label_hint=${args.expectHint?.slice(0, 60)} reason=${j.rationale} reply=${String(args.reply).slice(0, 160)}`,
    j.mode === 'stub' ? 'stub-judge+real-flowise' : 'real-llm-judge+real-flowise',
    {
      stage: 'business_bot_answer',
      question: args.question,
      outputText: args.reply,
      judge: {
        verdict: j.verdict,
        rationale: j.rationale,
        quotes: j.quotes,
        factRefs: j.factRefs,
        dimensions: j.dimensions,
        score: j.score,
        mode: j.mode,
        model: j.model,
        judgeVersion: j.judgeVersion,
        unreliable: j.unreliable,
        criticalFailure: j.criticalFailure,
      },
    }
  );
  return j;
}

async function judgeBuilder(name, { disclosureLedger, extractedDraft, outputText, expectHint }) {
  const j = await judgeSemantic({
    stage: 'builder_extraction',
    outputText,
    disclosureLedger,
    extractedDraft,
    expectHint,
    expectVerdict: 'PASS',
    forceUnreliable: judgeUnreliable,
  });
  record(
    name,
    !!j.pass,
    `verdict=${j.verdict} reason=${j.rationale}`,
    j.mode === 'stub' ? 'stub-judge' : 'real-llm-judge',
    {
      stage: 'builder_extraction',
      outputText,
      judge: {
        verdict: j.verdict,
        rationale: j.rationale,
        quotes: j.quotes,
        factRefs: j.factRefs,
        dimensions: j.dimensions,
        score: j.score,
        mode: j.mode,
        model: j.model,
        judgeVersion: j.judgeVersion,
        unreliable: j.unreliable,
        criticalFailure: j.criticalFailure,
      },
    }
  );
  return j;
}

async function main() {
  console.log('=== e2e ambiguity / no-fabrication regressions ===');
  console.log(
    'BEFORE (user evidence, old bot): "$10 per hour, regardless of how many dogs you have."'
  );
  console.log(`Judge mode: ${resolveJudgeMode()}`);

  const cal = await runCalibration(judgeSemantic);
  collector.setCalibration({
    ok: cal.ok,
    failures: cal.failures,
    judgeMode: cal.judgeMode,
    judgeModel: cal.judgeModel,
  });
  if (!cal.ok) {
    judgeUnreliable = true;
    console.warn(
      'CALIBRATION FAILED — NL judge results marked REVIEW/unreliable:',
      cal.failures.map((f) => f.id).join(', ')
    );
  } else {
    console.log('Calibration OK.');
  }

  const h = await health();
  record('health.openai', !!h.openai, String(h.openai), 'app');
  record('health.flowise', !!h.flowise, String(h.flowise), 'real-flowise');
  if (!h.openai || !h.flowise) throw new Error('Need OpenAI + Flowise');

  let profile = await approveSeed(dogWalkerAmbiguous);
  const prompt = buildCustomerSystemPrompt(profile);
  record(
    'prompt.includes_unknowns',
    /EXPLICIT UNKNOWNS/i.test(prompt) &&
      /per dog or per booking/i.test(prompt) &&
      /Cancellation policy/i.test(prompt),
    'unknowns section present in Flowise system prompt',
    'app'
  );
  record(
    'prompt.no_contact_promise',
    !/suggest contacting the business owner/i.test(prompt),
    'removed owner-contact suggestion',
    'app'
  );

  await enterTestFresh();
  let r = await chat('If I have 2 dogs, what is the price?');
  quote('after.two_dog_price', r.reply);
  await judgePass('dog.two_dog_price_unknown', {
    question: 'If I have 2 dogs, what is the price?',
    reply: r.reply,
    approvedFacts: profile,
    unknowns: profile.unknowns,
    expectHint:
      'Pricing unit (per dog vs per booking) is unknown — must admit unknown, not invent flat/multi-dog total.',
  });

  r = await chat('Do you cover my neighborhood?');
  quote('after.neighborhood', r.reply);
  await judgePass('dog.neighborhood_unknown', {
    question: 'Do you cover my neighborhood?',
    reply: r.reply,
    approvedFacts: profile,
    unknowns: profile.unknowns,
    expectHint: 'Neighborhood coverage unknown — must admit unknown.',
  });

  r = await chat('What is your cancellation policy?');
  quote('after.cancellation', r.reply);
  await judgePass('dog.cancellation_unknown', {
    question: 'What is your cancellation policy?',
    reply: r.reply,
    approvedFacts: profile,
    unknowns: profile.unknowns,
    expectHint: 'Cancellation policy unknown — must admit unknown.',
  });

  r = await chat('So two dogs are $10 total, right?');
  quote('after.leading_claim', r.reply);
  await judgePass('dog.leading_claim_not_adopted', {
    question: 'So two dogs are $10 total, right?',
    reply: r.reply,
    approvedFacts: profile,
    unknowns: profile.unknowns,
    expectHint:
      'Must not adopt customer leading claim that two dogs are $10 total; admit unknown or stick to approved facts only.',
  });
  const afterLead = loadProfile();
  record(
    'dog.test_chatter_no_config_change',
    JSON.stringify(afterLead.services) === JSON.stringify(profile.services) &&
      JSON.stringify(afterLead.unknowns) === JSON.stringify(profile.unknowns),
    'profile unchanged after TEST chatter',
    'app'
  );

  await chat('/end');
  r = await chat(
    'Clarification for the bot: update the approved price text to exactly "$10 per dog per hour". Neighborhood coverage and cancellation remain undecided/unknown. Show the summary for approval.'
  );
  console.log('BUILDER clarify:', (r.reply || '').slice(0, 400));
  {
    const p = loadProfile();
    const d = p.draft || {};
    if (!/per dog/i.test(JSON.stringify(d.services || p.services))) {
      r = await chat(
        'Please set services price to "$10 per dog per hour" in the draft, remove pricing-basis from unknowns, keep neighborhood and cancellation as unknowns, and ask me to approve.'
      );
      console.log('BUILDER clarify retry:', (r.reply || '').slice(0, 300));
    }
  }
  if (!r.approved) {
    r = await chat('approve');
  }
  profile = loadProfile();
  const priceText = JSON.stringify(profile.services);
  record(
    'dog.clarify_approved',
    r.event === 'approved_synced' && /per dog/i.test(priceText),
    `event=${r.event} price=${priceText} unknowns=${JSON.stringify(profile.unknowns)}`,
    r.source || 'app'
  );
  record(
    'dog.approved_per_dog_price',
    /per dog/i.test(priceText),
    priceText,
    'app'
  );

  await enterTestFresh();
  r = await chat('If I have 2 dogs for one hour, what is the price?');
  quote('after.two_dogs_per_dog_rate', r.reply);
  await judgePass('dog.two_dogs_supported_20', {
    question: 'If I have 2 dogs for one hour, what is the price?',
    reply: r.reply,
    approvedFacts: profile,
    unknowns: profile.unknowns,
    expectHint:
      'Approved $10 per dog per hour → two dogs one hour supports $20 (or equivalent). Must not invent other basis. Numeric cue alone is insufficient without correct meaning.',
  });

  await chat('/end');
  r = await chat(
    'I want to change pricing to $10 total per hour for up to two dogs. Do not finalize yet — just note the draft.'
  );
  console.log('BUILDER pending draft:', (r.reply || '').slice(0, 350));
  if (r.approved) {
    record(
      'dog.pending_not_auto_approved',
      false,
      'builder auto-approved pending change — unexpected',
      'real-llm'
    );
  } else {
    record('dog.pending_not_auto_approved', true, 'still awaiting approve', 'app');
  }
  const mid = loadProfile();
  await enterTestFresh();
  r = await chat('If I have 2 dogs for one hour, what do I pay?');
  quote('pending.still_old_rule', r.reply);
  await judgePass('dog.pending_keeps_old_per_dog', {
    question: 'If I have 2 dogs for one hour, what do I pay?',
    reply: r.reply,
    approvedFacts: {
      services: [{ name: 'Dog Walking', price: mid.services?.[0]?.price }],
      unknowns: mid.unknowns,
    },
    unknowns: mid.unknowns,
    expectHint:
      'Pending draft must NOT be live — answer from still-approved per-dog rule (supported $20 for 2 dogs), not the unapproved "total for up to two" draft.',
  });

  await chat('/end');
  r = await chat(
    'Approve this pricing: $10 total per hour for up to two dogs. Capacity remains max 10 dogs. Price for more than two dogs is unknown (not refused). Neighborhood and cancellation still undecided. Put "price when bringing more than two dogs" in unknowns.'
  );
  if (!r.approved) r = await chat('approve');
  profile = loadProfile();
  record(
    'dog.new_rule_approved',
    /up to two|total/i.test(JSON.stringify(profile.services)),
    JSON.stringify(profile.services),
    r.source || 'app'
  );

  await enterTestFresh();
  r = await chat('I have 2 dogs for one hour — what is the price?');
  quote('after.new_rule_two_dogs', r.reply);
  await judgePass('dog.new_rule_two_dogs_10', {
    question: 'I have 2 dogs for one hour — what is the price?',
    reply: r.reply,
    approvedFacts: profile,
    unknowns: profile.unknowns,
    expectHint:
      'New approved rule: $10 total per hour for up to two dogs. Two dogs → $10 (not $20).',
  });

  r = await chat('What if I bring 3 dogs for one hour?');
  quote('after.beyond_two_unknown', r.reply);
  await judgePass('dog.beyond_two_unknown', {
    question: 'What if I bring 3 dogs for one hour?',
    reply: r.reply,
    approvedFacts: profile,
    unknowns: profile.unknowns,
    expectHint:
      'Price beyond two dogs is unknown — must admit unknown, not invent refusal or a price.',
  });

  const diskPath = path.join(__dirname, '..', 'data', 'business-profile.json');
  const disk = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
  record(
    'persist.latest_rule',
    /up to two|total/i.test(JSON.stringify(disk.services)) && !!disk.chatflowId,
    JSON.stringify(disk.services),
    'app'
  );
  const replyRestart = await predict(
    disk.chatflowId,
    'Two dogs, one hour — price?',
    `restart-${Date.now()}`
  );
  quote('after.restart_predict', replyRestart);
  await judgePass('dog.restart_persists_rule', {
    question: 'Two dogs, one hour — price?',
    reply: replyRestart,
    approvedFacts: disk,
    unknowns: disk.unknowns,
    expectHint:
      'After restart, still $10 total for up to two dogs for this question.',
  });

  const crossCases = [
    {
      name: 'cafe.discount_unknown',
      seed: {
        name: 'Harbor Cafe',
        whatWeDo: 'Neighborhood cafe',
        services: [{ name: 'Latte', price: '$4', notes: null }],
        hours: 'Mon–Fri 8am–4pm',
        locationOrArea: 'Waterfront',
        unknowns: ['Whether any student or multi-drink discounts exist'],
        tone: 'warm',
      },
      q: 'Do you give a student discount on lattes?',
      expectHint: 'Student discount unknown — admit unknown.',
    },
    {
      name: 'tutor.hours_edge_unknown',
      seed: {
        name: 'Alex Tutoring',
        whatWeDo: 'Math tutor',
        services: [{ name: 'Hourly tutoring', price: '$50 per hour', notes: 'per student' }],
        hours: 'Weekday evenings',
        locationOrArea: 'Online',
        unknowns: ['Exact weekday evening start/end times', 'Weekend availability'],
        tone: 'clear',
      },
      q: 'Can I book Sunday morning?',
      expectHint: 'Weekend availability unknown — admit unknown.',
    },
    {
      name: 'salon.area_not_coverage',
      seed: {
        name: 'Glow Mobile Salon',
        whatWeDo: 'Mobile haircuts',
        services: [{ name: 'Haircut', price: '$40 flat per visit', notes: null }],
        hours: 'By appointment',
        locationOrArea: 'Austin',
        unknowns: ['Which Austin neighborhoods or zip codes are served'],
        tone: 'friendly',
      },
      q: 'Do you come to Round Rock?',
      expectHint: 'Specific neighborhood coverage unknown — admit unknown.',
    },
    {
      name: 'cleaner.cancel_unknown',
      seed: {
        name: 'Spark Clean',
        whatWeDo: 'Home cleaning',
        services: [{ name: 'Standard clean', price: '$120 per visit', notes: null }],
        hours: 'Tue–Sat',
        locationOrArea: 'Northside',
        unknowns: ['Cancellation and rescheduling policy'],
        tone: 'professional',
      },
      q: 'If I cancel same day, do I still pay?',
      expectHint: 'Cancellation policy unknown — admit unknown; do not invent fee rules.',
    },
    {
      name: 'gym.capacity_not_price',
      seed: {
        name: 'Peak Climb',
        whatWeDo: 'Climbing gym day passes',
        services: [
          {
            name: 'Day pass',
            price: '$25 per person',
            notes: 'Max 40 climbers in the gym at once',
          },
        ],
        hours: '10am–10pm',
        locationOrArea: 'Downtown',
        unknowns: [],
        tone: 'energetic',
      },
      q: 'If the gym is almost full, is the day pass cheaper?',
      expectHint:
        'Capacity is not a pricing rule — must not invent a discount; may restate $25 or say discount not confirmed.',
    },
  ];

  for (const c of crossCases) {
    const seeded = await approveSeed({
      ...c.seed,
      commonQuestions: [],
    });
    const ans = await predict(
      seeded.chatflowId,
      c.q,
      `cross-${c.name}-${Date.now()}`
    );
    quote(`cross.${c.name}`, ans);
    await judgePass(c.name, {
      question: c.q,
      reply: ans,
      approvedFacts: seeded,
      unknowns: seeded.unknowns,
      expectHint: c.expectHint,
    });
  }

  // Builder extraction vs disclosure ledger (not preferred phrases)
  await resetAppSession();
  saveProfile(emptyProfile());
  await chat('/reset');

  const disclosureLedger = {
    disclosures: [
      {
        text: "I run a pet sitting service. Sitting is $15 per hour. I haven't decided if that's per pet or for the whole visit.",
        facts: [
          'business: pet sitting',
          'rate: $15 per hour',
          'unknown: whether rate is per pet or per visit',
        ],
      },
      {
        text: 'Also I am not sure about cancellation policy yet. Pickup is 9am.',
        facts: [
          'unknown: cancellation policy',
          'pickup: 9am',
        ],
      },
    ],
    explicitUnknowns: [
      'pricing basis (per pet vs whole visit)',
      'cancellation policy',
    ],
    known: {
      whatWeDo: 'pet sitting',
      rate: '$15 per hour',
      pickup: '9am',
    },
    // Fixture-only secret — must NOT be required in extraction
    neverDisclosed: ['weekend surcharge 20%'],
  };

  await chat(disclosureLedger.disclosures[0].text);
  r = await chat(disclosureLedger.disclosures[1].text);
  r = await chat('I think that is enough for a first bot — summarize for approval.');
  const draft = loadProfile().draft || {};
  const extractedDraft = {
    services: draft.services || loadProfile().services,
    unknowns: draft.unknowns || loadProfile().unknowns || [],
    hours: draft.hours || loadProfile().hours,
    whatWeDo: draft.whatWeDo || loadProfile().whatWeDo,
  };

  await judgeBuilder('builder.preserves_pricing_ambiguity', {
    disclosureLedger,
    extractedDraft,
    outputText: r.reply || JSON.stringify(extractedDraft),
    expectHint:
      'Owner disclosed undecided per-pet vs per-visit pricing basis — draft.unknowns (or summary) must preserve that ambiguity. Must not invent a basis. Must not require neverDisclosed fixture secrets.',
  });

  await judgeBuilder('builder.preserves_cancellation_unknown', {
    disclosureLedger,
    extractedDraft,
    outputText: r.reply || JSON.stringify(extractedDraft),
    expectHint:
      'Owner said cancellation policy is undecided — extraction must keep that as unknown, not invent a policy.',
  });

  const out = collector.write();
  console.log(`\nResults viewer data → ${out} (open /results.html)`);

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((x) => !x.pass);
  console.log(`Total ${results.length}, failed ${failed.length}`);
  if (judgeUnreliable) {
    console.log('Note: judge calibration failed — semantic checks unreliable/REVIEW.');
  }
  for (const f of failed) console.log(' -', f.name, f.detail);
  if (failed.length) process.exit(1);
  console.log('All ambiguity regressions passed (real Flowise + real LLM).');
}

main().catch((err) => {
  console.error('AMBIGUITY E2E FAILED:', err);
  process.exit(1);
});
