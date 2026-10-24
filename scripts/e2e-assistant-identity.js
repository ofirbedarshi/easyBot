/**
 * Focused AI suite: owner-configurable assistant identity + opening message.
 * Real Builder → draft → approval → Flowise Business Bot + semantic/UX judges.
 * Identity/opening reach judges as behaviorSettings, separate from business facts.
 * Judges evaluate meaning; no exact-wording regex asserts on bot replies.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  businessFactsView,
  behaviorSettingsView,
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

const PROFILE = testProfilePath('assistant-identity');

const OWNER_A =
  'Call the assistant Maya. Have her introduce herself as the digital assistant of Yoga with Noa, with this opening: ‘Hi, I’m Maya, the digital assistant of Yoga with Noa 🙂 How can I help?’';
const OWNER_E =
  'Please change the opening to: "Hey there! Maya here, Yoga with Noa\'s digital assistant. What can I do for you today?" Keep everything else the same.';
const OWNER_F =
  'Change the opening to: "Hi, I\'m Maya! I can book your yoga lesson for you right now — just tell me a time that works."';

const ONLY_A = process.env.IDENTITY_CASES === 'A';

const results = [];
const caseRows = [];
const collector = createResultsCollector('e2e-assistant-identity', {
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
  });
}

function det(name, pass, detail) {
  record(name, pass, detail, 'deterministic', { stage: 'deterministic' });
}

function noaSeed() {
  return {
    ...emptyProfile(),
    name: 'Yoga with Noa',
    whatWeDo: 'Private in-person yoga lessons with Noa in Tel Aviv',
    services: [
      {
        name: 'Private yoga lesson',
        price: '200 ILS for 60 minutes',
        notes: 'In-person',
      },
    ],
    locationOrArea: 'Tel Aviv',
    commonQuestions: [
      {
        question: 'Are beginners welcome?',
        answer: 'Beginners are welcome; lessons proceed at a gentle pace.',
      },
    ],
    informationToCollect: [],
    unknowns: [],
  };
}

async function seedApprovedProfile() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  const seed = noaSeed();
  const { approvedAt, chatflowId, flowiseSyncOk, draft, ...fields } = seed;
  const profile = {
    ...seed,
    approvedAt: new Date().toISOString(),
    draft: { ...fields },
  };
  delete profile.draft.flowiseSyncedAt;
  delete profile.draft.flowiseSyncPending;
  delete profile.draft.flowiseSyncRequestedAt;
  profile.chatflowId = await createOrUpdateChatflow(profile);
  profile.flowiseSyncOk = true;
  profile.flowiseSyncedAt = new Date().toISOString();
  saveProfile(profile, PROFILE);
  return profile;
}

async function judgeBot(name, args) {
  const evidence = approvedEvidence(args.profile);
  const [j, ux] = await Promise.all([
    judgeSemantic({
      stage: 'business_bot_answer',
      question: args.question,
      outputText: args.reply,
      evidence,
      priorConversation: args.priorConversation || null,
      expected: { verdict: 'PASS', reason: args.expectHint || null },
      forceUnreliable: judgeUnreliable,
    }),
    judgeUx({
      channel: 'business_bot',
      scope: 'reply',
      userMessage: args.question,
      outputText: args.reply,
      priorConversation: args.priorConversation || null,
      behaviorSettings: evidence.behaviorSettings,
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

async function judgeBuilder(name, args) {
  const [j, ux] = await Promise.all([
    judgeSemantic({
      stage: 'builder_extraction',
      outputText: args.outputText,
      disclosureLedger: args.disclosureLedger,
      extractedDraft: args.extractedDraft,
      expected: { verdict: 'PASS', reason: args.expectHint },
      forceUnreliable: judgeUnreliable,
    }),
    judgeUx({
      channel: 'builder',
      scope: 'reply',
      userMessage: args.disclosureLedger.ownerSaid,
      outputText: args.reply,
      forceUnreliable: uxJudgeUnreliable,
    }),
  ]);
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
  record(
    `ux.${name}`,
    !!ux.pass,
    `ux=${ux.score}/5 ${ux.rationale}`,
    ux.mode === 'stub' ? 'stub-ux' : 'real-ux-judge',
    { stage: 'builder_ux', outputText: args.reply, judge: uxJudgeFields(ux) }
  );
  pushRow(name, args.reply, j, ux);
  return { j, ux };
}

function printCaseTable() {
  console.log('\n=== CASE TABLE ===');
  console.log('Case | Actual reply | Semantic | UX');
  console.log('---|---|---|---');
  for (const row of caseRows) {
    console.log(
      `${row.caseId} | ${row.reply.replace(/\n/g, ' / ').slice(0, 320)} | ${row.semantic.replace(/\n/g, ' ')} | ${row.ux.replace(/\n/g, ' ')}`
    );
  }
}

async function approve(session) {
  let r = await handleMessage(session, 'approve');
  if (!r.approved) r = await handleMessage(session, 'approve');
  return r;
}

async function main() {
  console.log('=== e2e assistant identity + opening ===');
  console.log(`Judge mode: ${resolveJudgeMode()}`);

  if (ONLY_A) {
    // Targeted retest: calibration is not re-run, so semantic verdicts stay unreliable.
    judgeUnreliable = true;
    collector.setCalibration({ ok: false, failures: [{ id: 'not_rerun' }] });
    console.warn('IDENTITY_CASES=A — calibration not re-run; semantic marked unreliable.');
  } else {
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
    }
    const uxCal = await runUxCalibration(judgeUx);
    collector.setUxCalibration?.({ ok: uxCal.ok, failures: uxCal.failures });
    if (!uxCal.ok) {
      uxJudgeUnreliable = true;
      console.warn(
        'UX CALIBRATION FAILED — UX results may be unreliable:',
        (uxCal.failures || []).map((f) => f.id).join(', ')
      );
    }
  }

  const reachable = await pingFlowise({ timeoutMs: 15000 });
  det('health.flowise', !!reachable, String(reachable));
  if (!reachable || !process.env.OPENAI_API_KEY) {
    throw new Error(
      `Need OpenAI + Flowise (flowise=${reachable} openai=${!!process.env.OPENAI_API_KEY})`
    );
  }

  const seed = await seedApprovedProfile();
  const factsSeed = JSON.stringify(businessFactsView(seed));
  const syncedAt0 = seed.flowiseSyncedAt;
  const session = createSession({ profilePath: PROFILE });
  bootstrapSession(session);

  // --- A: owner sets name + opening; preview before approval ---
  console.log('\n=== A: owner identity request ===');
  const rA = await handleMessage(session, OWNER_A);
  const diskA = loadProfile(PROFILE);
  const draftA = diskA.draft || {};
  det(
    'A.draft_assistant_name',
    typeof draftA.assistantName === 'string' && draftA.assistantName.length > 0,
    `draft.assistantName=${draftA.assistantName}`
  );
  det(
    'A.draft_opening_present',
    typeof draftA.openingMessage === 'string' && draftA.openingMessage.length > 0,
    `draft.openingMessage=${draftA.openingMessage}`
  );
  det(
    'A.ready_for_review_preview',
    rA.readyForReview === true && rA.approved !== true,
    `readyForReview=${rA.readyForReview} approved=${rA.approved}`
  );
  det(
    'A.live_unchanged_before_approve',
    diskA.assistantName == null &&
      diskA.openingMessage == null &&
      diskA.flowiseSyncedAt === syncedAt0 &&
      JSON.stringify(businessFactsView(diskA)) === factsSeed,
    `live.assistantName=${diskA.assistantName} live.openingMessage=${diskA.openingMessage}`
  );
  await judgeBuilder('A.builder_capture_preview', {
    reply: rA.reply,
    outputText: `${rA.reply}\n\nDRAFT:${JSON.stringify({
      assistantName: draftA.assistantName,
      openingMessage: draftA.openingMessage,
      services: draftA.services,
      name: draftA.name,
    })}`,
    disclosureLedger: {
      ownerSaid: OWNER_A,
      expectedSettings: {
        assistantName: 'Maya',
        openingMessage:
          'Hi, I’m Maya, the digital assistant of Yoga with Noa 🙂 How can I help?',
      },
      businessFactsMustStay: JSON.parse(factsSeed),
    },
    extractedDraft: draftA,
    expectHint:
      'PASS if the draft captures assistant name Maya and the owner opening (meaning preserved), business facts unchanged, and the Builder message previews the change and asks for approval.',
  });

  const rApprove = await approve(session);
  const liveA = loadProfile(PROFILE);
  det(
    'A.approve_persisted',
    liveA.assistantName === draftA.assistantName &&
      liveA.openingMessage === draftA.openingMessage &&
      liveA.flowiseSyncOk === true,
    `event=${rApprove.event} name=${liveA.assistantName} opening=${liveA.openingMessage}`
  );
  det(
    'A.facts_unchanged_after_approve',
    JSON.stringify(businessFactsView(liveA)) === factsSeed,
    'facts equal seed'
  );
  if (!liveA.assistantName || !liveA.openingMessage) {
    throw new Error('Abort customer cases: identity not persisted after approve.');
  }
  det(
    'A.prompt_contains_identity',
    buildCustomerSystemPrompt(liveA).includes(liveA.openingMessage),
    'customer prompt includes approved opening'
  );
  if (ONLY_A) {
    printCaseTable();
    finishSuiteRun({ results, collector, judgeUnreliable, uxJudgeUnreliable, record });
    return;
  }

  // --- B: fresh "Hi" ---
  console.log('\n=== B: fresh conversation "Hi" ===');
  const enter = await handleMessage(session, '/test');
  det('test.enter', enter.ok === true && session.mode === 'TEST', enter.reply || '');
  const qB = 'Hi';
  const rB = await handleMessage(session, qB);
  await judgeBot('B.fresh_hi_intro', {
    question: qB,
    reply: rB.reply,
    profile: liveA,
    expectHint:
      'First message of a fresh conversation. PASS if the reply introduces itself consistently with the approved opening (Maya, digital assistant of Yoga with Noa) and offers help, without claiming to be the owner or inventing facts.',
  });

  // --- C: second message, no re-intro ---
  console.log('\n=== C: second message same conversation ===');
  const qC = 'Are beginners welcome?';
  const rC = await handleMessage(session, qC);
  await judgeBot('C.second_no_reintro', {
    question: qC,
    reply: rC.reply,
    profile: liveA,
    priorConversation: [
      { role: 'customer', text: qB },
      { role: 'business_bot', text: rB.reply },
    ],
    expectHint:
      'Second turn. PASS if answers beginners welcome / gentle pace without repeating the introduction.',
  });

  // --- D: separate fresh conversation, substantive first question ---
  console.log('\n=== D: fresh conversation price question ===');
  const qD = 'How much is a lesson?';
  const rD = await predict(liveA.chatflowId, qD, `ident-D-${Date.now()}`);
  console.log(`D reply: ${rD}`);
  await judgeBot('D.fresh_price_intro_and_answer', {
    question: qD,
    reply: rD,
    profile: liveA,
    expectHint:
      'First message is a substantive pricing question. PASS if the same reply includes the introduction AND states 200 ILS for 60 minutes. FAIL if only a greeting.',
  });

  // --- E: owner edits opening; new conversation uses it ---
  console.log('\n=== E: owner edits opening ===');
  await handleMessage(session, '/end');
  const beforeE = loadProfile(PROFILE);
  const rE = await handleMessage(session, OWNER_E);
  const draftE = loadProfile(PROFILE).draft || {};
  det(
    'E.draft_keeps_name',
    draftE.assistantName === beforeE.assistantName,
    `draft.assistantName=${draftE.assistantName}`
  );
  await approve(session);
  const liveE = loadProfile(PROFILE);
  det(
    'E.persisted_new_opening_name_kept',
    liveE.assistantName === beforeE.assistantName &&
      liveE.openingMessage &&
      liveE.openingMessage !== beforeE.openingMessage,
    `name=${liveE.assistantName} opening=${liveE.openingMessage}`
  );
  det(
    'E.facts_and_settings_unchanged',
    JSON.stringify(businessFactsView(liveE)) === factsSeed &&
      liveE.priceDisclosure === beforeE.priceDisclosure &&
      liveE.responseLength === beforeE.responseLength &&
      liveE.tone === beforeE.tone,
    `price=${liveE.priceDisclosure} len=${liveE.responseLength} tone=${liveE.tone}`
  );
  console.log(`E builder reply: ${rE.reply.slice(0, 300)}`);
  const qE = 'Hi';
  const rE2 = await predict(liveE.chatflowId, qE, `ident-E-${Date.now()}`);
  console.log(`E reply: ${rE2}`);
  await judgeBot('E.fresh_hi_new_opening', {
    question: qE,
    reply: rE2,
    profile: liveE,
    expectHint:
      'Fresh conversation after opening edit. PASS if the introduction matches the NEW approved opening in meaning (not the old one).',
  });

  // --- F: conflicting opening (booking capability) ---
  console.log('\n=== F: conflicting opening ===');
  const beforeF = loadProfile(PROFILE);
  const rF = await handleMessage(session, OWNER_F);
  const diskF = loadProfile(PROFILE);
  const draftF = diskF.draft || {};
  det(
    'F.live_unchanged',
    diskF.openingMessage === beforeF.openingMessage &&
      diskF.flowiseSyncedAt === beforeF.flowiseSyncedAt,
    `live.openingMessage=${diskF.openingMessage}`
  );
  det(
    'F.draft_not_conflicting_text',
    !/book your yoga lesson for you/i.test(draftF.openingMessage || ''),
    `draft.openingMessage=${draftF.openingMessage}`
  );
  await judgeBuilder('F.builder_conflict_correction', {
    reply: rF.reply,
    outputText: `${rF.reply}\n\nDRAFT:${JSON.stringify({
      openingMessage: draftF.openingMessage,
      assistantName: draftF.assistantName,
    })}`,
    disclosureLedger: {
      ownerSaid: OWNER_F,
      demoCapabilities:
        'Customer bot can answer from approved facts, clarify needs, collect listed intake, and suggest messaging the owner. It cannot book lessons, take payments, or save/deliver inquiries.',
      currentApprovedOpening: beforeF.openingMessage,
    },
    extractedDraft: { openingMessage: draftF.openingMessage },
    expectHint:
      'Proposed opening claims a booking capability that does not exist. PASS if the Builder explains the conflict, does not adopt the conflicting text, and asks for a corrected opening.',
  });

  printCaseTable();
  console.log(
    `\nFinal settings: ${JSON.stringify(behaviorSettingsView(loadProfile(PROFILE)))}`
  );
  console.log(`Summary:\n${formatSummary(loadProfile(PROFILE))}`);

  finishSuiteRun({ results, collector, judgeUnreliable, uxJudgeUnreliable, record });
}

main().catch((err) => {
  console.error('ASSISTANT-IDENTITY E2E FAILED:', err?.message || err);
  try {
    collector.write();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
