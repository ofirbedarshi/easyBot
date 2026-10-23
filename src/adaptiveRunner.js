/**
 * One-business adaptive E2E orchestration via real /api/chat only.
 * No approveSeed / direct Flowise predict in this path.
 */
import { loadProfile } from './profile.js';
import {
  emptyDisclosureLedger,
  assertNoHiddenInApproved,
  assertOwnerMessageSafe,
  structuredDraftFidelity,
  redactSecrets,
} from './fixtures.js';
import { nextOwnerMessage, applyDisclosures } from './adaptiveOwner.js';
import { judgeSemantic } from './judge.js';

const BASE = () => `http://localhost:${process.env.PORT || 3080}`;

export function ownerTurnLimit() {
  const n = Number(process.env.OWNER_TURN_LIMIT || 20);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

async function chat(message) {
  const res = await fetch(`${BASE()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  return res.json();
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
    unknowns: p.unknowns,
    tone: p.tone,
    approvedAt: p.approvedAt,
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

/**
 * @param {object} opts
 * @param {object} opts.fixture
 * @param {ReturnType<import('./judge.js').createResultsCollector>} opts.collector
 * @param {boolean} opts.judgeUnreliable
 * @param {(name, pass, detail, source, extra?) => void} opts.record
 */
export async function runAdaptiveBusiness(opts) {
  const { fixture, collector, judgeUnreliable, record } = opts;
  const biz = fixture.id;
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

  // Reset for isolated interview
  let r = await chat('/reset');
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

    r = await chat(owner.message);
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

    if (r.event === 'approved_synced' || r.approved) {
      // Should only approve after fidelity — if model auto-approved early, still check
      const profile = loadProfile();
      const draft = profile.draft || {
        name: profile.name,
        services: profile.services,
        unknowns: profile.unknowns,
        whatWeDo: profile.whatWeDo,
        hours: profile.hours,
        locationOrArea: profile.locationOrArea,
      };
      const structured = structuredDraftFidelity(draft, ledger, fixture);
      const j = await judgeSemantic({
        stage: 'builder_extraction',
        outputText: lastBuilder,
        disclosureLedger: ledger,
        extractedDraft: draft,
        expectHint:
          'Draft/summary must reflect disclosed facts and explicit unknowns; must not invent; must not require neverDisclosed.',
        expectVerdict: 'PASS',
        forceUnreliable: judgeUnreliable,
      });
      const pass = !structured.hardFail && !!j.pass;
      record(
        `${biz}.pre_approve_fidelity`,
        pass,
        `structured=${structured.detail}; judge=${j.verdict} ${j.rationale}`,
        j.mode === 'stub' ? 'stub-judge' : 'real-llm-judge',
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
      const profile = loadProfile();
      const draft = profile.draft || {};
      const structured = structuredDraftFidelity(draft, ledger, fixture);
      const j = await judgeSemantic({
        stage: 'builder_extraction',
        outputText: lastBuilder,
        disclosureLedger: ledger,
        extractedDraft: draft,
        expectHint:
          'Faithful to disclosures+unknowns; no inventions; hidden secrets not required. Soft omissions of optional detail are OK if core disclosed facts and fixture unknowns are handled.',
        expectVerdict: 'PASS',
        forceUnreliable: judgeUnreliable,
      });
      // Hard structured fails (hidden leaks) always fail. Soft structured issues alone
      // do not block when the semantic judge PASSes.
      const judgeOk = !!(j.pass || j.verdict === 'PASS');
      const pass = !structured.hardFail && judgeOk;
      const checkName = `${biz}.fidelity_check_r${repairs}`;
      record(
        checkName,
        pass,
        `structured=${structured.detail}; judge=${j.verdict} ${j.rationale}`,
        j.mode === 'stub' ? 'stub-judge' : 'real-llm-judge',
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
        r = await chat(corrMsg);
        lastBuilder = r.reply || '';
        t({
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
      r = await chat(approveMsg);
      lastBuilder = r.reply || '';
      t({
        channel: 'BUILD',
        role: 'builder',
        event: r.event || 'approve',
        text: lastBuilder,
      });
      record(
        `${biz}.approve.synced`,
        r.event === 'approved_synced' || !!loadProfile().chatflowId,
        `event=${r.event} chatflow=${loadProfile().chatflowId}`,
        r.source || 'app',
        { stage: 'deterministic', businessId: biz, turnRefs: [aRef] }
      );
      approved = r.event === 'approved_synced' || !!loadProfile().approvedAt;
      if (!approved && !r.approved) {
        // try once more
        r = await chat('Looks good, please approve.');
        t({
          channel: 'BUILD',
          role: 'owner',
          event: 'approve',
          text: 'Looks good, please approve.',
        });
        t({
          channel: 'BUILD',
          role: 'builder',
          event: r.event,
          text: r.reply || '',
        });
        approved = r.event === 'approved_synced' || !!loadProfile().approvedAt;
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

  const profile = loadProfile();
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

  // --- Customer TEST ---
  const buildHistoryBefore = hashHistory(r.buildHistory || loadProfile() && []);
  // Prefer state from last response
  const stateBeforeTest = await fetch(`${BASE()}/api/state`).then((x) => x.json());
  const buildHash = hashHistory(stateBeforeTest.buildHistory);
  const servicesBefore = JSON.stringify(loadProfile().services);

  r = await chat('/test');
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

  for (const intent of intentions) {
    const qRef = t({
      channel: 'TEST',
      role: 'customer',
      text: intent.question,
    });
    r = await chat(intent.question);
    const aRef = t({
      channel: 'TEST',
      role: 'business_bot',
      event: r.event || 'test_turn',
      text: r.reply || '',
    });

    const approvedCfg = approvedFactsOnly(loadProfile());
    const j = await judgeSemantic({
      stage: 'business_bot_answer',
      question: intent.question,
      outputText: r.reply,
      approvedConfig: approvedCfg,
      unknowns: approvedCfg.unknowns || [],
      expectHint: intent.expectHint,
      expectVerdict: 'PASS',
      forceUnreliable: judgeUnreliable,
    });

    record(
      `${biz}.customer.${intent.id}`,
      !!j.pass,
      `verdict=${j.verdict} ${j.rationale} reply=${String(r.reply).slice(0, 140)}`,
      j.mode === 'stub'
        ? 'stub-judge+real-flowise'
        : 'real-llm-judge+real-flowise',
      {
        stage: 'business_bot_answer',
        businessId: biz,
        question: intent.question,
        outputText: r.reply,
        turnRefs: [qRef, aRef],
        expected: intent.expectHint,
        actual: r.reply,
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

    if (r.profileUnchanged === false) {
      record(
        `${biz}.test_mutated_profile`,
        false,
        'TEST claimed profile changed',
        'app',
        { stage: 'deterministic', businessId: biz }
      );
    }
  }

  const servicesAfter = JSON.stringify(loadProfile().services);
  record(
    `${biz}.test.no_profile_mutation`,
    servicesBefore === servicesAfter,
    'services unchanged after TEST',
    'app',
    { stage: 'deterministic', businessId: biz }
  );

  const stateAfterTest = await fetch(`${BASE()}/api/state`).then((x) => x.json());
  record(
    `${biz}.test.build_history_unchanged`,
    hashHistory(stateAfterTest.buildHistory) === buildHash,
    'Builder history unchanged by TEST chatter',
    'app',
    { stage: 'deterministic', businessId: biz }
  );

  // --- Edit loop ---
  r = await chat('/end');
  t({
    channel: 'BUILD',
    role: 'system',
    event: 'enter_build',
    text: r.reply || '',
  });

  const pending = fixture.editLoop.pendingMessage;
  t({ channel: 'BUILD', role: 'owner', text: pending });
  r = await chat(pending);
  t({ channel: 'BUILD', role: 'builder', text: r.reply || '' });

  record(
    `${biz}.edit.pending_not_auto_approved`,
    !r.approved && r.event !== 'approved_synced',
    `event=${r.event}`,
    'app',
    { stage: 'deterministic', businessId: biz }
  );

  // Pending must not be live
  await chat('/test');
  t({
    channel: 'TEST',
    role: 'system',
    event: 'enter_test',
    text: 'pending probe',
  });
  const probeQ =
    fixture.editLoop.pendingProbeQuestion || 'What is the current price?';
  t({ channel: 'TEST', role: 'customer', text: probeQ });
  r = await chat(probeQ);
  t({ channel: 'TEST', role: 'business_bot', text: r.reply || '' });

  {
    const approvedCfg = approvedFactsOnly(loadProfile());
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
    const j = await judgeSemantic({
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
    });
    // Primary gate is deterministic: unapproved pending wording must not be adopted.
    // Judge rationale kept as evidence; when det is clean, do not fail on judge wording nits.
    const finalPass = !adoptsPending && (!!j.pass || !new RegExp(pendingPattern || 'a^', 'i').test(reply));
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
  }

  await chat('/end');
  const approveEdit = fixture.editLoop.approveMessage;
  t({
    channel: 'BUILD',
    role: 'owner',
    event: 'approve',
    text: approveEdit,
  });
  r = await chat(approveEdit);
  t({
    channel: 'BUILD',
    role: 'builder',
    event: r.event,
    text: r.reply || '',
  });
  if (!r.approved && r.event !== 'approved_synced') {
    r = await chat('approve');
    t({
      channel: 'BUILD',
      role: 'owner',
      event: 'approve',
      text: 'approve',
    });
    t({
      channel: 'BUILD',
      role: 'builder',
      event: r.event,
      text: r.reply || '',
    });
  }

  const afterApprove = loadProfile();
  const match = fixture.editLoop.postApproveServicesMustMatch;
  record(
    `${biz}.edit.approved`,
    new RegExp(match, 'i').test(JSON.stringify(afterApprove.services)),
    JSON.stringify(afterApprove.services),
    r.source || 'app',
    { stage: 'deterministic', businessId: biz }
  );

  await chat('/test');
  t({
    channel: 'TEST',
    role: 'system',
    event: 'enter_test',
    text: 'fresh after edit',
  });
  const afterQ =
    fixture.editLoop.afterApproveQuestion || probeQ;
  t({ channel: 'TEST', role: 'customer', text: afterQ });
  r = await chat(afterQ);
  t({ channel: 'TEST', role: 'business_bot', text: r.reply || '' });

  {
    const approvedCfg = approvedFactsOnly(loadProfile());
    const j = await judgeSemantic({
      stage: 'business_bot_answer',
      question: afterQ,
      outputText: r.reply,
      approvedConfig: approvedCfg,
      unknowns: approvedCfg.unknowns || [],
      expectHint: fixture.editLoop.afterApproveHint,
      expectVerdict: 'PASS',
      forceUnreliable: judgeUnreliable,
    });
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
  }

  // Persistence: new TEST session id via /end + /test (app-level restart of test session)
  await chat('/end');
  t({
    channel: 'BUILD',
    role: 'system',
    event: 'restart',
    text: 'new test session for persistence check',
  });
  await chat('/test');
  t({
    channel: 'TEST',
    role: 'system',
    event: 'enter_test',
    text: 'persistence retest',
  });
  t({ channel: 'TEST', role: 'customer', text: afterQ });
  r = await chat(afterQ);
  t({ channel: 'TEST', role: 'business_bot', text: r.reply || '' });

  {
    const approvedCfg = approvedFactsOnly(loadProfile());
    const j = await judgeSemantic({
      stage: 'business_bot_answer',
      question: afterQ,
      outputText: r.reply,
      approvedConfig: approvedCfg,
      unknowns: approvedCfg.unknowns || [],
      expectHint: fixture.editLoop.afterApproveHint + ' (persistence / fresh TEST session)',
      expectVerdict: 'PASS',
      forceUnreliable: judgeUnreliable,
    });
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
        judge: {
          verdict: j.verdict,
          rationale: j.rationale,
          mode: j.mode,
          model: j.model,
          unreliable: j.unreliable,
        },
      }
    );
  }

  businessMeta.status = 'passed';
  void buildHistoryBefore;
  return businessMeta;
}

export { chat, health };
