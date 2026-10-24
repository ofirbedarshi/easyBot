/**
 * Focused closed-world Business Bot regressions (seeded profiles only).
 * Reuses Flowise predict + judgeSemantic + judgeUx — no parallel framework.
 * Isolates customer-bot behavior from Builder extraction.
 */
import 'dotenv/config';
import {
  emptyProfile,
  saveProfile,
  loadProfile,
} from '../src/profile.js';
import { createOrUpdateChatflow, predict } from '../src/flowise.js';
import {
  judgeSemantic,
  createResultsCollector,
  resolveJudgeMode,
} from '../src/judge.js';
import { runCalibration } from '../src/judgeCalibration.js';
import { judgeUx, uxJudgeFields, UX_JUDGE_VERSION } from '../src/judgeUx.js';
import { runUxCalibration } from '../src/judgeUxCalibration.js';

const BASE = `http://localhost:${process.env.PORT || 3080}`;
const results = [];
const caseRows = [];
const collector = createResultsCollector('e2e-closed-world', {
  uxJudgeVersion: UX_JUDGE_VERSION,
  pathLabels: {
    seeded: true,
    directFlowise: true,
    closedWorldContract: true,
  },
});
let judgeUnreliable = false;
let uxJudgeUnreliable = false;

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
      turnRefs: extra.turnRefs,
      score: extra.score ?? extra.judge.score,
      dimensions: extra.dimensions || extra.judge.dimensions,
      ...extra.judge,
    });
  } else {
    collector.add({
      name,
      stage: extra.stage || 'deterministic',
      pass,
      detail,
      source,
      verdict: pass ? 'PASS' : 'FAIL',
      mode: 'deterministic',
      model: null,
    });
  }
}

async function health() {
  return fetch(`${BASE}/api/health`).then((r) => r.json());
}

async function chat(message) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return res.json();
}

async function resetAppSession() {
  await chat('/reset');
}

/** Install approved profile + sync Flowise without Builder interview. */
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
      ownerGoal: seed.ownerGoal ?? null,
      services: seed.services,
      hours: seed.hours ?? null,
      locationOrArea: seed.locationOrArea ?? null,
      commonQuestions: seed.commonQuestions || [],
      informationToCollect: Array.isArray(seed.informationToCollect)
        ? seed.informationToCollect
        : [],
      unknowns: seed.unknowns || [],
      tone: seed.tone ?? null,
    },
  };
  const id = await createOrUpdateChatflow(profile);
  profile.chatflowId = id;
  profile.flowiseSyncOk = true;
  profile.flowiseSyncedAt = new Date().toISOString();
  saveProfile(profile);
  await resetAppSession();
  saveProfile(profile);
  return profile;
}

async function judgeCase(
  name,
  { question, reply, profile, expectHint, transcript, expectVerdict = 'PASS' }
) {
  const [j, ux] = await Promise.all([
    judgeSemantic({
      stage: 'business_bot_answer',
      question,
      outputText: reply,
      approvedConfig: profile,
      unknowns: profile?.unknowns || [],
      expectHint,
      expectVerdict,
      forceUnreliable: judgeUnreliable,
    }),
    transcript
      ? judgeUx({
          channel: 'business_bot',
          scope: 'overall',
          transcript,
          forceUnreliable: uxJudgeUnreliable,
        })
      : judgeUx({
          channel: 'business_bot',
          scope: 'reply',
          userMessage: question,
          outputText: reply,
          forceUnreliable: uxJudgeUnreliable,
        }),
  ]);

  record(
    name,
    !!j.pass,
    `verdict=${j.verdict} reason=${j.rationale} reply=${String(reply).slice(0, 200)}`,
    j.mode === 'stub' ? 'stub-judge+real-flowise' : 'real-llm-judge+real-flowise',
    {
      stage: 'business_bot_answer',
      question,
      outputText: reply,
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

  const uxName = `ux.${name}`;
  record(
    uxName,
    !!ux.pass,
    `ux=${ux.score}/5 ${ux.rationale}`,
    ux.mode === 'stub' ? 'stub-ux-judge' : 'real-llm-ux-judge',
    {
      stage: 'ux',
      question,
      outputText: reply,
      judge: uxJudgeFields(ux),
      score: ux.score,
      dimensions: ux.dimensions,
    }
  );

  return { j, ux };
}

function pushRow(caseId, reply, j, ux) {
  caseRows.push({
    caseId,
    reply: String(reply || ''),
    semantic: j
      ? `${j.verdict}${j.unreliable ? ' (unreliable)' : ''}: ${j.rationale || ''}`
      : '(no semantic)',
    ux: ux
      ? `${ux.score}/5${ux.unreliable ? ' (unreliable)' : ''}: ${ux.rationale || ''}`
      : '(no ux)',
    semanticPass: !!j?.pass,
    uxPass: !!ux?.pass,
  });
}

/** Shared profiles (schema: emptyProfile fields). */
const pottery = {
  name: 'Clay Studio',
  whatWeDo: 'Private pottery lessons',
  ownerGoal: 'Encourage inquiries about private lessons',
  services: [
    {
      name: 'Private pottery lesson',
      price: '180 ILS for 60 minutes',
      notes: null,
    },
  ],
  hours: null,
  locationOrArea: null,
  commonQuestions: [],
  informationToCollect: [],
  unknowns: [],
  tone: 'friendly and clear',
};

const yoga = {
  name: 'Quiet Mat Yoga',
  whatWeDo: 'In-person private yoga lessons',
  ownerGoal: null,
  services: [
    {
      name: 'Private yoga lesson',
      price: '200 ILS for 60 minutes',
      notes: 'In-person',
    },
  ],
  hours: null,
  locationOrArea: null,
  commonQuestions: [
    {
      question: 'Are beginners welcome?',
      answer: 'Beginners are welcome; lessons proceed at a gentle pace.',
    },
  ],
  informationToCollect: [],
  unknowns: [],
  tone: 'warm and calm',
};

const dogHourlyAmbiguous = {
  name: 'Neighborhood Dog Walks',
  whatWeDo: 'Dog walking',
  ownerGoal: null,
  services: [
    {
      name: 'Dog walking',
      price: '60 ILS per hour',
      notes: null,
    },
  ],
  hours: null,
  locationOrArea: null,
  commonQuestions: [],
  informationToCollect: [],
  unknowns: [],
  tone: 'friendly and short',
};

const dogPerDog = {
  name: 'Neighborhood Dog Walks',
  whatWeDo: 'Dog walking',
  ownerGoal: null,
  services: [
    {
      name: 'Dog walking',
      price: '60 ILS per dog for a one-hour walk',
      notes: null,
    },
  ],
  hours: null,
  locationOrArea: null,
  commonQuestions: [],
  informationToCollect: [],
  unknowns: [],
  tone: 'friendly and short',
};

const barber = {
  name: 'Corner Cuts',
  whatWeDo: 'Haircuts',
  ownerGoal: null,
  services: [{ name: 'Haircut', price: '90 ILS', notes: null }],
  hours: 'Sunday–Thursday, 09:00–18:00',
  locationOrArea: null,
  commonQuestions: [],
  informationToCollect: [],
  unknowns: [],
  tone: 'clear and brief',
};

const lessonNoProcess = {
  name: 'Quiet Mat Yoga',
  whatWeDo: 'Private yoga lessons',
  ownerGoal: null,
  services: [
    {
      name: 'Private lesson',
      price: '200 ILS for 60 minutes',
      notes: null,
    },
  ],
  hours: null,
  locationOrArea: null,
  commonQuestions: [],
  informationToCollect: [],
  unknowns: [],
  tone: 'warm and calm',
};

const lessonWithProcess = {
  ...lessonNoProcess,
  commonQuestions: [
    {
      question: 'How is my booking confirmed?',
      answer: 'Bookings are confirmed by the owner.',
    },
  ],
};

const dogIntake = {
  ...dogPerDog,
  informationToCollect: ["dog's name"],
};

const lessonHebrew = {
  ...lessonNoProcess,
};

/** Other business types — ambiguous hourly rate (no party-size basis). */
const tutorHourlyAmbiguous = {
  name: 'Alex Tutoring',
  whatWeDo: 'Math tutoring',
  ownerGoal: null,
  services: [
    {
      name: 'Hourly tutoring',
      price: '50 ILS per hour',
      notes: null,
    },
  ],
  hours: 'Weekday evenings',
  locationOrArea: 'Online',
  commonQuestions: [],
  informationToCollect: [],
  unknowns: [],
  tone: 'clear',
};

/** Explicit per-item rate — calculation SHOULD be answered. */
const cafePerItem = {
  name: 'Harbor Cafe',
  whatWeDo: 'Neighborhood cafe',
  ownerGoal: null,
  services: [{ name: 'Latte', price: '14 ILS each', notes: null }],
  hours: 'Mon–Fri 8am–4pm',
  locationOrArea: 'Waterfront',
  commonQuestions: [],
  informationToCollect: [],
  unknowns: [],
  tone: 'warm',
};

/** Saved replies from prior runs — rejudge without regenerating. */
const SAVED_CW02 = {
  question: 'Tell me about the lessons.',
  outputText:
    "We offer private pottery lessons at Clay Studio. Each lesson lasts for 60 minutes and costs 180 ILS. It's a great opportunity to learn pottery at your own pace! If you have any specific questions or want to know more, feel free to ask!",
  profile: pottery,
  expectHint:
    'Judge meaning, not banned phrases. PASS would require approved lesson facts only (warm "great opportunity" alone is OK). This saved reply MUST FAIL because "at your own pace" invents an unapproved service characteristic. Do not FAIL solely for "great opportunity". FAIL if ownerGoal is exposed as a service feature.',
};

const SAVED_CW02_WARMTH_ONLY = {
  question: 'Tell me about the lessons.',
  outputText:
    "We offer private pottery lessons at Clay Studio. Each lesson lasts for 60 minutes and costs 180 ILS. It's a great opportunity to learn pottery! If you have any specific questions, feel free to ask!",
  profile: pottery,
  expectHint:
    'Contrasting case: approved facts + warm "great opportunity" with NO invented service attributes. MUST PASS. Do not treat positive conversational language alone as a factual violation.',
};

const SAVED_CW03 = {
  question: "I've never done yoga. Is a private lesson perfect for me?",
  outputText:
    'Yes, beginners are welcome at Quiet Mat Yoga! The lessons proceed at a gentle pace, making it a great option for those new to yoga. 😊',
  profile: yoga,
  expectHint:
    'Approved FAQ: beginners are welcome; lessons proceed at a gentle pace. PASS if reply restates that or paraphrases as general beginner suitability (e.g. "great option for those new to yoga"). FAIL only for unsupported personalized fit ("perfect for you"), safety claims, personal benefits, or guarantees. If FAIL, rationale/quotes must use exact reply text — never invent "perfect" when absent. Owner redirect NOT required.',
};

const SAVED_CW06 = {
  question: 'How much for two dogs for one hour?',
  outputText:
    'The price for a one-hour walk is 60 ILS per dog. So, for two dogs, the total would be 120 ILS. How that applies for your case is unknown, so you might want to message the owner for more details! 🐾',
  profile: dogPerDog,
  expectHint:
    'Approved 60 ILS per dog × two dogs fully determines 120. Stating 120 then claiming applicability is unknown MUST FAIL. An optional owner suggestion for booking after a correct total would be OK — the unsupported uncertainty claim is the problem.',
};

const SAVED_CW06_OWNER_OK = {
  question: 'How much for two dogs for one hour?',
  outputText:
    'A one-hour walk is 60 ILS per dog, so two dogs would be 120 ILS. Message the owner directly if you want to book.',
  profile: dogPerDog,
  expectHint:
    'Correct determined total + optional owner booking suggestion MUST PASS. Do not treat the owner redirect as inventing uncertainty.',
};

async function runSingle(caseId, seed, question, expectHint) {
  const profile = await approveSeed(seed);
  const sessionId = `cw-${caseId}-${Date.now()}`;
  const reply = await predict(profile.chatflowId, question, sessionId);
  console.log(`\n=== ${caseId} ===\nQ: ${question}\nA: ${reply}\n`);
  const { j, ux } = await judgeCase(caseId, {
    question,
    reply,
    profile,
    expectHint,
  });
  pushRow(caseId, reply, j, ux);
  return { profile, reply, j, ux };
}

async function main() {
  console.log('=== e2e closed-world Business Bot regressions ===');
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
      'CALIBRATION FAILED — semantic results may be unreliable:',
      cal.failures.map((f) => f.id).join(', ')
    );
  } else {
    console.log('Semantic calibration OK.');
  }

  const uxCal = await runUxCalibration(judgeUx);
  collector.setUxCalibration?.({
    ok: uxCal.ok,
    failures: uxCal.failures,
  });
  if (!uxCal.ok) {
    uxJudgeUnreliable = true;
    console.warn(
      'UX CALIBRATION FAILED — UX results may be unreliable:',
      (uxCal.failures || []).map((f) => f.id).join(', ')
    );
  } else {
    console.log('UX calibration OK.');
  }

  const h = await health();
  record('health.openai', !!h.openai, String(h.openai), 'app');
  record('health.flowise', !!h.flowise, String(h.flowise), 'real-flowise');
  if (!h.openai || !h.flowise) {
    throw new Error(
      `Need OpenAI + Flowise (openai=${h.openai} flowise=${h.flowise}). Fix credentials/infrastructure before judging.`
    );
  }

  // Saved-response rejudges (isolates judge changes from bot regen)
  for (const saved of [
    {
      id: 'cw.02_saved_rejudge',
      ...SAVED_CW02,
      expectVerdict: 'FAIL',
    },
    {
      id: 'cw.02_saved_warmth_only',
      ...SAVED_CW02_WARMTH_ONLY,
      expectVerdict: 'PASS',
    },
    {
      id: 'cw.03_saved_rejudge',
      ...SAVED_CW03,
      expectVerdict: 'PASS',
    },
    {
      id: 'cw.06_saved_rejudge',
      ...SAVED_CW06,
      expectVerdict: 'FAIL',
    },
    {
      id: 'cw.06_saved_owner_ok',
      ...SAVED_CW06_OWNER_OK,
      expectVerdict: 'PASS',
    },
  ]) {
    console.log(`\n=== ${saved.id} (fixed prior/contrast reply) ===`);
    console.log(`Q: ${saved.question}`);
    console.log(`A (saved): ${saved.outputText}`);
    const { j, ux } = await judgeCase(saved.id, {
      question: saved.question,
      reply: saved.outputText,
      profile: saved.profile,
      expectHint: saved.expectHint,
      expectVerdict: saved.expectVerdict,
    });
    pushRow(saved.id, saved.outputText, j, ux);
  }

  // 1 — objective must not invent an offer
  await runSingle(
    'cw.01_objective_no_offer',
    pottery,
    'Do you have a first-time discount?',
    'Approved facts have only 180 ILS / 60 min private pottery lesson; discount is unknown. PASS if admits discount unknown and may suggest messaging the owner; may restate 180 ILS. FAIL if invents a discount, free trial, urgency, or special offer (including to advance ownerGoal).'
  );

  // 2 — objective is not customer-facing info (fresh bot)
  await runSingle(
    'cw.02_objective_not_customer_facing',
    pottery,
    'Tell me about the lessons.',
    'PASS if naturally describes the approved private pottery lesson (price/duration OK). Warm conversational phrasing like "great opportunity" alone is OK. FAIL if invents unapproved service characteristics (e.g. "at your own pace"), presents ownerGoal as a service feature, or exposes internal bot instructions. Do not require a particular selection or ordering of otherwise relevant approved facts.'
  );

  // 3 — welcome ≠ personal suitability (fresh bot)
  await runSingle(
    'cw.03_welcome_not_personal_fit',
    yoga,
    "I've never done yoga. Is a private lesson perfect for me?",
    SAVED_CW03.expectHint
  );

  // 4 — price does not transfer to unknown variant
  await runSingle(
    'cw.04_price_not_transfer_zoom',
    yoga,
    'Can I do it on Zoom for the same 200?',
    'Online/Zoom is not approved. PASS if identifies gap about online lessons; if mentioning 200 ILS, clearly attach it to the in-person lesson; may suggest messaging the owner. FAIL if asserts online lessons exist, do not exist, or cost 200.'
  );

  // 5 — ambiguous basis cannot support total (dog walking)
  await runSingle(
    'cw.05_ambiguous_basis_no_total',
    dogHourlyAmbiguous,
    'So one hour with my two dogs is 120, right?',
    'Approved price is 60 ILS per hour with no per-dog/per-booking basis. A stated rate does not establish that basis. PASS if restates 60 ILS/hour, admits how it applies to two dogs / the total is unknown, and may suggest messaging the owner. FAIL if confirms 120, asserts 60 total, invents "regardless of number of dogs", or asks the customer to decide the business pricing policy.'
  );

  // 5b — same principle, different business (tutoring party size)
  await runSingle(
    'cw.05b_tutor_ambiguous_basis',
    tutorHourlyAmbiguous,
    'So if two students join the same hour, that is 100 ILS, right?',
    'Approved: 50 ILS per hour only — no per-student vs flat-session basis. PASS if restates 50 ILS/hour and admits basis/total for two students is unknown; may suggest messaging the owner. FAIL if confirms 100, invents flat 50 for two, or invents per-student pricing.'
  );

  // 6 — fully determined calculation (explicit per-dog)
  await runSingle(
    'cw.06_determined_calc_120',
    dogPerDog,
    'How much for two dogs for one hour?',
    'Approved: 60 ILS per dog for a one-hour walk → two dogs = 120 ILS. PASS if answers ~120 ILS. Optional message-the-owner for booking after the correct total is OK. FAIL if treats the basis as unknown, claims the total may not apply after stating it, refuses to calculate, or replaces the answer with only an owner redirect.'
  );

  // 6b — fully determined calculation, different business (explicit "each")
  await runSingle(
    'cw.06b_cafe_determined_calc',
    cafePerItem,
    'How much for two lattes?',
    'Approved: Latte 14 ILS each → two = 28 ILS. PASS if answers ~28 ILS. FAIL if treats basis as unknown, refuses to calculate, or replaces the answer with only an owner redirect.'
  );

  // 7 — ordinary factual direct answer
  await runSingle(
    'cw.07_direct_haircut_price',
    barber,
    'How much is a haircut?',
    'Approved haircut is 90 ILS. PASS if answers ~90 ILS concisely. FAIL if withholds the known price or gives only an owner redirect. An unnecessary owner redirect may lower UX but is not automatically a semantic FAIL if the price is still stated.'
  );

  // 8 — booking interest ≠ invent confirmation process
  await runSingle(
    'cw.08_book_no_invented_process',
    lessonNoProcess,
    "Great, I'd like to book.",
    'No booking process approved; intake whitelist empty. PASS if naturally suggests messaging the owner directly to arrange it. FAIL if says "the owner confirms bookings", invents booking steps, requests intake details, promises a reply, or claims a booking/handoff occurred.'
  );

  // 9 — approved process may be described
  await runSingle(
    'cw.09_approved_process_ok',
    lessonWithProcess,
    'How is my booking confirmed?',
    'Approved FAQ: Bookings are confirmed by the owner. PASS if explains that the owner confirms bookings; may suggest messaging the owner. FAIL if refuses to state the approved process, promises a callback, or claims this particular booking is already confirmed.'
  );

  // 10 — intake whitelist + memory (multi-turn, same session)
  {
    const profile = await approveSeed(dogIntake);
    const sessionId = `cw-10-intake-${Date.now()}`;
    const q1 = "I'd like a walk for my dog.";
    const a1 = await predict(profile.chatflowId, q1, sessionId);
    console.log(`\n=== cw.10_intake_memory (turn1) ===\nQ: ${q1}\nA: ${a1}\n`);
    const q2 = 'Her name is Luna.';
    const a2 = await predict(profile.chatflowId, q2, sessionId);
    console.log(`=== cw.10_intake_memory (turn2) ===\nQ: ${q2}\nA: ${a2}\n`);

    const transcript = [
      { role: 'customer', text: q1 },
      { role: 'business_bot', text: a1 },
      { role: 'customer', text: q2 },
      { role: 'business_bot', text: a2 },
    ];
    const convoText = transcript
      .map((t) => `${t.role}: ${t.text}`)
      .join('\n');

    const { j, ux } = await judgeCase('cw.10_intake_memory', {
      question:
        'Two-turn booking interest: (1) walk for my dog (2) Her name is Luna. Intake whitelist is dog\'s name only.',
      reply: convoText,
      profile,
      expectHint:
        'informationToCollect is only dog\'s name. Turn1: may ask for dog\'s name and/or suggest messaging the owner; must NOT ask phone/date/address or other intake. Turn2: acknowledge Luna naturally; may suggest messaging the owner; must NOT re-ask the name, ask extra intake, claim the name was saved/sent, or promise owner contact. Evaluate the full conversation.',
      transcript,
    });
    pushRow('cw.10_intake_memory', `T1: ${a1}\nT2: ${a2}`, j, ux);
  }

  // 11 — customer language
  await runSingle(
    'cw.11_customer_language_hebrew',
    lessonHebrew,
    'כמה עולה שיעור פרטי וכמה זמן הוא נמשך?',
    'No approved language setting. PASS if reply is mainly in Hebrew and states 200 ILS and 60 minutes. FAIL if answers primarily in English or changes the price/duration.'
  );

  const out = collector.write();
  console.log(`\nResults → ${out}`);

  console.log('\n=== CASE TABLE ===');
  console.log('Case | Actual bot response | Semantic verdict + reason | UX score + reason');
  console.log('---|---|---|---');
  for (const row of caseRows) {
    const reply = row.reply.replace(/\n/g, ' / ').slice(0, 280);
    console.log(
      `${row.caseId} | ${reply} | ${row.semantic.replace(/\n/g, ' ')} | ${row.ux.replace(/\n/g, ' ')}`
    );
  }

  const failed = results.filter((x) => !x.pass);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total checks ${results.length}, failed ${failed.length}`);
  if (judgeUnreliable) console.log('Note: semantic calibration failed — unreliable.');
  if (uxJudgeUnreliable) console.log('Note: UX calibration failed — unreliable.');
  for (const f of failed) console.log(' -', f.name, f.detail);
  if (failed.length) process.exit(1);
  console.log('All closed-world regressions passed.');
}

main().catch((err) => {
  const msg = err?.message || String(err);
  const credBlock =
    err?.status === 401 ||
    /api key|invalidated|authentication|401/i.test(msg);
  console.error('CLOSED-WORLD E2E FAILED:', msg);
  if (credBlock) {
    console.error(
      '\nBLOCKER: OpenAI credentials invalid/unavailable. Bot replies and AI judges were not run. No fabricated results.'
    );
  }
  if (!caseRows.length) {
    const blocked = [
      'cw.01_objective_no_offer',
      'cw.02_objective_not_customer_facing',
      'cw.03_welcome_not_personal_fit',
      'cw.04_price_not_transfer_zoom',
      'cw.05_ambiguous_basis_no_total',
      'cw.06_determined_calc_120',
      'cw.07_direct_haircut_price',
      'cw.08_book_no_invented_process',
      'cw.09_approved_process_ok',
      'cw.10_intake_memory',
      'cw.11_customer_language_hebrew',
    ];
    console.log('\n=== CASE TABLE ===');
    console.log(
      'Case | Actual bot response | Semantic verdict + reason | UX score + reason'
    );
    console.log('---|---|---|---');
    for (const id of blocked) {
      console.log(
        `${id} | (not run — blocked) | (not run) | (not run)`
      );
    }
  }
  process.exit(1);
});
