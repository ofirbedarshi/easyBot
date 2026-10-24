/**
 * Builder experience AI evaluations (Phase 2 thin slice).
 * Four scenarios via real handleMessage + real Builder LLM + semantic/UX judges.
 * No Flowise /test — Builder-only. Does not claim inquiry save/delivery.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { createSession, handleMessage, bootstrapSession } from '../src/session.js';
import {
  judgeSemantic,
  createResultsCollector,
  resolveJudgeMode,
} from '../src/judge.js';
import { runCalibration } from '../src/judgeCalibration.js';
import { judgeUx, uxJudgeFields, UX_JUDGE_VERSION } from '../src/judgeUx.js';
import { runUxCalibration } from '../src/judgeUxCalibration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const collector = createResultsCollector('e2e-builder-experience', {
  uxJudgeVersion: UX_JUDGE_VERSION,
  pathLabels: {
    owner_builder: 'Owner experience with the Builder',
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

function channelTranscript(channel) {
  return (collector.transcript() || []).filter((row) => row.channel === channel);
}

async function freshSession(key) {
  const profilePath = testProfilePath(`builder-exp-${key}`);
  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  saveProfile(emptyProfile(), profilePath);
  const session = createSession({ profilePath });
  const boot = bootstrapSession(session);
  t({
    channel: 'BUILD',
    role: 'builder',
    event: 'open',
    text: boot.reply || '',
    businessId: key,
  });
  return session;
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

async function recordUx(name, args) {
  const j = await judgeUx({
    channel: 'builder',
    scope: args.scope || 'reply',
    userMessage: args.userMessage,
    outputText: args.outputText,
    transcript: args.transcript,
    forceUnreliable: uxJudgeUnreliable,
  });
  record(name, !!j.pass, `score=${j.score} ${j.rationale || ''}`, j.mode === 'stub' ? 'stub-ux' : 'real-ux-judge', {
    stage: 'builder_ux',
    outputText: args.outputText,
    userMessage: args.userMessage,
    turnRefs: args.turnRefs,
    judge: uxJudgeFields(j),
  });
  return j;
}

async function recordSemantic(name, args) {
  const j = await judgeSemantic({
    stage: 'builder_extraction',
    outputText: args.outputText,
    disclosureLedger: args.disclosureLedger,
    extractedDraft: args.extractedDraft,
    expectHint: args.expectHint,
    expectVerdict: 'PASS',
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

async function scenarioDumpUpfront() {
  const id = 'dump_upfront';
  console.log(`\n=== ${id} ===`);
  const session = await freshSession(id);
  const dump =
    "I'm Maya, I teach private yoga in Austin. Goal: answer common questions and collect name + preferred time when someone wants a lesson. Private lessons are $70 for 60 minutes. Hours Mon–Fri 9–5. Tone friendly. Don't need to collect anything else beyond name and preferred time.";
  const { r, ownerRef, builderRef } = await ownerSay(session, dump, id);
  const profile = loadProfile(session.profilePath);
  const draft = profile.draft || {};

  const hasIdentity = !!(draft.name || draft.whatWeDo);
  const hasGoal =
    typeof draft.ownerGoal === 'string' &&
    /question|collect|lesson/i.test(draft.ownerGoal);
  const hasService = (draft.services || []).some((s) =>
    /yoga|private|lesson/i.test(`${s.name} ${s.price || ''}`)
  );
  record(
    'builder.dump_upfront.draft_absorbs_facts',
    hasIdentity && hasGoal && hasService,
    `name=${draft.name} goal=${draft.ownerGoal} services=${JSON.stringify(draft.services)}`,
    'deterministic',
    { stage: 'deterministic', turnRefs: [ownerRef, builderRef] }
  );

  await recordSemantic('builder.dump_upfront.extraction', {
    outputText: `${r.reply}\n\nDRAFT:${JSON.stringify(draft)}`,
    disclosureLedger: {
      disclosed: [
        'name Maya / yoga',
        'goal: answer questions + collect name and preferred time',
        'private lessons $70/60min',
        'hours Mon–Fri 9–5',
        'Austin',
        'intake: name and preferred time',
      ],
    },
    extractedDraft: draft,
    expectHint:
      'Owner dumped facts in one message. Draft should reflect business, goal, price, hours, and intake without inventing extras. Few clarifying questions OK.',
    turnRefs: [ownerRef, builderRef],
  });

  await recordUx('builder.dump_upfront.ux', {
    userMessage: dump,
    outputText: r.reply,
    turnRefs: [ownerRef, builderRef],
  });
}

async function scenarioVagueGoal() {
  const id = 'vague_goal';
  console.log(`\n=== ${id} ===`);
  const session = await freshSession(id);
  const msg = 'I need a bot for my business.';
  const { r, ownerRef, builderRef } = await ownerSay(session, msg, id);
  const draft = loadProfile(session.profilePath).draft || {};

  const goalNull = draft.ownerGoal == null || draft.ownerGoal === '';
  record(
    'builder.vague_goal.owner_goal_not_invented',
    goalNull,
    `ownerGoal=${JSON.stringify(draft.ownerGoal)}`,
    'deterministic',
    { stage: 'deterministic', turnRefs: [ownerRef, builderRef] }
  );

  await recordSemantic('builder.vague_goal.extraction', {
    outputText: `${r.reply}\n\nDRAFT:${JSON.stringify(draft)}`,
    disclosureLedger: {
      disclosed: ['Owner only said they need a bot; no business details or goal yet'],
      explicitUnknowns: ['desired outcome for the bot', 'what the business does'],
    },
    extractedDraft: draft,
    expectHint:
      'Owner was vague. Builder should clarify goal/business. ownerGoal must remain null/unset — inventing a specific goal is FAIL.',
    turnRefs: [ownerRef, builderRef],
  });

  await recordUx('builder.vague_goal.ux', {
    userMessage: msg,
    outputText: r.reply,
    turnRefs: [ownerRef, builderRef],
  });
}

async function scenarioUnsupported() {
  const id = 'unsupported_request';
  console.log(`\n=== ${id} ===`);
  const session = await freshSession(id);
  // Seed a little context so unsupported is about capability not identity
  await ownerSay(
    session,
    'I run a dog-walking business. I want the bot to help with customer questions.',
    id
  );
  const msg =
    'Can the bot sync to my Google Calendar and take credit card payments for walks?';
  const { r, ownerRef, builderRef } = await ownerSay(session, msg, id);

  const lower = (r.reply || '').toLowerCase();
  const refuses =
    /not (available|supported)|can't|cannot|doesn't support|do not support|isn't available|is not available/i.test(
      r.reply || ''
    );
  const claimsCapability =
    /i('ll| will) (sync|book|charge|process payment)|calendar (is|will be) connected|payments? (are|will be) (enabled|set up)/i.test(
      lower
    );
  const offersAlt =
    /answer|question|collect|message the owner|approved fact|chat/i.test(lower);
  record(
    'builder.unsupported_request.no_false_capability',
    refuses && !claimsCapability && offersAlt,
    `refuses=${refuses} claims=${claimsCapability} alt=${offersAlt}`,
    'deterministic',
    { stage: 'deterministic', turnRefs: [ownerRef, builderRef] }
  );

  await recordSemantic('builder.unsupported_request.extraction', {
    outputText: r.reply,
    disclosureLedger: {
      disclosed: [
        'dog-walking business',
        'wants help with customer questions',
        'asked for Google Calendar sync and credit card payments',
      ],
    },
    extractedDraft: loadProfile(session.profilePath).draft,
    expectHint:
      'Must NOT claim calendar sync or payments exist. Must explain unsupported and offer in-scope alternative (answer facts / collect details / suggest messaging owner). Must NOT claim inquiries are saved or delivered.',
    turnRefs: [ownerRef, builderRef],
  });

  await recordUx('builder.unsupported_request.ux', {
    userMessage: msg,
    outputText: r.reply,
    turnRefs: [ownerRef, builderRef],
  });
}

async function scenarioChangeDirection() {
  const id = 'change_direction';
  console.log(`\n=== ${id} ===`);
  const session = await freshSession(id);
  const first =
    'I teach private yoga in Austin. Goal: answer class questions. Lessons $70/hour.';
  const { ownerRef: o1, builderRef: b1 } = await ownerSay(session, first, id);

  const second =
    "Actually scratch yoga — I'm pivoting to meal-prep delivery. The bot should answer about weekly menus and collect name and delivery neighborhood. Forget the yoga lessons.";
  const { r, ownerRef: o2, builderRef: b2 } = await ownerSay(session, second, id);
  const draft = loadProfile(session.profilePath).draft || {};

  const servicesBlob = JSON.stringify(draft.services || []).toLowerCase();
  const what = `${draft.whatWeDo || ''} ${draft.name || ''}`.toLowerCase();
  const followsMeal =
    /meal|prep|menu|delivery|food/i.test(what + servicesBlob) ||
    /meal|menu|delivery/i.test(draft.ownerGoal || '');
  const yogaDominant =
    /yoga/i.test(servicesBlob) &&
    !(draft.services || []).some((s) =>
      /meal|prep|menu|delivery/i.test(`${s.name} ${s.notes || ''}`)
    ) &&
    /yoga/i.test(what) &&
    !/meal|prep|delivery/i.test(what);
  record(
    'builder.change_direction.draft_follows_new',
    followsMeal && !yogaDominant,
    `whatWeDo=${draft.whatWeDo} goal=${draft.ownerGoal} services=${servicesBlob}`,
    'deterministic',
    { stage: 'deterministic', turnRefs: [o1, b1, o2, b2] }
  );

  await recordSemantic('builder.change_direction.extraction', {
    outputText: `${r.reply}\n\nDRAFT:${JSON.stringify(draft)}`,
    disclosureLedger: {
      disclosed: [
        'Initially yoga then pivoted to meal-prep delivery',
        'Bot should answer weekly menus',
        'Collect name and delivery neighborhood',
        'Yoga lessons no longer apply',
      ],
      corrections: ['Dropped yoga offering in favor of meal-prep'],
    },
    extractedDraft: draft,
    expectHint:
      'After direction change, draft should reflect meal-prep / menus — not leave yoga as the sole active offering story. ownerGoal should match the new direction if stated.',
    turnRefs: [o2, b2],
  });

  await recordUx('builder.change_direction.ux', {
    scope: 'overall',
    transcript: channelTranscript('BUILD')
      .filter((row) => row.businessId === id)
      .map((row) => ({ role: row.role, text: row.text })),
    outputText: r.reply,
    turnRefs: [o1, b1, o2, b2],
  });
}

async function main() {
  console.log('=== e2e Builder experience (4 scenarios) ===');
  console.log(`Judge mode: ${resolveJudgeMode()}`);

  if (!process.env.OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY missing — skipping Builder AI evaluations.');
    record(
      'builder.experience.skipped_no_openai',
      true,
      'No OPENAI_API_KEY; scenarios not run',
      'app',
      { stage: 'deterministic' }
    );
    const out = collector.write();
    console.log('Results:', out);
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

  const uxCal = await runUxCalibration(judgeUx);
  collector.setUxCalibration({
    ok: uxCal.ok,
    failures: uxCal.failures,
    judgeMode: uxCal.judgeMode,
    judgeModel: uxCal.judgeModel,
  });
  if (!uxCal.ok) {
    uxJudgeUnreliable = true;
    console.warn('UX calibration failed — UX marked unreliable/skip');
  }

  await scenarioDumpUpfront();
  await scenarioVagueGoal();
  await scenarioUnsupported();
  await scenarioChangeDirection();

  const failed = results.filter((x) => !x.pass);
  const out = collector.write();
  console.log(`\n${results.length} checks, ${failed.length} failed`);
  console.log('Results written:', out);
  if (failed.length) {
    console.error(
      'Failed:',
      failed.map((f) => f.name).join(', ')
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
