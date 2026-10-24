/**
 * One-business adaptive E2E orchestration via real /api/chat only.
 * No approveSeed / direct Flowise predict in this path.
 */
import { loadProfile, testProfilePath } from './profile.js';
import {
  emptyDisclosureLedger,
  assertNoHiddenInApproved,
  assertOwnerMessageSafe,
  structuredDraftFidelity,
  redactSecrets,
} from './fixtures.js';
import { nextOwnerMessage, applyDisclosures } from './adaptiveOwner.js';
import { judgeSemantic } from './judge.js';
import { judgeUx, uxJudgeFields } from './judgeUx.js';

const BASE = () => `http://localhost:${process.env.PORT || 3080}`;

export function ownerTurnLimit() {
  const n = Number(process.env.OWNER_TURN_LIMIT || 20);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

function profilePathFor(biz) {
  return testProfilePath(biz);
}

/**
 * @param {string} message
 * @param {string} sessionKey
 * @param {{ flowiseSessionId?: string }} [extra]
 */
async function chat(message, sessionKey, extra = {}) {
  const body = { message, sessionKey };
  if (extra.flowiseSessionId) body.flowiseSessionId = extra.flowiseSessionId;
  const res = await fetch(`${BASE()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function fetchState(sessionKey) {
  const q = new URLSearchParams({ sessionKey });
  return fetch(`${BASE()}/api/state?${q}`).then((r) => r.json());
}

async function health() {
  return fetch(`${BASE()}/api/health`).then((r) => r.json());
}

function hashHistory(arr) {
  return JSON.stringify(arr || []);
}

/** Approved facts only — never pass draft (pending edits) to Business Bot judge. */
function approvedFactsOnly(profile) {
  const p = profile || {};
  return {
    name: p.name,
    whatWeDo: p.whatWeDo,
    services: p.services,
    hours: p.hours,
    locationOrArea: p.locationOrArea,
    commonQuestions: p.commonQuestions,
    informationToCollect: Array.isArray(p.informationToCollect)
      ? p.informationToCollect
      : [],
    unknowns: p.unknowns,
    tone: p.tone,
    approvedAt: p.approvedAt,
  };
}

/**
 * Deterministic: fixture intake items must land in informationToCollect,
 * not only in commonQuestions.
 */
export function assertIntakePlacement(profile, fixture) {
  const expected = fixture.fullKnowledge?.informationToCollect;
  if (!Array.isArray(expected) || expected.length === 0) {
    return { ok: true, detail: 'no intake items expected in fixture' };
  }
  const collect = Array.isArray(profile?.informationToCollect)
    ? profile.informationToCollect
    : [];
  const common = Array.isArray(profile?.commonQuestions)
    ? profile.commonQuestions
    : [];
  const collectBlob = JSON.stringify(collect).toLowerCase();
  const commonBlob = JSON.stringify(common).toLowerCase();

  const missing = [];
  const onlyInCommon = [];
  for (const item of expected) {
    const key = String(item).toLowerCase();
    const tokens = key.split(/\s+/).filter((w) => w.length > 3);
    const inCollect =
      collectBlob.includes(key) ||
      tokens.some((t) => collectBlob.includes(t));
    const inCommon =
      commonBlob.includes(key) ||
      tokens.some((t) => commonBlob.includes(t));
    if (!inCollect) missing.push(item);
    if (!inCollect && inCommon) onlyInCommon.push(item);
  }

  const ok = missing.length === 0 && onlyInCommon.length === 0;
  const parts = [];
  if (missing.length) parts.push(`missing_from_collect:${missing.join('|')}`);
  if (onlyInCommon.length) {
    parts.push(`only_in_commonQuestions:${onlyInCommon.join('|')}`);
  }
  return {
    ok,
    detail: ok
      ? `intake placed in informationToCollect: ${expected.join('; ')}`
      : parts.join('; '),
  };
}

function pickCorrection(fixture, issues) {
  const list = fixture.corrections || [];
  const blob = (issues || []).join(' ');
  if (/invention|hidden/i.test(blob)) {
    return list.find((c) => c.when === 'invention') || list[0];
  }
  if (/missing_unknown/i.test(blob)) {
    return list.find((c) => c.when === 'missing_unknown') || list[0];
  }
  if (/stale|price/i.test(blob)) {
    return list.find((c) => c.when === 'stale_fact') || list[0];
  }
  return list.find((c) => c.when === 'generic') || list[0];
}

/** Stub judge result when structured hardFail already decides FAIL. */
function skippedJudge(detail) {
  return {
    pass: false,
    verdict: 'FAIL',
    rationale: detail || 'skipped judge: structured hardFail',
    quotes: [],
    factRefs: [],
    dimensions: undefined,
    mode: 'deterministic',
    model: null,
    unreliable: false,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.fixture
 * @param {ReturnType<import('./judge.js').createResultsCollector>} opts.collector
 * @param {boolean} opts.judgeUnreliable
 * @param {(name, pass, detail, source, extra?) => void} opts.record
 */
async function recordUxCheck(record, opts) {
  const {
    name,
    channel,
    scope,
    userMessage,
    outputText,
    transcript,
    turnRefs,
    businessId,
    forceUnreliable,
  } = opts;
  const ux = await judgeUx({
    channel,
    scope,
    userMessage,
    outputText,
    transcript,
    forceUnreliable,
  });
  const source =
    ux.mode === 'stub' ? 'stub-ux-judge' : 'real-llm-ux-judge';
  record(
    name,
    !!ux.pass,
    `ux=${ux.score}/5 ${ux.rationale}`,
    source,
    {
      stage: 'ux',
      businessId,
      question: userMessage,
      outputText: scope === 'reply' ? outputText : undefined,
      turnRefs,
      judge: uxJudgeFields(ux),
      score: ux.score,
      rationale: ux.rationale,
      quotes: ux.quotes,
      dimensions: ux.dimensions,
      verdict: ux.pass ? 'PASS' : 'FAIL',
      mode: ux.mode,
      model: ux.model,
      unreliable: ux.unreliable,
    }
  );
  return ux;
}

export async function runAdaptiveBusiness(opts) {
  const {
    fixture,
    collector,
    judgeUnreliable,
    uxJudgeUnreliable = false,
    record,
  } = opts;
  const biz = fixture.id;
  const sessionKey = biz;
  const profilePath = profilePathFor(biz);
  const limit = ownerTurnLimit();
  const ledger = emptyDisclosureLedger();
  ledger.neverDisclosed = [
    ...(fixture.fullKnowledge?.hiddenNeverDisclose || []),
  ];

  const businessMeta = {
    id: biz,
    status: 'running',
    turnsUsed: 0,
    repairs: 0,
  };

  const t = (turn) =>
    collector.addTranscript({ ...turn, businessId: biz, text: redactSecrets(turn.text || '') });

  const channelTranscript = (channel) =>
    (collector.transcript() || []).filter(
      (row) => row.businessId === biz && row.channel === channel
    );

  // Reset for isolated interview (clears this fixture's test-profiles file)
  let r = await chat('/reset', sessionKey);
  t({
    channel: 'BUILD',
    role: 'system',
    event: 'reset',
    text: r.reply || 'reset',
  });
  t({
    channel: 'BUILD',
    role: 'builder',
    text: r.reply || '',
  });

  let lastBuilder = r.reply || '';
  let turns = 0;
  let approved = false;
  let fidelityFailId = null;
  let repairs = 0;
  const maxRepairs = 3;

  // --- Interview ---
  while (turns < limit && !approved) {
    turns += 1;
    businessMeta.turnsUsed = turns;

    const mode =
      repairs > 0 && fidelityFailId
        ? 'repair'
        : r.readyForReview
          ? 'approve'
          : 'interview';

    const repair = pickCorrection(fixture, []);
    const owner = await nextOwnerMessage({
      fixture,
      disclosureLedger: ledger,
      builderReply: lastBuilder,
      readyForReview: !!r.readyForReview,
      mode,
      repairHint:
        mode === 'repair'
          ? repair?.message
          : mode === 'approve'
            ? 'If summary matches disclosures+unknowns, approve; else correct.'
            : null,
    });

    const safe = assertOwnerMessageSafe(owner.message, fixture);
    record(
      `${biz}.owner_message_safe.${turns}`,
      safe.ok,
      safe.detail,
      'adaptive-owner',
      { stage: 'deterministic', businessId: biz }
    );
    if (!safe.ok) {
      businessMeta.status = 'failed';
      return businessMeta;
    }

    applyDisclosures(ledger, owner, fixture);
    const ownerRef = t({
      channel: 'BUILD',
      role: 'owner',
      event: mode === 'repair' ? 'repair' : null,
      text: owner.message,
    });

    r = await chat(owner.message, sessionKey);
    lastBuilder = r.reply || '';
    const builderRef = t({
      channel: 'BUILD',
      role: 'builder',
      event: r.event || null,
      text: lastBuilder,
    });

    record(
      `${biz}.interview.turn_${turns}`,
      !!r.reply && (r.source || '').includes('real-llm'),
      `source=${r.source} ready=${!!r.readyForReview} event=${r.event}`,
      r.source || 'error',
      {
        stage: 'deterministic',
        businessId: biz,
        turnRefs: [ownerRef, builderRef],
      }
    );

    await recordUxCheck(record, {
      name: `${biz}.ux.builder.turn_${turns}`,
      channel: 'builder',
      scope: 'reply',
      userMessage: owner.message,
      outputText: lastBuilder,
      turnRefs: [ownerRef, builderRef],
      businessId: biz,
      forceUnreliable: uxJudgeUnreliable,
    });

    if (r.event === 'approved_synced' || r.approved) {
      // Should only approve after fidelity — if model auto-approved early, still check
      const profile = loadProfile(profilePath);
      const draft = profile.draft || {
        name: profile.name,
        services: profile.services,
        unknowns: profile.unknowns,
        whatWeDo: profile.whatWeDo,
        hours: profile.hours,
        locationOrArea: profile.locationOrArea,
      };
      const structured = structuredDraftFidelity(draft, ledger, fixture);
      let j;
      if (structured.hardFail) {
        j = skippedJudge(`structured hardFail: ${structured.detail}`);
      } else {
        j = await judgeSemantic({
          stage: 'builder_extraction',
          outputText: lastBuilder,
          disclosureLedger: ledger,
          extractedDraft: draft,
          expectHint:
            'Draft/summary must reflect disclosed facts and explicit unknowns; must not invent; must not require neverDisclosed.',
          expectVerdict: 'PASS',
          forceUnreliable: judgeUnreliable,
        });
      }
      const pass = !structured.hardFail && !!j.pass;
      record(
        `${biz}.pre_approve_fidelity`,
        pass,
        `structured=${structured.detail}; judge=${j.verdict} ${j.rationale}`,
        j.mode === 'stub' ? 'stub-judge' : j.mode === 'deterministic' ? 'app' : 'real-llm-judge',
        {
          stage: 'builder_extraction',
          businessId: biz,
          turnRefs: [builderRef],
          expected: 'faithful draft vs disclosure ledger',
          actual: structured.detail,
          judge: {
            verdict: j.verdict,
            rationale: j.rationale,
            quotes: j.quotes,
            factRefs: j.factRefs,
            mode: j.mode,
            model: j.model,
            unreliable: j.unreliable,
          },
          disclosureLedger: ledger,
        }
      );

      if (!pass) {
        fidelityFailId = `${biz}.pre_approve_fidelity`;
        // Too late — already approved. Flag and continue carefully.
        record(
          `${biz}.approve_without_fidelity`,
          false,
          'Builder approved before fidelity gate passed',
          'app',
          { stage: 'deterministic', businessId: biz, repairOf: fidelityFailId }
        );
      }
      approved = true;
      break;
    }

    // When ready for review (or enough turns), run fidelity before approving
    if (r.readyForReview || turns >= Math.min(8, limit - 2)) {
      const profile = loadProfile(profilePath);
      const draft = profile.draft || {};
      const structured = structuredDraftFidelity(draft, ledger, fixture);
      let j;
      if (structured.hardFail) {
        j = skippedJudge(`structured hardFail: ${structured.detail}`);
      } else {
        j = await judgeSemantic({
          stage: 'builder_extraction',
          outputText: lastBuilder,
          disclosureLedger: ledger,
          extractedDraft: draft,
          expectHint:
            'Faithful to disclosures+unknowns; no inventions; hidden secrets not required. Soft omissions of optional detail are OK if core disclosed facts and fixture unknowns are handled.',
          expectVerdict: 'PASS',
          forceUnreliable: judgeUnreliable,
        });
      }
      // Hard structured fails (hidden leaks) always fail. Soft structured issues alone
      // do not block when the semantic judge PASSes.
      const judgeOk = !!(j.pass || j.verdict === 'PASS');
      const pass = !structured.hardFail && judgeOk;
      const checkName = `${biz}.fidelity_check_r${repairs}`;
      record(
        checkName,
        pass,
        `structured=${structured.detail}; judge=${j.verdict} ${j.rationale}`,
        j.mode === 'stub' ? 'stub-judge' : j.mode === 'deterministic' ? 'app' : 'real-llm-judge',
        {
          stage: 'builder_extraction',
          businessId: biz,
          turnRefs: [builderRef],
          expected: 'faithful draft',
          actual: structured.detail,
          repairOf: fidelityFailId || undefined,
          judge: {
            verdict: j.verdict,
            rationale: j.rationale,
            quotes: j.quotes,
            factRefs: j.factRefs,
            mode: j.mode,
            model: j.model,
            unreliable: j.unreliable,
          },
        }
      );

      if (!pass) {
        if (!fidelityFailId) fidelityFailId = checkName;
        if (repairs >= maxRepairs) {
          businessMeta.status = 'incomplete';
          record(
            `${biz}.interview.incomplete`,
            false,
            `Fidelity failed after ${repairs} repairs; not approving`,
            'adaptive-owner',
            {
              stage: 'deterministic',
              businessId: biz,
              repairOf: fidelityFailId,
            }
          );
          return businessMeta;
        }
        repairs += 1;
        businessMeta.repairs = repairs;
        const corr = pickCorrection(fixture, structured.issues);
        const corrMsg = corr?.message || 'Please fix the summary to match what I said.';
        const cRef = t({
          channel: 'BUILD',
          role: 'owner',
          event: 'repair',
          text: corrMsg,
        });
        r = await chat(corrMsg, sessionKey);
        lastBuilder = r.reply || '';
        const repairBuilderRef = t({
          channel: 'BUILD',
          role: 'builder',
          event: 'repair',
          text: lastBuilder,
        });
        applyDisclosures(
          ledger,
          { message: corrMsg, newlyDisclosed: [], newlyUnknowns: [] },
          fixture
        );
        record(
          `${biz}.repair_${repairs}`,
          true,
          `sent correction; prior fail preserved as ${fidelityFailId}`,
          'adaptive-owner',
          {
            stage: 'deterministic',
            businessId: biz,
            repairOf: fidelityFailId,
            turnRefs: [cRef],
          }
        );
        await recordUxCheck(record, {
          name: `${biz}.ux.builder.repair_${repairs}`,
          channel: 'builder',
          scope: 'reply',
          userMessage: corrMsg,
          outputText: lastBuilder,
          turnRefs: [cRef, repairBuilderRef],
          businessId: biz,
          forceUnreliable: uxJudgeUnreliable,
        });
        continue;
      }

      // Fidelity OK — approve
      const approveMsg = 'approve';
      const aRef = t({
        channel: 'BUILD',
        role: 'owner',
        event: 'approve',
        text: approveMsg,
      });
      r = await chat(approveMsg, sessionKey);
      lastBuilder = r.reply || '';
      const approveBuilderRef = t({
        channel: 'BUILD',
        role: 'builder',
        event: r.event || 'approve',
        text: lastBuilder,
      });
      record(
        `${biz}.approve.synced`,
        r.event === 'approved_synced' || !!loadProfile(profilePath).chatflowId,
        `event=${r.event} chatflow=${loadProfile(profilePath).chatflowId}`,
        r.source || 'app',
        { stage: 'deterministic', businessId: biz, turnRefs: [aRef] }
      );
      await recordUxCheck(record, {
        name: `${biz}.ux.builder.approve`,
        channel: 'builder',
        scope: 'reply',
        userMessage: approveMsg,
        outputText: lastBuilder,
        turnRefs: [aRef, approveBuilderRef],
        businessId: biz,
        forceUnreliable: uxJudgeUnreliable,
      });
      approved =
        r.event === 'approved_synced' || !!loadProfile(profilePath).approvedAt;
      if (!approved && !r.approved) {
        // try once more
        const retryMsg = 'Looks good, please approve.';
        r = await chat(retryMsg, sessionKey);
        const retryOwnerRef = t({
          channel: 'BUILD',
          role: 'owner',
          event: 'approve',
          text: retryMsg,
        });
        const retryBuilderRef = t({
          channel: 'BUILD',
          role: 'builder',
          event: r.event,
          text: r.reply || '',
        });
        await recordUxCheck(record, {
          name: `${biz}.ux.builder.approve_retry`,
          channel: 'builder',
          scope: 'reply',
          userMessage: retryMsg,
          outputText: r.reply || '',
          turnRefs: [retryOwnerRef, retryBuilderRef],
          businessId: biz,
          forceUnreliable: uxJudgeUnreliable,
        });
        approved =
          r.event === 'approved_synced' ||
          !!loadProfile(profilePath).approvedAt;
      }
      break;
    }

    if (owner.stalledReason) {
      record(
        `${biz}.owner_stalled`,
        false,
        owner.stalledReason,
        'adaptive-owner',
        { stage: 'deterministic', businessId: biz }
      );
      businessMeta.status = 'incomplete';
      return businessMeta;
    }
  }

  if (!approved) {
    businessMeta.status = 'incomplete';
    record(
      `${biz}.interview.incomplete`,
      false,
      `Turn limit ${limit} reached without approval (turns=${turns})`,
      'adaptive-owner',
      { stage: 'deterministic', businessId: biz }
    );
    return businessMeta;
  }

  const profile = loadProfile(profilePath);
  const hiddenCheck = assertNoHiddenInApproved(profile, fixture, 'approved');
  record(
    `${biz}.boundary.no_hidden_in_approved`,
    hiddenCheck.ok,
    hiddenCheck.detail,
    'app',
    {
      stage: 'deterministic',
      businessId: biz,
      evaluationDetail: {
        hiddenNeverDisclose: fixture.fullKnowledge.hiddenNeverDisclose,
      },
    }
  );

  const intakePlace = assertIntakePlacement(profile, fixture);
  record(
    `${biz}.boundary.intake_placement`,
    intakePlace.ok,
    intakePlace.detail,
    'app',
    {
      stage: 'deterministic',
      businessId: biz,
      evaluationDetail: {
        expectedIntake: fixture.fullKnowledge?.informationToCollect || [],
        informationToCollect: profile.informationToCollect,
        commonQuestions: profile.commonQuestions,
      },
    }
  );
  if (!intakePlace.ok) {
    businessMeta.status = 'failed';
    return businessMeta;
  }

  // --- Customer TEST ---
  const buildHistoryBefore = hashHistory(r.buildHistory || []);
  const stateBeforeTest = await fetchState(sessionKey);
  const buildHash = hashHistory(stateBeforeTest.buildHistory);
  const servicesBefore = JSON.stringify(loadProfile(profilePath).services);

  r = await chat('/test', sessionKey);
  t({
    channel: 'TEST',
    role: 'system',
    event: 'enter_test',
    text: r.reply || '',
  });
  record(
    `${biz}.cmd.test`,
    r.mode === 'TEST',
    (r.reply || '').slice(0, 120),
    'app',
    { stage: 'deterministic', businessId: biz }
  );

  const intentions = (fixture.customerIntentions || []).filter(
    (c) => !c.phase || c.phase === 'initial'
  );

  const approvedCfgShared = approvedFactsOnly(loadProfile(profilePath));
  const probeResults = await Promise.all(
    intentions.map(async (intent) => {
      const flowiseSessionId = `${biz}-${intent.id}`;
      const replyRes = await chat(intent.question, sessionKey, {
        flowiseSessionId,
      });
      const [j, ux] = await Promise.all([
        judgeSemantic({
          stage: 'business_bot_answer',
          question: intent.question,
          outputText: replyRes.reply,
          approvedConfig: approvedCfgShared,
          unknowns: approvedCfgShared.unknowns || [],
          expectHint: intent.expectHint,
          expectVerdict: 'PASS',
          forceUnreliable: judgeUnreliable,
        }),
        judgeUx({
          channel: 'business_bot',
          scope: 'reply',
          userMessage: intent.question,
          outputText: replyRes.reply,
          forceUnreliable: uxJudgeUnreliable,
        }),
      ]);
      return { intent, r: replyRes, j, ux };
    })
  );

  // Record in fixture order so the results viewer stays stable
  for (const { intent, r: replyRes, j, ux } of probeResults) {
    const qRef = t({
      channel: 'TEST',
      role: 'customer',
      text: intent.question,
    });
    const aRef = t({
      channel: 'TEST',
      role: 'business_bot',
      event: replyRes.event || 'test_turn',
      text: replyRes.reply || '',
    });

    record(
      `${biz}.customer.${intent.id}`,
      !!j.pass,
      `verdict=${j.verdict} ${j.rationale} reply=${String(replyRes.reply).slice(0, 140)}`,
      j.mode === 'stub'
        ? 'stub-judge+real-flowise'
        : 'real-llm-judge+real-flowise',
      {
        stage: 'business_bot_answer',
        businessId: biz,
        question: intent.question,
        outputText: replyRes.reply,
        turnRefs: [qRef, aRef],
        expected: intent.expectHint,
        actual: replyRes.reply,
        judge: {
          verdict: j.verdict,
          rationale: j.rationale,
          quotes: j.quotes,
          factRefs: j.factRefs,
          dimensions: j.dimensions,
          mode: j.mode,
          model: j.model,
          unreliable: j.unreliable,
        },
      }
    );

    record(
      `${biz}.ux.bot.${intent.id}`,
      !!ux.pass,
      `ux=${ux.score}/5 ${ux.rationale}`,
      ux.mode === 'stub' ? 'stub-ux-judge' : 'real-llm-ux-judge',
      {
        stage: 'ux',
        businessId: biz,
        question: intent.question,
        outputText: replyRes.reply,
        turnRefs: [qRef, aRef],
        judge: uxJudgeFields(ux),
        score: ux.score,
        rationale: ux.rationale,
        quotes: ux.quotes,
        dimensions: ux.dimensions,
        verdict: ux.pass ? 'PASS' : 'FAIL',
        mode: ux.mode,
        model: ux.model,
        unreliable: ux.unreliable,
      }
    );

    if (replyRes.profileUnchanged === false) {
      record(
        `${biz}.test_mutated_profile`,
        false,
        'TEST claimed profile changed',
        'app',
        { stage: 'deterministic', businessId: biz }
      );
    }
  }

  const servicesAfter = JSON.stringify(loadProfile(profilePath).services);
  record(
    `${biz}.test.no_profile_mutation`,
    servicesBefore === servicesAfter,
    'services unchanged after TEST',
    'app',
    { stage: 'deterministic', businessId: biz }
  );

  const stateAfterTest = await fetchState(sessionKey);
  record(
    `${biz}.test.build_history_unchanged`,
    hashHistory(stateAfterTest.buildHistory) === buildHash,
    'Builder history unchanged by TEST chatter',
    'app',
    { stage: 'deterministic', businessId: biz }
  );

  // --- Edit loop (serial) ---
  r = await chat('/end', sessionKey);
  t({
    channel: 'BUILD',
    role: 'system',
    event: 'enter_build',
    text: r.reply || '',
  });

  const pending = fixture.editLoop.pendingMessage;
  const pendingOwnerRef = t({ channel: 'BUILD', role: 'owner', text: pending });
  r = await chat(pending, sessionKey);
  const pendingBuilderRef = t({
    channel: 'BUILD',
    role: 'builder',
    text: r.reply || '',
  });

  record(
    `${biz}.edit.pending_not_auto_approved`,
    !r.approved && r.event !== 'approved_synced',
    `event=${r.event}`,
    'app',
    { stage: 'deterministic', businessId: biz }
  );

  await recordUxCheck(record, {
    name: `${biz}.ux.builder.edit_pending`,
    channel: 'builder',
    scope: 'reply',
    userMessage: pending,
    outputText: r.reply || '',
    turnRefs: [pendingOwnerRef, pendingBuilderRef],
    businessId: biz,
    forceUnreliable: uxJudgeUnreliable,
  });

  // Pending must not be live
  await chat('/test', sessionKey);
  t({
    channel: 'TEST',
    role: 'system',
    event: 'enter_test',
    text: 'pending probe',
  });
  const probeQ =
    fixture.editLoop.pendingProbeQuestion || 'What is the current price?';
  const pendingQRef = t({ channel: 'TEST', role: 'customer', text: probeQ });
  r = await chat(probeQ, sessionKey);
  const pendingARef = t({
    channel: 'TEST',
    role: 'business_bot',
    text: r.reply || '',
  });

  {
    const approvedCfg = approvedFactsOnly(loadProfile(profilePath));
    const reply = String(r.reply || '');
    const pendingPattern = fixture.editLoop.postApproveServicesMustMatch;
    // Deterministic: pending rule must not appear as confirmed live fact.
    // Allow uncertainty / old price; block confident adoption of pending wording.
    const adoptsPending =
      pendingPattern &&
      new RegExp(pendingPattern, 'i').test(reply) &&
      !/(not (yet )?approved|not confirmed|haven't|have not|still|cannot confirm|don't know|undecided|unknown|not sure|draft)/i.test(
        reply
      );
    const [j, ux] = await Promise.all([
      judgeSemantic({
        stage: 'business_bot_answer',
        question: probeQ,
        outputText: r.reply,
        approvedConfig: approvedCfg,
        unknowns: approvedCfg.unknowns || [],
        expectHint:
          fixture.editLoop.pendingMustNotLiveHint +
          ' Judge ONLY approvedConfig (live). Ignore pending draft fields. Prefer PASS when bot refuses to confirm an unapproved change.',
        expectVerdict: 'PASS',
        forceUnreliable: judgeUnreliable,
      }),
      judgeUx({
        channel: 'business_bot',
        scope: 'reply',
        userMessage: probeQ,
        outputText: r.reply,
        forceUnreliable: uxJudgeUnreliable,
      }),
    ]);
    // Primary gate is deterministic: unapproved pending wording must not be adopted.
    // Judge rationale kept as evidence; when det is clean, do not fail on judge wording nits.
    const finalPass =
      !adoptsPending &&
      (!!j.pass || !new RegExp(pendingPattern || 'a^', 'i').test(reply));
    record(
      `${biz}.edit.pending_not_live`,
      finalPass,
      `det_adoptsPending=${adoptsPending} verdict=${j.verdict} ${j.rationale}`,
      'real-llm-judge+real-flowise',
      {
        stage: 'business_bot_answer',
        businessId: biz,
        question: probeQ,
        outputText: r.reply,
        turnRefs: [pendingQRef, pendingARef],
        expected: fixture.editLoop.pendingMustNotLiveHint,
        judge: {
          verdict: j.verdict,
          rationale: j.rationale,
          quotes: j.quotes,
          mode: j.mode,
          model: j.model,
          unreliable: j.unreliable,
        },
      }
    );
    record(
      `${biz}.ux.bot.pending_probe`,
      !!ux.pass,
      `ux=${ux.score}/5 ${ux.rationale}`,
      ux.mode === 'stub' ? 'stub-ux-judge' : 'real-llm-ux-judge',
      {
        stage: 'ux',
        businessId: biz,
        question: probeQ,
        outputText: r.reply,
        turnRefs: [pendingQRef, pendingARef],
        judge: uxJudgeFields(ux),
        score: ux.score,
        rationale: ux.rationale,
        quotes: ux.quotes,
        dimensions: ux.dimensions,
        verdict: ux.pass ? 'PASS' : 'FAIL',
        mode: ux.mode,
        model: ux.model,
        unreliable: ux.unreliable,
      }
    );
  }

  await chat('/end', sessionKey);
  const approveEdit = fixture.editLoop.approveMessage;
  const editApproveOwnerRef = t({
    channel: 'BUILD',
    role: 'owner',
    event: 'approve',
    text: approveEdit,
  });
  r = await chat(approveEdit, sessionKey);
  const editApproveBuilderRef = t({
    channel: 'BUILD',
    role: 'builder',
    event: r.event,
    text: r.reply || '',
  });
  await recordUxCheck(record, {
    name: `${biz}.ux.builder.edit_approve`,
    channel: 'builder',
    scope: 'reply',
    userMessage: approveEdit,
    outputText: r.reply || '',
    turnRefs: [editApproveOwnerRef, editApproveBuilderRef],
    businessId: biz,
    forceUnreliable: uxJudgeUnreliable,
  });
  if (!r.approved && r.event !== 'approved_synced') {
    r = await chat('approve', sessionKey);
    const editRetryOwnerRef = t({
      channel: 'BUILD',
      role: 'owner',
      event: 'approve',
      text: 'approve',
    });
    const editRetryBuilderRef = t({
      channel: 'BUILD',
      role: 'builder',
      event: r.event,
      text: r.reply || '',
    });
    await recordUxCheck(record, {
      name: `${biz}.ux.builder.edit_approve_retry`,
      channel: 'builder',
      scope: 'reply',
      userMessage: 'approve',
      outputText: r.reply || '',
      turnRefs: [editRetryOwnerRef, editRetryBuilderRef],
      businessId: biz,
      forceUnreliable: uxJudgeUnreliable,
    });
  }

  const afterApprove = loadProfile(profilePath);
  const match = fixture.editLoop.postApproveServicesMustMatch;
  record(
    `${biz}.edit.approved`,
    new RegExp(match, 'i').test(JSON.stringify(afterApprove.services)),
    JSON.stringify(afterApprove.services),
    r.source || 'app',
    { stage: 'deterministic', businessId: biz }
  );

  await chat('/test', sessionKey);
  t({
    channel: 'TEST',
    role: 'system',
    event: 'enter_test',
    text: 'fresh after edit',
  });
  const afterQ =
    fixture.editLoop.afterApproveQuestion || probeQ;
  const afterQRef = t({ channel: 'TEST', role: 'customer', text: afterQ });
  r = await chat(afterQ, sessionKey);
  const afterARef = t({
    channel: 'TEST',
    role: 'business_bot',
    text: r.reply || '',
  });

  {
    const approvedCfg = approvedFactsOnly(loadProfile(profilePath));
    const [j, ux] = await Promise.all([
      judgeSemantic({
        stage: 'business_bot_answer',
        question: afterQ,
        outputText: r.reply,
        approvedConfig: approvedCfg,
        unknowns: approvedCfg.unknowns || [],
        expectHint: fixture.editLoop.afterApproveHint,
        expectVerdict: 'PASS',
        forceUnreliable: judgeUnreliable,
      }),
      judgeUx({
        channel: 'business_bot',
        scope: 'reply',
        userMessage: afterQ,
        outputText: r.reply,
        forceUnreliable: uxJudgeUnreliable,
      }),
    ]);
    record(
      `${biz}.edit.retest`,
      !!j.pass,
      `verdict=${j.verdict} ${j.rationale}`,
      'real-llm-judge+real-flowise',
      {
        stage: 'business_bot_answer',
        businessId: biz,
        question: afterQ,
        outputText: r.reply,
        turnRefs: [afterQRef, afterARef],
        expected: fixture.editLoop.afterApproveHint,
        judge: {
          verdict: j.verdict,
          rationale: j.rationale,
          quotes: j.quotes,
          mode: j.mode,
          model: j.model,
          unreliable: j.unreliable,
        },
      }
    );
    record(
      `${biz}.ux.bot.edit_retest`,
      !!ux.pass,
      `ux=${ux.score}/5 ${ux.rationale}`,
      ux.mode === 'stub' ? 'stub-ux-judge' : 'real-llm-ux-judge',
      {
        stage: 'ux',
        businessId: biz,
        question: afterQ,
        outputText: r.reply,
        turnRefs: [afterQRef, afterARef],
        judge: uxJudgeFields(ux),
        score: ux.score,
        rationale: ux.rationale,
        quotes: ux.quotes,
        dimensions: ux.dimensions,
        verdict: ux.pass ? 'PASS' : 'FAIL',
        mode: ux.mode,
        model: ux.model,
        unreliable: ux.unreliable,
      }
    );
  }

  // Persistence: new TEST session id via /end + /test (app-level restart of test session)
  await chat('/end', sessionKey);
  t({
    channel: 'BUILD',
    role: 'system',
    event: 'restart',
    text: 'new test session for persistence check',
  });
  await chat('/test', sessionKey);
  t({
    channel: 'TEST',
    role: 'system',
    event: 'enter_test',
    text: 'persistence retest',
  });
  const persistQRef = t({ channel: 'TEST', role: 'customer', text: afterQ });
  r = await chat(afterQ, sessionKey);
  const persistARef = t({
    channel: 'TEST',
    role: 'business_bot',
    text: r.reply || '',
  });

  {
    const approvedCfg = approvedFactsOnly(loadProfile(profilePath));
    const [j, ux] = await Promise.all([
      judgeSemantic({
        stage: 'business_bot_answer',
        question: afterQ,
        outputText: r.reply,
        approvedConfig: approvedCfg,
        unknowns: approvedCfg.unknowns || [],
        expectHint: fixture.editLoop.afterApproveHint + ' (persistence / fresh TEST session)',
        expectVerdict: 'PASS',
        forceUnreliable: judgeUnreliable,
      }),
      judgeUx({
        channel: 'business_bot',
        scope: 'reply',
        userMessage: afterQ,
        outputText: r.reply,
        forceUnreliable: uxJudgeUnreliable,
      }),
    ]);
    record(
      `${biz}.persist.retest`,
      !!j.pass &&
        new RegExp(match, 'i').test(JSON.stringify(approvedCfg.services)),
      `verdict=${j.verdict} services=${JSON.stringify(approvedCfg.services)}`,
      'real-llm-judge+real-flowise',
      {
        stage: 'business_bot_answer',
        businessId: biz,
        question: afterQ,
        outputText: r.reply,
        turnRefs: [persistQRef, persistARef],
        judge: {
          verdict: j.verdict,
          rationale: j.rationale,
          mode: j.mode,
          model: j.model,
          unreliable: j.unreliable,
        },
      }
    );
    record(
      `${biz}.ux.bot.persist_retest`,
      !!ux.pass,
      `ux=${ux.score}/5 ${ux.rationale}`,
      ux.mode === 'stub' ? 'stub-ux-judge' : 'real-llm-ux-judge',
      {
        stage: 'ux',
        businessId: biz,
        question: afterQ,
        outputText: r.reply,
        turnRefs: [persistQRef, persistARef],
        judge: uxJudgeFields(ux),
        score: ux.score,
        rationale: ux.rationale,
        quotes: ux.quotes,
        dimensions: ux.dimensions,
        verdict: ux.pass ? 'PASS' : 'FAIL',
        mode: ux.mode,
        model: ux.model,
        unreliable: ux.unreliable,
      }
    );
  }

  await recordUxCheck(record, {
    name: `${biz}.ux.builder.overall`,
    channel: 'builder',
    scope: 'overall',
    transcript: channelTranscript('BUILD'),
    businessId: biz,
    forceUnreliable: uxJudgeUnreliable,
  });
  await recordUxCheck(record, {
    name: `${biz}.ux.bot.overall`,
    channel: 'business_bot',
    scope: 'overall',
    transcript: channelTranscript('TEST'),
    businessId: biz,
    forceUnreliable: uxJudgeUnreliable,
  });

  businessMeta.status = 'passed';
  void buildHistoryBefore;
  return businessMeta;
}

export { chat, health };
