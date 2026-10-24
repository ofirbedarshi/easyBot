/**
 * Focused Builder checks: capability honesty for conversation settings.
 * Three cases — supported / ambiguous / unsupported→accept alternative.
 * Builder-only (no Flowise). Semantic judge for meaning; deterministic draft/live.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  businessFactsView,
  CONFIG_CAPABILITIES,
  DEMO_SCOPE,
  emptyProfile,
  loadProfile,
  PRICE_DISCLOSURE_LABELS,
  PRICE_DISCLOSURE_VALUES,
  RESPONSE_LENGTH_VALUES,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import { createSession, handleMessage, bootstrapSession } from '../src/session.js';
import {
  judgeSemantic,
  createResultsCollector,
  resolveJudgeMode,
} from '../src/judge.js';
import { runCalibration } from '../src/judgeCalibration.js';
import { finishSuiteRun } from './_finalizeRun.js';

const results = [];
const collector = createResultsCollector('e2e-builder-settings-honesty', {
  pathLabels: {
    builder_settings_honesty: 'Builder capability honesty (settings)',
  },
});
let judgeUnreliable = false;

const SUPPORTED = {
  priceDisclosure: PRICE_DISCLOSURE_VALUES,
  priceDisclosureLabels: PRICE_DISCLOSURE_LABELS,
  responseLength: RESPONSE_LENGTH_VALUES,
};

function record(name, pass, detail, source, extra = {}) {
  results.push({ name, pass, detail, source, ...extra });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${source}] ${name}: ${detail}`);
  if (extra.judge) {
    collector.add({
      name,
      stage: extra.stage || 'builder_extraction',
      pass,
      detail,
      source,
      question: extra.question,
      outputText: extra.outputText,
      turnRefs: extra.turnRefs,
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
      turnRefs: extra.turnRefs,
    });
  }
}

function t(turn) {
  return collector.addTranscript(turn);
}

/** Seeded approved yoga profile — live on_request, responseLength unset. */
function yogaSeed(overrides = {}) {
  return {
    ...emptyProfile(),
    name: 'Quiet Mat Yoga',
    whatWeDo: 'In-person private yoga lessons in Tel Aviv',
    ownerGoal: 'Answer common questions about lessons',
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
    priceDisclosure: 'on_request',
    approvedAt: '2026-01-01T00:00:00.000Z',
    chatflowId: 'cf-honesty-seed',
    flowiseSyncOk: true,
    flowiseSyncedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function seedSession(key) {
  const profilePath = testProfilePath(`builder-honesty-${key}`);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  const seed = yogaSeed();
  const profile = {
    ...seed,
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
      assistantName: null,
      openingMessage: null,
    },
  };
  saveProfile(profile, profilePath);
  const session = createSession({ profilePath });
  bootstrapSession(session);
  return { session, profilePath, factsSeed: JSON.stringify(businessFactsView(profile)) };
}

async function ownerSay(session, message, businessId) {
  const ownerRef = t({
    channel: 'BUILD',
    role: 'owner',
    event: 'turn',
    text: message,
    businessId,
  });
  const r = await handleMessage(session, message);
  const builderRef = t({
    channel: 'BUILD',
    role: 'builder',
    event: r.event || 'build_turn',
    text: r.reply || '',
    businessId,
  });
  return { r, ownerRef, builderRef };
}

async function recordSemantic(name, args) {
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
      turnRefs: args.turnRefs,
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

async function caseSupported() {
  const id = 'supported';
  console.log(`\n=== ${id} ===`);
  const { session, profilePath, factsSeed } = seedSession(id);
  const msg =
    "Keep replies short, and mention prices when they're relevant.";
  const { r, ownerRef, builderRef } = await ownerSay(session, msg, id);
  const disk = loadProfile(profilePath);
  const draft = disk.draft || {};

  console.log(`Builder reply:\n${r.reply}\n`);

  record(
    'honesty.supported.draft_enums',
    draft.responseLength === 'short' && draft.priceDisclosure === 'relevant',
    `responseLength=${draft.responseLength} priceDisclosure=${draft.priceDisclosure}`,
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );
  record(
    'honesty.supported.live_unchanged',
    disk.priceDisclosure === 'on_request' &&
      disk.responseLength == null &&
      r.approved !== true &&
      r.event === 'build_turn',
    `live.priceDisclosure=${disk.priceDisclosure} live.responseLength=${disk.responseLength} approved=${r.approved} event=${r.event}`,
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );
  record(
    'honesty.supported.facts_unchanged',
    JSON.stringify(businessFactsView(disk)) === factsSeed,
    'business facts equal seed',
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );

  await recordSemantic('honesty.supported.reply_pending', {
    outputText: `${r.reply}\n\nDRAFT:${JSON.stringify(draft)}\nLIVE_PRICE:${disk.priceDisclosure}`,
    disclosureLedger: {
      ownerSaid: msg,
      supportedSettings: SUPPORTED,
      liveBefore: { priceDisclosure: 'on_request', responseLength: null },
      expectedDraft: { responseLength: 'short', priceDisclosure: 'relevant' },
      mustNotClaim: 'change already live / bot already updated without approval',
    },
    extractedDraft: draft,
    expectHint:
      'Owner clearly asked for short replies and prices when relevant. PASS if draft has responseLength=short and priceDisclosure=relevant, reply describes the change as proposed/pending approval (not already live), and does not invent unsupported policies. FAIL if claims the live bot already changed or invents an always-disclose policy.',
    turnRefs: [ownerRef, builderRef],
  });
}

async function caseAmbiguous() {
  const id = 'ambiguous';
  console.log(`\n=== ${id} ===`);
  const { session, profilePath, factsSeed } = seedSession(id);
  const msg =
    'Mention prices all the time because they attract customers.';
  const { r, ownerRef, builderRef } = await ownerSay(session, msg, id);
  const disk = loadProfile(profilePath);
  const draft = disk.draft || {};

  console.log(`Builder reply:\n${r.reply}\n`);

  record(
    'honesty.ambiguous.setting_preserved',
    draft.priceDisclosure === 'on_request' || draft.priceDisclosure == null,
    `draft.priceDisclosure=${draft.priceDisclosure} (must stay on_request / prior)`,
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );
  // reconcile preserves prior; after seed draft was on_request
  record(
    'honesty.ambiguous.draft_still_on_request',
    draft.priceDisclosure === 'on_request',
    `draft.priceDisclosure=${draft.priceDisclosure}`,
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );
  record(
    'honesty.ambiguous.live_and_facts',
    disk.priceDisclosure === 'on_request' &&
      JSON.stringify(businessFactsView(disk)) === factsSeed,
    `live=${disk.priceDisclosure}`,
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );

  await recordSemantic('honesty.ambiguous.clarifies', {
    outputText: `${r.reply}\n\nDRAFT:${JSON.stringify(draft)}`,
    disclosureLedger: {
      ownerSaid: msg,
      supportedSettings: SUPPORTED,
      liveBefore: { priceDisclosure: 'on_request' },
      expectedBehavior:
        'Ask clarification; do not promise prices in every answer; do not invent always policy; leave priceDisclosure unchanged',
    },
    extractedDraft: draft,
    expectHint:
      'Owner said "prices all the time" which is ambiguous vs supported relevant/on_request. PASS if reply asks a short clarification (e.g. whether they mean mentioning prices when describing relevant services), does NOT promise prices in every answer, does NOT invent an always policy, and draft priceDisclosure stays on_request. FAIL if silently sets a policy or promises unsupported always-disclose behavior.',
    turnRefs: [ownerRef, builderRef],
  });
}

async function caseUnsupportedThenAccept() {
  const id = 'unsupported_accept';
  console.log(`\n=== ${id} ===`);
  const { session, profilePath, factsSeed } = seedSession(id);

  const msgA =
    'Include the price in every single reply, even when the customer asks about something unrelated.';
  const { r: rA, ownerRef: oA, builderRef: bA } = await ownerSay(
    session,
    msgA,
    id
  );
  const diskA = loadProfile(profilePath);
  const draftA = diskA.draft || {};

  console.log(`Builder reply A:\n${rA.reply}\n`);

  record(
    'honesty.unsupported.A_setting_preserved',
    draftA.priceDisclosure === 'on_request' &&
      diskA.priceDisclosure === 'on_request',
    `draft=${draftA.priceDisclosure} live=${diskA.priceDisclosure}`,
    'deterministic',
    { turnRefs: [oA, bA] }
  );
  record(
    'honesty.unsupported.A_facts',
    JSON.stringify(businessFactsView(diskA)) === factsSeed,
    'facts unchanged',
    'deterministic',
    { turnRefs: [oA, bA] }
  );

  await recordSemantic('honesty.unsupported.A_explains_offers', {
    outputText: `${rA.reply}\n\nDRAFT:${JSON.stringify(draftA)}`,
    disclosureLedger: {
      ownerSaid: msgA,
      supportedSettings: SUPPORTED,
      liveBefore: { priceDisclosure: 'on_request' },
      expectedBehavior:
        'Explain every-reply prices not supported; offer closest supported alternative (relevant); leave setting unchanged until accepted',
    },
    extractedDraft: draftA,
    expectHint:
      'Owner asked for prices in every reply (unsupported). PASS if reply clearly says that is not supported, offers the closest supported alternative (relevant / when useful and relevant), asks whether to use it, and draft priceDisclosure remains on_request. FAIL if silently sets relevant/always or promises every-reply prices.',
    turnRefs: [oA, bA],
  });

  const msgB = 'yes';
  const { r: rB, ownerRef: oB, builderRef: bB } = await ownerSay(
    session,
    msgB,
    id
  );
  const diskB = loadProfile(profilePath);
  const draftB = diskB.draft || {};

  console.log(`Builder reply B:\n${rB.reply}\n`);

  record(
    'honesty.unsupported.B_draft_relevant_live_on_request',
    draftB.priceDisclosure === 'relevant' &&
      diskB.priceDisclosure === 'on_request' &&
      rB.approved !== true &&
      rB.event === 'build_turn',
    `draft=${draftB.priceDisclosure} live=${diskB.priceDisclosure} approved=${rB.approved} event=${rB.event}`,
    'deterministic',
    { turnRefs: [oB, bB] }
  );
  record(
    'honesty.unsupported.B_facts',
    JSON.stringify(businessFactsView(diskB)) === factsSeed,
    'facts unchanged after accept alternative',
    'deterministic',
    { turnRefs: [oB, bB] }
  );

  await recordSemantic('honesty.unsupported.B_pending_not_live', {
    outputText: `${rB.reply}\n\nDRAFT:${JSON.stringify(draftB)}\nLIVE:${diskB.priceDisclosure}\nAPPROVED:${rB.approved}`,
    disclosureLedger: {
      ownerSaid: 'yes (accepting the offered relevant alternative)',
      supportedSettings: SUPPORTED,
      expectedDraft: { priceDisclosure: 'relevant' },
      liveMustStay: { priceDisclosure: 'on_request' },
      mustNotClaim: 'already live / approved without further approve',
    },
    extractedDraft: draftB,
    expectHint:
      'Owner accepted the offered relevant alternative. PASS if draft priceDisclosure is relevant, reply presents the change as pending approval (not already live), and does not treat this yes as final approval of the live bot. FAIL if claims the change is already applied/live or leaves draft on_request.',
    turnRefs: [oB, bB],
  });
}

/**
 * Unsupported behavior requests of different kinds (not price). Each must leave
 * every setting unchanged, not approve, and be explained as unsupported.
 */
const UNSUPPORTED_BEHAVIOR_REQUESTS = [
  {
    id: 'emoji_every_message_he',
    msg: 'אני רוצה שכל הודעה ללקוח תפתח עם אימוגי אחר',
  },
  {
    id: 'reminder_next_day',
    msg: 'Have the bot send each customer a reminder message the day before their lesson.',
  },
  {
    id: 'sign_off_every_reply',
    msg: 'End every single reply with "Namaste 🙏 — Quiet Mat Yoga".',
  },
];

const SETTING_FIELDS = [
  'tone',
  'responseLength',
  'priceDisclosure',
  'assistantName',
  'openingMessage',
];

function settingsOf(p) {
  return Object.fromEntries(SETTING_FIELDS.map((k) => [k, p?.[k] ?? null]));
}

async function caseUnsupportedBehavior({ id, msg }) {
  const caseId = `unsupported_${id}`;
  console.log(`\n=== ${caseId} ===`);
  const { session, profilePath, factsSeed } = seedSession(caseId);
  const before = loadProfile(profilePath);
  const draftBefore = JSON.stringify(settingsOf(before.draft));
  const { r, ownerRef, builderRef } = await ownerSay(session, msg, caseId);
  const disk = loadProfile(profilePath);
  const draft = disk.draft || {};

  console.log(`Builder reply:\n${r.reply}\n`);

  record(
    `honesty.${caseId}.settings_unchanged`,
    JSON.stringify(settingsOf(draft)) === draftBefore &&
      JSON.stringify(settingsOf(disk)) === JSON.stringify(settingsOf(before)),
    `draft=${JSON.stringify(settingsOf(draft))}`,
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );
  record(
    `honesty.${caseId}.facts_unchanged_not_approved`,
    JSON.stringify(businessFactsView(disk)) === factsSeed &&
      r.approved !== true &&
      r.event === 'build_turn',
    `approved=${r.approved} event=${r.event}`,
    'deterministic',
    { turnRefs: [ownerRef, builderRef] }
  );

  await recordSemantic(`honesty.${caseId}.explains_unsupported`, {
    outputText: `${r.reply}\n\nDRAFT:${JSON.stringify(draft)}`,
    disclosureLedger: {
      ownerSaid: msg,
      configurableFields: CONFIG_CAPABILITIES,
      demoScope: DEMO_SCOPE,
      settingsBefore: JSON.parse(draftBefore),
    },
    extractedDraft: draft,
    expectHint:
      'Owner asked for behavior no configurable field represents. PASS if reply says it is not supported, offers a closest supported alternative, and does not claim it was added/set/noted; draft settings unchanged. FAIL if it accepts, adds, or summarizes the request as configured.',
    turnRefs: [ownerRef, builderRef],
  });
}

async function main() {
  console.log('=== e2e Builder settings honesty ===');
  console.log(`Judge mode: ${resolveJudgeMode()}`);

  if (!process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY missing — skipping.');
    record(
      'honesty.skipped_no_openai',
      true,
      'No OPENAI_API_KEY',
      'app',
      { stage: 'deterministic' }
    );
    collector.write();
    return;
  }

  const cal = await runCalibration(judgeSemantic);
  collector.setCalibration({
    ok: cal.ok,
    failures: cal.failures,
    judgeMode: cal.judgeMode,
    judgeModel: cal.judgeModel,
  });
  if (!cal.ok) {
    judgeUnreliable = true;
    console.warn('Semantic calibration failed — judges marked unreliable');
  }

  await caseSupported();
  await caseAmbiguous();
  await caseUnsupportedThenAccept();
  for (const req of UNSUPPORTED_BEHAVIOR_REQUESTS) {
    await caseUnsupportedBehavior(req);
  }

  finishSuiteRun({
    results,
    collector,
    judgeUnreliable,
    uxJudgeUnreliable: false,
    record,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
