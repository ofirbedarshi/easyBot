/**
 * Focused AI run: Builder editing-menu navigation (real Builder + real Flowise).
 * Scenarios A–E. Deterministic checks cover routing/state; owner-facing replies
 * go to the existing semantic (builder_extraction) and UX (builder) judges.
 * Calibration is NOT rerun: reliability follows the latest recorded calibration.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  behaviorSettingsView,
  businessFactsView,
  loadProfile,
  mergeDraft,
  testProfilePath,
} from '../src/profile.js';
import { bootstrapSession, createSession, handleMessage } from '../src/session.js';
import { pingFlowise } from '../src/flowise.js';
import { menuActive } from '../src/ownerNav.js';
import { createResultsCollector, judgeSemantic, resolveJudgeMode } from '../src/judge.js';
import { judgeUx, uxJudgeFields, UX_JUDGE_VERSION } from '../src/judgeUx.js';
import { finishSuiteRun } from './_finalizeRun.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, '..', 'data', 'test-results');
const HE_MENU_HEAD = '1. פרטי העסק';
const EN_MENU_HEAD = '1. Business details';

const results = [];
const rows = [];
const collector = createResultsCollector('e2e-builder-nav', {
  uxJudgeVersion: UX_JUDGE_VERSION,
  pathLabels: { builderNavigation: true },
});

/** Latest recorded calibration status per judge (newest result file that has it). */
function recordedCalibration() {
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ f, t: fs.statSync(path.join(RESULTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  let semantic = null;
  let ux = null;
  for (const { f } of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
      if (semantic == null && j.calibration && typeof j.calibration.ok === 'boolean') {
        semantic = { ok: j.calibration.ok, file: f };
      }
      if (ux == null && j.uxCalibration && typeof j.uxCalibration.ok === 'boolean') {
        ux = { ok: j.uxCalibration.ok, file: f };
      }
    } catch {
      /* skip unreadable */
    }
    if (semantic && ux) break;
  }
  return { semantic, ux };
}

const cal = recordedCalibration();
const judgeUnreliable = !cal.semantic?.ok;
const uxJudgeUnreliable = !cal.ux?.ok;

function record(name, pass, detail, source, extra = {}) {
  results.push({ name, pass, detail, source, ...extra });
  console.log(`${pass ? 'PASS' : extra.unreliable ? 'REVIEW' : 'FAIL'} [${source}] ${name}: ${detail}`);
  collector.add({
    name,
    stage: extra.stage || 'deterministic',
    pass,
    detail,
    source,
    outputText: extra.outputText,
    ...(extra.judge || { verdict: pass ? 'PASS' : 'FAIL', mode: 'deterministic', model: null }),
  });
}

function det(name, pass, detail) {
  record(name, !!pass, detail, 'deterministic');
}

function liveState(profile) {
  return {
    approvedBusinessFacts: businessFactsView(profile),
    approvedConversationSettings: behaviorSettingsView(profile),
  };
}

function pendingState(profile) {
  if (!profile.draft) return null;
  const merged = mergeDraft(profile, profile.draft);
  return {
    pendingBusinessFacts: businessFactsView(merged),
    pendingConversationSettings: behaviorSettingsView(merged),
  };
}

function convo(session, n = 8) {
  return session.buildHistory.slice(-n).map((m) => ({
    role: m.role === 'user' ? 'owner' : 'builder',
    text: m.content,
  }));
}

/** Semantic (builder_extraction) + UX (builder) on one owner-facing reply. */
async function judgeOwnerReply(name, { session, userMessage, reply, profile, expectHint }) {
  const prior = convo(session).slice(0, -1);
  const [j, ux] = await Promise.all([
    judgeSemantic({
      stage: 'builder_extraction',
      outputText: reply,
      disclosureLedger: {
        ownerConversation: prior,
        ownerMessage: userMessage,
        ...liveState(profile),
        pendingDraft: pendingState(profile),
        evidenceLegend:
          'outputUnderTest is the Builder reply to the owner. Live = active customer bot; pending = unapproved draft.',
      },
      extractedDraft: { live: liveState(profile), pending: pendingState(profile) },
      expected: { verdict: 'PASS', reason: expectHint },
      forceUnreliable: judgeUnreliable,
    }),
    judgeUx({
      channel: 'builder',
      scope: 'reply',
      userMessage,
      outputText: reply,
      priorConversation: prior,
      forceUnreliable: uxJudgeUnreliable,
    }),
  ]);
  record(name, !!j.pass, `verdict=${j.verdict} ${j.rationale || ''}`, 'real-llm-judge', {
    stage: 'builder_extraction',
    outputText: reply,
    unreliable: !!j.unreliable,
    judge: {
      verdict: j.verdict,
      rationale: j.rationale,
      quotes: j.quotes,
      dimensions: j.dimensions,
      mode: j.mode,
      model: j.model,
      judgeVersion: j.judgeVersion,
      unreliable: j.unreliable,
    },
  });
  record(`ux.${name}`, !!ux.pass, `ux=${ux.score}/5 ${ux.rationale}`, 'real-ux-judge', {
    stage: 'builder_ux',
    outputText: reply,
    unreliable: !!ux.unreliable,
    judge: uxJudgeFields(ux),
  });
  rows.push({
    name,
    userMessage,
    reply,
    semantic: `${j.verdict}${j.unreliable ? ' (unreliable)' : ''}: ${j.rationale || ''}`,
    ux: `${ux.score}/5${ux.unreliable ? ' (unreliable)' : ''}: ${ux.rationale || ''}`,
  });
}

/** Drive the real Builder until an approval syncs (bounded). */
async function driveToApproval(session, messages, approveWord) {
  let r;
  const transcript = [];
  for (const m of messages) {
    r = await handleMessage(session, m);
    transcript.push({ m, r });
    if (r.approved) return { r, transcript };
    if (r.readyForReview) break;
  }
  for (const word of [approveWord, 'approve']) {
    if (!r.readyForReview) break;
    r = await handleMessage(session, word);
    transcript.push({ m: word, r });
    if (r.approved) break;
  }
  return { r, transcript };
}

function freshSession(key) {
  const p = testProfilePath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const session = createSession({ profilePath: p });
  bootstrapSession(session);
  return { session, profilePath: p };
}

async function main() {
  console.log('=== e2e builder navigation (A–E) ===');
  console.log(`Judge mode: ${resolveJudgeMode()}`);
  console.log(
    `Recorded calibration: semantic=${cal.semantic?.ok} (${cal.semantic?.file}) ux=${cal.ux?.ok} (${cal.ux?.file})`
  );
  collector.setCalibration({ ok: !judgeUnreliable, failures: [], note: 'not rerun; latest recorded status' });
  collector.setUxCalibration?.({ ok: !uxJudgeUnreliable, failures: [] });

  const up = await pingFlowise({ timeoutMs: 8000 });
  if (!up || !process.env.OPENAI_API_KEY) {
    throw new Error(`Need OpenAI + Flowise (flowise=${up})`);
  }

  // --- A: Hebrew owner approve → Hebrew editing menu ---
  console.log('\n=== A: Hebrew approve → menu ===');
  const he = freshSession('builder-nav-e2e-he');
  const s = he.session;
  const { r: rA } = await driveToApproval(
    s,
    [
      'יש לי סטודיו ליוגה בתל אביב בשם "נשימה". שיעור פרטי של 60 דקות עולה 200 ש"ח. המטרה: לענות ללקוחות על שאלות. לא צריך לאסוף פרטים מהלקוחות.',
      'זה הכל, אין מה להוסיף. תציג סיכום לאישור.',
    ],
    'מאשר'
  );
  let pA = loadProfile(he.profilePath);
  det('A.approved_synced', rA.event === 'approved_synced', `event=${rA.event}`);
  det('A.hebrew_menu', rA.reply.includes('הבוט עודכן ✅') && rA.reply.includes(HE_MENU_HEAD), rA.reply.slice(-400));
  det('A.no_infra', !/flowise|chatflow/i.test(rA.reply), 'no Flowise/chatflow in reply');
  det('A.menu_context', menuActive(s.buildHistory), 'menu context active');
  if (rA.event !== 'approved_synced') throw new Error('A did not approve+sync; aborting B–D');
  await judgeOwnerReply('A.approve_menu', {
    session: s,
    userMessage: 'מאשר',
    reply: rA.reply,
    profile: pA,
    expectHint:
      'Hebrew owner just approved. PASS if the reply says the bot was updated, that we are in editing mode, and shows the six-item Hebrew menu, without contradicting the approved state or exposing infrastructure details.',
  });

  // --- B: select 4 → settings; style change → review → approve → menu ---
  console.log('\n=== B: section 4 + style change ===');
  const rawBefore = fs.readFileSync(he.profilePath, 'utf8');
  const rB1 = await handleMessage(s, '4');
  det('B.section_event', rB1.event === 'menu_section', `event=${rB1.event}`);
  det('B.read_only', fs.readFileSync(he.profilePath, 'utf8') === rawBefore, 'profile unchanged');
  await judgeOwnerReply('B.section4_current', {
    session: s,
    userMessage: '4',
    reply: rB1.reply,
    profile: pA,
    expectHint:
      'Owner chose section 4 (conversation style and price disclosure). PASS if the reply accurately shows the current live tone, reply length, and price disclosure (defaults marked as defaults) and asks what to change. FAIL if any value contradicts approvedConversationSettings.',
  });
  const ownerB = 'תשנה את הסגנון לרשמי ומקצועי, ושיציג מחירים רק כשהלקוח שואל.';
  const rB2 = await handleMessage(s, ownerB);
  const pB2 = loadProfile(he.profilePath);
  det('B.review_presented', rB2.readyForReview === true, `ready=${rB2.readyForReview}`);
  det('B.draft_on_request', pB2.draft?.priceDisclosure === 'on_request', `draft.priceDisclosure=${pB2.draft?.priceDisclosure}`);
  det('B.live_unchanged', pB2.priceDisclosure == null || pB2.priceDisclosure === pA.priceDisclosure, `live=${pB2.priceDisclosure}`);
  await judgeOwnerReply('B.style_review', {
    session: s,
    userMessage: ownerB,
    reply: rB2.reply,
    profile: pB2,
    expectHint:
      'Owner requested formal/professional tone and prices only on request. PASS if the reply presents these as a pending change awaiting approval and does not claim it is already live.',
  });
  let rB3 = await handleMessage(s, 'מאשר');
  if (!rB3.approved) rB3 = await handleMessage(s, 'approve');
  const pB3 = loadProfile(he.profilePath);
  det('B.approved_synced', rB3.event === 'approved_synced', `event=${rB3.event}`);
  det('B.persisted', pB3.priceDisclosure === 'on_request', `priceDisclosure=${pB3.priceDisclosure}`);
  det('B.menu_again', rB3.reply.includes(HE_MENU_HEAD) && menuActive(s.buildHistory), 'menu after update');
  await judgeOwnerReply('B.approve_menu', {
    session: s,
    userMessage: 'מאשר',
    reply: rB3.reply,
    profile: pB3,
    expectHint:
      'Owner approved the style change. PASS if the reply confirms the update, says we are in editing mode, and shows the Hebrew menu, consistent with the new live settings.',
  });

  // --- C: choose section 1, then free-text change in another section ---
  console.log('\n=== C: section 1 then FAQ change ===');
  const rC1 = await handleMessage(s, '1');
  det('C.section1', rC1.event === 'menu_section' && rC1.reply.includes('200'), rC1.reply.slice(0, 200));
  const ownerC = 'תוסיף שאלה נפוצה: האם יש חניה? התשובה: כן, יש חניה חינם ליד הסטודיו.';
  const rC2 = await handleMessage(s, ownerC);
  const pC = loadProfile(he.profilePath);
  const faqOk = (pC.draft?.commonQuestions || []).some((q) => /חני/.test(`${q.question} ${q.answer}`));
  det('C.builder_handled', rC2.event === 'build_turn' || rC2.event?.startsWith('approved'), `event=${rC2.event}`);
  det('C.draft_faq', faqOk, JSON.stringify(pC.draft?.commonQuestions || []).slice(0, 200));
  await judgeOwnerReply('C.free_text_other_section', {
    session: s,
    userMessage: ownerC,
    reply: rC2.reply,
    profile: pC,
    expectHint:
      'After viewing business details, owner asked to add a parking FAQ. PASS if the Builder handles it as a normal edit: the FAQ (question + answer) appears as a pending change awaiting approval, not live yet.',
  });

  // --- D: menu → 6 → customer mode → /end → Hebrew menu ---
  console.log('\n=== D: 6 → TEST → /end ===');
  await handleMessage(s, 'תפריט');
  const rD1 = await handleMessage(s, '6');
  det('D.enter_test', rD1.event === 'enter_test' && s.mode === 'TEST', rD1.reply);
  const rDq = await handleMessage(s, 'כמה עולה שיעור פרטי?');
  det('D.customer_reply', rDq.event === 'test_turn' && rDq.source === 'real-flowise', rDq.reply.slice(0, 200));
  const rD2 = await handleMessage(s, '/end');
  det('D.end_menu', rD2.reply.startsWith('חזרנו למצב עריכה') && rD2.reply.includes(HE_MENU_HEAD), rD2.reply.slice(0, 120));
  const pD = loadProfile(he.profilePath);
  det('D.pending_kept', JSON.stringify(pD.draft?.commonQuestions) === JSON.stringify(pC.draft?.commonQuestions), 'pending FAQ draft kept');
  await judgeOwnerReply('D.end_menu', {
    session: s,
    userMessage: '/end',
    reply: rD2.reply,
    profile: pD,
    expectHint:
      'Owner left customer test mode. PASS if the reply says we returned to editing mode and shows the Hebrew menu.',
  });

  // --- E: English owner → English menu ---
  console.log('\n=== E: English owner ===');
  const en = freshSession('builder-nav-e2e-en');
  const { r: rE } = await driveToApproval(
    en.session,
    [
      'I run a dog grooming salon called Fluffy in Haifa. A full groom costs 150 ILS. I want the bot to answer customer questions. No need to collect any customer details.',
      "That's everything. Please show me the summary to approve.",
    ],
    'approve'
  );
  const pE = loadProfile(en.profilePath);
  det('E.approved_synced', rE.event === 'approved_synced', `event=${rE.event}`);
  det('E.english_menu', rE.reply.includes('Bot updated ✅') && rE.reply.includes(EN_MENU_HEAD), rE.reply.slice(-300));
  await judgeOwnerReply('E.approve_menu_en', {
    session: en.session,
    userMessage: 'approve',
    reply: rE.reply,
    profile: pE,
    expectHint:
      'English owner approved. PASS if the reply confirms the update, says we are in editing mode, and shows the six-item English menu.',
  });

  const out = collector.write();
  console.log(`\nResults → ${out}`);
  console.log('\n=== OWNER-FACING REPLIES ===');
  for (const r of rows) {
    console.log(`\n--- ${r.name} | owner: ${r.userMessage}\n${r.reply}\nsemantic: ${r.semantic}\nux: ${r.ux}`);
  }
  console.log(`\nCustomer reply (D): ${rDq.reply}`);
  finishSuiteRun({ results, collector, judgeUnreliable, uxJudgeUnreliable, record });
}

main().catch((err) => {
  console.error('BUILDER-NAV E2E FAILED:', err?.message || err);
  try {
    collector.write();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
