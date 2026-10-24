/**
 * Focused AI suite: owner-configurable conversation style + price disclosure.
 * Real Builder → draft → approval → Flowise Business Bot + semantic/UX judges.
 * Deterministic checks cover persistence / isolation / propagation only.
 * Style matching uses AI judges — no English tone keyword regex asserts.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  businessFactsView,
  behaviorSettingsView,
  DEFAULT_BEHAVIOR,
  effectiveBehavior,
  emptyProfile,
  formatSummary,
  loadProfile,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import {
  bootstrapSession,
  createSession,
  handleMessage,
} from '../src/session.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import { createOrUpdateChatflow, predict, pingFlowise } from '../src/flowise.js';
import {
  judgeSemantic,
  approvedEvidence,
  createResultsCollector,
  resolveJudgeMode,
} from '../src/judge.js';
import { runCalibration } from '../src/judgeCalibration.js';
import { judgeUx, uxJudgeFields, UX_JUDGE_VERSION } from '../src/judgeUx.js';
import { runUxCalibration } from '../src/judgeUxCalibration.js';
import { finishSuiteRun } from './_finalizeRun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = testProfilePath('behavior-settings');

const results = [];
const caseRows = [];
const collector = createResultsCollector('e2e-behavior-settings', {
  uxJudgeVersion: UX_JUDGE_VERSION,
  pathLabels: {
    behaviorSettings: true,
    builderToCustomer: true,
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

function det(name, pass, detail) {
  record(name, pass, detail, 'deterministic', { stage: 'deterministic' });
}

/** Yoga fixture from the acceptance brief. */
function yogaSeed(overrides = {}) {
  return {
    ...emptyProfile(),
    name: 'Quiet Mat Yoga',
    whatWeDo: 'In-person private yoga lessons in Tel Aviv',
    ownerGoal: null,
    services: [
      {
        name: 'Private yoga lesson',
        price: '200 ILS for 60 minutes',
        notes: 'In-person',
      },
    ],
    hours: null,
    locationOrArea: 'Tel Aviv',
    commonQuestions: [
      {
        question: 'Are beginners welcome?',
        answer: 'Beginners are welcome; lessons proceed at a gentle pace.',
      },
    ],
    informationToCollect: [],
    unknowns: [],
    tone: 'warm and calm',
    responseLength: null,
    priceDisclosure: null,
    ...overrides,
  };
}

async function seedApprovedProfile() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  const seed = yogaSeed();
  const profile = {
    ...seed,
    approvedAt: new Date().toISOString(),
    draft: {
      name: seed.name,
      whatWeDo: seed.whatWeDo,
      ownerGoal: seed.ownerGoal,
      services: seed.services,
      hours: seed.hours,
      locationOrArea: seed.locationOrArea,
      commonQuestions: seed.commonQuestions,
      informationToCollect: seed.informationToCollect,
      unknowns: seed.unknowns,
      tone: seed.tone,
      responseLength: seed.responseLength,
      priceDisclosure: seed.priceDisclosure,
    },
  };
  const id = await createOrUpdateChatflow(profile);
  profile.chatflowId = id;
  profile.flowiseSyncOk = true;
  profile.flowiseSyncedAt = new Date().toISOString();
  saveProfile(profile, PROFILE);
  return profile;
}

function freshSession() {
  return createSession({ profilePath: PROFILE });
}

async function judgeBot(name, args) {
  const profile = args.profile || loadProfile(PROFILE);
  const evidence = approvedEvidence(profile);
  const settings = evidence.behaviorSettings;
  const [j, ux] = await Promise.all([
    judgeSemantic({
      stage: 'business_bot_answer',
      question: args.question,
      outputText: args.reply,
      evidence,
      priorConversation: args.conversationContext || args.priorConversation || null,
      expected: {
        verdict: args.expectVerdict || 'PASS',
        reason: args.expectHint || null,
      },
      forceUnreliable: judgeUnreliable,
    }),
    judgeUx({
      channel: 'business_bot',
      scope: args.transcript ? 'overall' : 'reply',
      userMessage: args.question,
      outputText: args.reply,
      transcript: args.transcript,
      priorConversation: args.conversationContext || args.priorConversation || null,
      behaviorSettings: settings,
      forceUnreliable: uxJudgeUnreliable,
    }),
  ]);

  record(
    name,
    !!j.pass,
    `verdict=${j.verdict} reason=${j.rationale} reply=${String(args.reply).slice(0, 220)}`,
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
  record(
    `ux.${name}`,
    !!ux.pass,
    `ux=${ux.score}/5 ${ux.rationale}`,
    ux.mode === 'stub' ? 'stub-ux-judge' : 'real-llm-ux-judge',
    {
      stage: 'ux',
      question: args.question,
      outputText: args.reply,
      judge: uxJudgeFields(ux),
      score: ux.score,
      dimensions: ux.dimensions,
    }
  );
  pushRow(name, args.reply, j, ux);
  return { j, ux };
}

async function judgeBuilderExtraction(name, args) {
  const j = await judgeSemantic({
    stage: 'builder_extraction',
    outputText: args.outputText,
    disclosureLedger: args.disclosureLedger,
    extractedDraft: args.extractedDraft,
    expected: { verdict: 'PASS', reason: args.expectHint },
    forceUnreliable: judgeUnreliable,
  });
  record(
    name,
    !!j.pass,
    `verdict=${j.verdict} ${j.rationale || ''}`,
    j.mode === 'stub' ? 'stub-judge' : 'real-llm-judge',
    {
      stage: 'builder_extraction',
      outputText: args.outputText,
      judge: {
        verdict: j.verdict,
        rationale: j.rationale,
        quotes: j.quotes,
        factRefs: j.factRefs,
        dimensions: j.dimensions,
        mode: j.mode,
        model: j.model,
        judgeVersion: j.judgeVersion,
        unreliable: j.unreliable,
      },
    }
  );
  return j;
}

async function main() {
  console.log('=== e2e behavior settings (style + price disclosure) ===');
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

  const reachable = await pingFlowise({ timeoutMs: 5000 });
  det('health.flowise', !!reachable, String(reachable));
  if (!reachable || !process.env.OPENAI_API_KEY) {
    throw new Error(
      `Need OpenAI + Flowise (flowise=${reachable} openai=${!!process.env.OPENAI_API_KEY})`
    );
  }
  det('health.openai', true, 'key present');

  const seedProfile = await seedApprovedProfile();
  const factsSeed = JSON.stringify(businessFactsView(seedProfile));
  const syncedAt0 = seedProfile.flowiseSyncedAt;
  const livePrompt0 = buildCustomerSystemPrompt(seedProfile);
  det(
    'seed.defaults',
    /Price disclosure: relevant/i.test(livePrompt0) &&
      seedProfile.priceDisclosure == null &&
      seedProfile.responseLength == null,
    `tone=${seedProfile.tone} priceDisclosure=${seedProfile.priceDisclosure}`
  );

  const session = freshSession();
  bootstrapSession(session);

  // --- A: owner requests warm+short + on_request ---
  console.log('\n=== A: owner behavior request ===');
  const ownerA =
    'Keep replies warm and short, and only mention prices when customers ask about pricing.';
  const rA = await handleMessage(session, ownerA);
  const draftA = loadProfile(PROFILE).draft || {};
  det(
    'A.draft_price_disclosure',
    draftA.priceDisclosure === 'on_request',
    `draft.priceDisclosure=${draftA.priceDisclosure}`
  );
  det(
    'A.draft_response_length',
    draftA.responseLength === 'short',
    `draft.responseLength=${draftA.responseLength}`
  );
  det(
    'A.facts_unchanged',
    JSON.stringify(businessFactsView(loadProfile(PROFILE))) === factsSeed,
    'live business facts equal seed'
  );
  det(
    'A.tone_present',
    typeof draftA.tone === 'string' && draftA.tone.trim().length > 0,
    `draft.tone length=${(draftA.tone || '').length}`
  );

  await judgeBuilderExtraction('A.builder_extraction', {
    outputText: `${rA.reply}\n\nDRAFT:${JSON.stringify(draftA)}`,
    disclosureLedger: {
      ownerSaid: ownerA,
      expectedSettings: {
        responseLength: 'short',
        priceDisclosure: 'on_request',
        toneDescribed: 'warm (expression only)',
      },
      businessFactsMustStay: JSON.parse(factsSeed),
    },
    extractedDraft: draftA,
    expectHint:
      'Owner asked for warm short replies and prices only when asked. PASS if draft captures responseLength=short, priceDisclosure=on_request, and a tone consistent with warm/friendly expression — without changing services/prices/FAQ/intake. Do not require exact English keywords in tone; judge meaning. FAIL if business facts changed or an unsupported never-disclose policy was invented.',
  });

  const uxA = await judgeUx({
    channel: 'builder',
    scope: 'reply',
    userMessage: ownerA,
    outputText: rA.reply,
    forceUnreliable: uxJudgeUnreliable,
  });
  record(
    'A.builder_ux',
    !!uxA.pass,
    `ux=${uxA.score}/5 ${uxA.rationale}`,
    uxA.mode === 'stub' ? 'stub-ux' : 'real-ux-judge',
    { stage: 'builder_ux', outputText: rA.reply, judge: uxJudgeFields(uxA) }
  );

  // --- B: before approval, live unchanged (deterministic) ---
  console.log('\n=== B: draft/live isolation ===');
  const diskB = loadProfile(PROFILE);
  det(
    'B.live_price_disclosure_null',
    diskB.priceDisclosure == null,
    `live.priceDisclosure=${diskB.priceDisclosure}`
  );
  det(
    'B.live_response_length_null',
    diskB.responseLength == null,
    `live.responseLength=${diskB.responseLength}`
  );
  det(
    'B.flowise_synced_at_unchanged',
    diskB.flowiseSyncedAt === syncedAt0,
    `syncedAt=${diskB.flowiseSyncedAt}`
  );
  const promptB = buildCustomerSystemPrompt(diskB);
  det(
    'B.live_prompt_still_relevant',
    /Price disclosure: relevant/i.test(promptB) &&
      !/on request only/i.test(promptB),
    'live prompt retains relevant default'
  );
  const summaryB = formatSummary(diskB);
  det(
    'B.summary_live_vs_pending',
    /Live approved/.test(summaryB) && /Pending/.test(summaryB),
    'summary shows Live vs Pending'
  );

  // --- Approve ---
  console.log('\n=== Approve behavior settings ===');
  let rApprove = await handleMessage(session, 'approve');
  let afterApprove = loadProfile(PROFILE);
  // One retry if model soft-approve path somehow skipped (should be rare)
  if (afterApprove.priceDisclosure !== 'on_request') {
    rApprove = await handleMessage(session, 'approve');
    afterApprove = loadProfile(PROFILE);
  }
  det(
    'approve.event_synced',
    rApprove.event === 'approved_synced' ||
      (afterApprove.flowiseSyncOk === true &&
        afterApprove.priceDisclosure === 'on_request'),
    `event=${rApprove.event} syncOk=${afterApprove.flowiseSyncOk} priceDisclosure=${afterApprove.priceDisclosure}`
  );
  det(
    'approve.persisted_on_request',
    afterApprove.priceDisclosure === 'on_request',
    `priceDisclosure=${afterApprove.priceDisclosure}`
  );
  det(
    'approve.persisted_short',
    afterApprove.responseLength === 'short',
    `responseLength=${afterApprove.responseLength}`
  );
  det(
    'approve.facts_unchanged',
    JSON.stringify(businessFactsView(afterApprove)) === factsSeed,
    'facts unchanged after behavior approve'
  );
  const promptApproved = buildCustomerSystemPrompt(afterApprove);
  det(
    'approve.prompt_on_request',
    /on request only/i.test(promptApproved),
    'customer prompt includes on_request policy'
  );
  if (afterApprove.priceDisclosure !== 'on_request') {
    throw new Error(
      'Abort customer cases: on_request not persisted after approve (setup would invalidate C–G).'
    );
  }

  // Ensure /test works
  const enter = await handleMessage(session, '/test');
  det('test.enter', enter.ok === true && session.mode === 'TEST', enter.reply || '');

  // --- C: Tell me about the lessons (no price) ---
  console.log('\n=== C: general description under on_request ===');
  const qC = 'Tell me about the lessons.';
  const rC = await handleMessage(session, qC);
  await judgeBot('C.describe_no_price', {
    question: qC,
    reply: rC.reply,
    profile: afterApprove,
    expectHint:
      'approvedBehaviorSettings.priceDisclosure=on_request. PASS if reply describes approved lesson facts (in-person / Tel Aviv / beginners welcome / gentle pace as relevant) WITHOUT mentioning 200 ILS or any price. Withholding the known price is NOT a factual omission. FAIL if volunteers a price or invents capabilities/booking.',
  });

  // --- D: And how much? (pricing follow-up) ---
  console.log('\n=== D: pricing follow-up ===');
  const qD = 'And how much?';
  const rD = await handleMessage(session, qD);
  await judgeBot('D.how_much_followup', {
    question: qD,
    reply: rD.reply,
    profile: afterApprove,
    conversationContext: [
      { role: 'customer', text: qC },
      { role: 'business_bot', text: rC.reply },
    ],
    expectHint:
      'Clear pricing follow-up under on_request. PASS if states ~200 ILS for 60 minutes. FAIL if withholds the known price or says pricing is unavailable because of the policy.',
  });

  // Overall UX for C+D
  const uxCD = await judgeUx({
    channel: 'business_bot',
    scope: 'overall',
    transcript: [
      { role: 'customer', text: qC },
      { role: 'business_bot', text: rC.reply },
      { role: 'customer', text: qD },
      { role: 'business_bot', text: rD.reply },
    ],
    behaviorSettings: behaviorSettingsView(afterApprove),
    forceUnreliable: uxJudgeUnreliable,
  });
  record(
    'ux.C_D_overall',
    !!uxCD.pass,
    `ux=${uxCD.score}/5 ${uxCD.rationale}`,
    uxCD.mode === 'stub' ? 'stub-ux' : 'real-ux-judge',
    { stage: 'ux', judge: uxJudgeFields(uxCD), score: uxCD.score }
  );

  // --- C2: price then unrelated factual (not permanent unlock) ---
  console.log('\n=== C2: price then unrelated FAQ (no permanent unlock) ===');
  await handleMessage(session, '/end');
  await handleMessage(session, '/test');
  const qPrice = 'How much is a private lesson?';
  const aPrice = await handleMessage(session, qPrice);
  await judgeBot('C2a.direct_price', {
    question: qPrice,
    reply: aPrice.reply,
    profile: loadProfile(PROFILE),
    expectHint:
      'Direct pricing question under on_request. PASS if states ~200 ILS for 60 minutes.',
  });
  const qUnrelated = 'Are beginners welcome?';
  const aUnrelated = await handleMessage(session, qUnrelated);
  await judgeBot('C2b.unrelated_after_price', {
    question: qUnrelated,
    reply: aUnrelated.reply,
    profile: loadProfile(PROFILE),
    conversationContext: [
      { role: 'customer', text: qPrice },
      { role: 'business_bot', text: aPrice.reply },
    ],
    expectHint:
      'priceDisclosure=on_request. Prior pricing answer does NOT permanently unlock disclosure. PASS if answers beginners welcome / gentle pace WITHOUT repeating 200 ILS or any price. FAIL if re-states the price on this unrelated factual question.',
  });

  // --- E: I'd like to book (fresh session) ---
  console.log('\n=== E: booking interest ===');
  const profileLive = loadProfile(PROFILE);
  const sidE = `beh-E-${Date.now()}`;
  const qE = "I'd like to book.";
  const aE = await predict(profileLive.chatflowId, qE, sidE);
  console.log(`E reply: ${aE}`);
  await judgeBot('E.book_no_price', {
    question: qE,
    reply: aE,
    profile: profileLive,
    expectHint:
      'on_request + empty intake. PASS if offers a natural next step (e.g. message the owner) WITHOUT volunteering 200 ILS, inventing a booking process, collecting extra fields, or claiming a booking/handoff. Booking interest alone is not a pricing question.',
  });

  // --- F: two lessons cost ---
  console.log('\n=== F: two lessons total ===');
  const sidF = `beh-F-${Date.now()}`;
  const qF = 'What would two lessons cost?';
  const aF = await predict(profileLive.chatflowId, qF, sidF);
  console.log(`F reply: ${aF}`);
  await judgeBot('F.two_lessons_400', {
    question: qF,
    reply: aF,
    profile: profileLive,
    expectHint:
      'Pricing question. Approved rate 200 ILS for 60 minutes × two lessons fully determines 400 ILS. PASS if answers ~400 ILS without invented discounts or claiming the total is unknown after stating it. Optional owner redirect for booking after the total is OK.',
  });

  // --- G: online same price ---
  console.log('\n=== G: online variant ===');
  const sidG = `beh-G-${Date.now()}`;
  const qG = 'Can I do it online for the same price?';
  const aG = await predict(profileLive.chatflowId, qG, sidG);
  console.log(`G reply: ${aG}`);
  await judgeBot('G.online_unknown', {
    question: qG,
    reply: aG,
    profile: profileLive,
    expectHint:
      'Pricing question about unknown online variant. PASS if identifies the online/Zoom gap and does not attach the in-person 200 ILS to online. May state the clearly qualified in-person price. FAIL if asserts online exists/costs 200 or transfers the price to the unlisted channel.',
  });

  // --- J: style-only edit preserves priceDisclosure ---
  console.log('\n=== J: style-only edit ===');
  await handleMessage(session, '/end');
  const beforeJ = loadProfile(PROFILE);
  const factsJ = JSON.stringify(businessFactsView(beforeJ));
  const priceJ = beforeJ.priceDisclosure;
  const lenJ = beforeJ.responseLength;
  const rJ = await handleMessage(
    session,
    'Please make the tone a bit friendlier — leave everything else the same.'
  );
  const draftJ = loadProfile(PROFILE).draft || {};
  det(
    'J.draft_keeps_price_disclosure',
    draftJ.priceDisclosure === 'on_request' ||
      (draftJ.priceDisclosure == null && priceJ === 'on_request'),
    `draft.priceDisclosure=${draftJ.priceDisclosure} (live was ${priceJ})`
  );
  // If draft omitted it, reconcile should have preserved — check after approve either way
  const rJApprove = await handleMessage(session, 'approve');
  const afterJ = loadProfile(PROFILE);
  det(
    'J.approve_synced',
    rJApprove.event === 'approved_synced' || afterJ.flowiseSyncOk,
    `event=${rJApprove.event}`
  );
  det(
    'J.price_disclosure_preserved',
    afterJ.priceDisclosure === 'on_request',
    `priceDisclosure=${afterJ.priceDisclosure}`
  );
  det(
    'J.response_length_preserved',
    afterJ.responseLength === 'short' || afterJ.responseLength === lenJ,
    `responseLength=${afterJ.responseLength}`
  );
  det(
    'J.facts_unchanged',
    JSON.stringify(businessFactsView(afterJ)) === factsJ,
    'facts unchanged after style-only approve'
  );
  await judgeBuilderExtraction('J.builder_style_only', {
    outputText: `${rJ.reply}\n\nDRAFT:${JSON.stringify(draftJ)}\nAFTER:${JSON.stringify({ tone: afterJ.tone, responseLength: afterJ.responseLength, priceDisclosure: afterJ.priceDisclosure })}`,
    disclosureLedger: {
      ownerSaid: 'style-only friendlier tone; leave everything else the same',
      mustPreserve: { priceDisclosure: 'on_request', responseLength: 'short' },
    },
    extractedDraft: {
      tone: afterJ.tone,
      responseLength: afterJ.responseLength,
      priceDisclosure: afterJ.priceDisclosure,
    },
    expectHint:
      'Style-only edit. PASS if priceDisclosure remains on_request and business facts are unchanged. Tone may update. FAIL if price disclosure reset to relevant/null or facts changed.',
  });

  // --- H: professional + concise + relevant ---
  console.log('\n=== H: switch to professional + relevant ===');
  const factsH = JSON.stringify(businessFactsView(loadProfile(PROFILE)));
  const ownerH =
    'Please switch to a professional and concise style, and mention prices when relevant.';
  const rH = await handleMessage(session, ownerH);
  const draftH = loadProfile(PROFILE).draft || {};
  det(
    'H.draft_relevant',
    draftH.priceDisclosure === 'relevant',
    `draft.priceDisclosure=${draftH.priceDisclosure}`
  );
  det(
    'H.draft_short',
    draftH.responseLength === 'short',
    `draft.responseLength=${draftH.responseLength}`
  );
  await handleMessage(session, 'approve');
  const afterH = loadProfile(PROFILE);
  det(
    'H.persisted_relevant',
    afterH.priceDisclosure === 'relevant',
    `priceDisclosure=${afterH.priceDisclosure}`
  );
  det(
    'H.persisted_short',
    afterH.responseLength === 'short',
    `responseLength=${afterH.responseLength}`
  );
  det(
    'H.facts_unchanged',
    JSON.stringify(businessFactsView(afterH)) === factsH,
    'facts unchanged after H approve'
  );
  det(
    'H.tone_present',
    typeof afterH.tone === 'string' && afterH.tone.trim().length > 0,
    `tone length=${(afterH.tone || '').length}`
  );

  await judgeBuilderExtraction('H.builder_extraction', {
    outputText: `${rH.reply}\n\nAFTER:${JSON.stringify(behaviorSettingsView(afterH))}`,
    disclosureLedger: {
      ownerSaid: ownerH,
      expected: {
        priceDisclosure: 'relevant',
        responseLength: 'short',
        toneDescribed: 'professional and concise',
      },
    },
    extractedDraft: {
      tone: afterH.tone,
      responseLength: afterH.responseLength,
      priceDisclosure: afterH.priceDisclosure,
    },
    expectHint:
      'Owner switched to professional/concise and prices when relevant. PASS if priceDisclosure=relevant, responseLength=short, and tone meaning matches professional/concise (judge meaning, not exact keywords). FAIL if facts changed or on_request kept incorrectly.',
  });

  const sidH1 = `beh-H1-${Date.now()}`;
  const qH1 = 'Tell me about the lessons.';
  const aH1 = await predict(afterH.chatflowId, qH1, sidH1);
  console.log(`H1 reply: ${aH1}`);
  await judgeBot('H.describe_relevant', {
    question: qH1,
    reply: aH1,
    profile: afterH,
    expectHint:
      'priceDisclosure=relevant after re-approve. PASS if naturally describes approved facts. Mentioning 200 ILS is allowed but NOT required. FAIL if invents facts/capabilities or contradicts approved config. Do not require volunteering a price.',
  });

  const sidH2 = `beh-H2-${Date.now()}`;
  const qH2 = 'How much is a lesson?';
  const aH2 = await predict(afterH.chatflowId, qH2, sidH2);
  console.log(`H2 reply: ${aH2}`);
  await judgeBot('H.direct_price', {
    question: qH2,
    reply: aH2,
    profile: afterH,
    expectHint:
      'Direct pricing question under relevant. PASS if states ~200 ILS for 60 minutes.',
  });

  // --- I: legacy load (deterministic) ---
  console.log('\n=== I: legacy profile defaults ===');
  const legacyPath = testProfilePath('behavior-settings-legacy');
  const legacy = {
    name: 'Quiet Mat Yoga',
    whatWeDo: 'In-person private yoga lessons',
    services: [
      {
        name: 'Private yoga lesson',
        price: '200 ILS for 60 minutes',
        notes: null,
      },
    ],
    informationToCollect: [],
    unknowns: [],
    commonQuestions: [],
    tone: 'warm and calm',
    approvedAt: '2026-01-01T00:00:00.000Z',
  };
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify(legacy, null, 2), 'utf8');
  const loadedLegacy = loadProfile(legacyPath);
  const effL = effectiveBehavior(loadedLegacy);
  det(
    'I.tone_preserved',
    loadedLegacy.tone === 'warm and calm',
    `tone=${loadedLegacy.tone}`
  );
  det(
    'I.defaults',
    loadedLegacy.responseLength == null &&
      loadedLegacy.priceDisclosure == null &&
      effL.responseLength === DEFAULT_BEHAVIOR.responseLength &&
      effL.priceDisclosure === DEFAULT_BEHAVIOR.priceDisclosure,
    JSON.stringify(effL)
  );
  const promptL = buildCustomerSystemPrompt(loadedLegacy);
  det(
    'I.prompt_defaults',
    /Tone: warm and calm/.test(promptL) &&
      /Price disclosure: relevant/.test(promptL) &&
      /Reply length: standard/.test(promptL),
    'legacy prompt renders defaults without error'
  );

  const out = collector.write();
  console.log(`\nResults → ${out}`);
  console.log('\n=== CASE TABLE ===');
  console.log(
    'Case | Actual bot response | Semantic verdict + reason | UX score + reason'
  );
  console.log('---|---|---|---');
  for (const row of caseRows) {
    const reply = row.reply.replace(/\n/g, ' / ').slice(0, 280);
    console.log(
      `${row.caseId} | ${reply} | ${row.semantic.replace(/\n/g, ' ')} | ${row.ux.replace(/\n/g, ' ')}`
    );
  }

  finishSuiteRun({
    results,
    collector,
    judgeUnreliable,
    uxJudgeUnreliable,
    record,
  });
}

main().catch((err) => {
  console.error('BEHAVIOR-SETTINGS E2E FAILED:', err?.message || err);
  try {
    collector.write();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
