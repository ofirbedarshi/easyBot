/**
 * Deterministic: blind judge payload structure + pending evidence isolation.
 * No OpenAI calls required for structural checks (uses JUDGE_MODE=stub for strip test).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  approvedEvidence,
  buildSemanticPayload,
  buildUxPayload,
  assertBlindPayload,
  FORBIDDEN_PAYLOAD_KEYS,
  resolveExpected,
} from '../src/judgeEvidence.js';
import { judgeSemantic, JUDGE_VERSION } from '../src/judge.js';
import { judgeUx, UX_JUDGE_VERSION } from '../src/judgeUx.js';
import { CALIBRATION_CASES } from '../src/judgeCalibration.js';
import { UX_CALIBRATION_CASES } from '../src/judgeUxCalibration.js';
import { emptyProfile } from '../src/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}: ${err.message}`);
  }
}

check('semantic calib payloads are blind (structure)', () => {
  for (const c of CALIBRATION_CASES) {
    const evidence = approvedEvidence({
      ...(c.approvedConfig || {}),
      unknowns: c.unknowns ?? c.approvedConfig?.unknowns,
    });
    const payload = buildSemanticPayload({
      stage: c.stage,
      evidence,
      question: c.question,
      priorConversation: c.priorConversation || c.conversationContext,
      outputText: c.outputText,
    });
    assertBlindPayload(payload, { kind: 'semantic' });
    for (const k of FORBIDDEN_PAYLOAD_KEYS) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(payload, k),
        false,
        `${c.id} has forbidden key ${k}`
      );
    }
    // expected.reason text may appear in facts — must NOT fail
    if (c.expectHint && /reason/i.test(JSON.stringify(c.approvedConfig || {}))) {
      // still ok
    }
  }
});

check('UX calib payloads are blind (structure)', () => {
  for (const c of UX_CALIBRATION_CASES) {
    const payload = buildUxPayload({
      channel: c.channel,
      scope: c.scope,
      userMessage: c.userMessage,
      outputText: c.outputText,
      priorConversation: c.priorConversation,
      behaviorSettings: c.behaviorSettings || null,
    });
    assertBlindPayload(payload, { kind: 'ux' });
    for (const k of FORBIDDEN_PAYLOAD_KEYS) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(payload, k),
        false,
        `${c.id} has forbidden key ${k}`
      );
    }
  }
});

check('assertBlindPayload rejects expectHint at top level', () => {
  let threw = false;
  try {
    assertBlindPayload({
      stage: 'business_bot_answer',
      outputUnderTest: 'hi',
      expectHint: 'must PASS',
    });
  } catch {
    threw = true;
  }
  assert.ok(threw, 'expected throw');
});

check('assertBlindPayload allows "reason" inside business fact text', () => {
  assertBlindPayload({
    stage: 'business_bot_answer',
    outputUnderTest: 'ok',
    businessFacts: {
      name: 'Reasonable Rates Co',
      whatWeDo: 'The reason we walk dogs is exercise',
      services: [],
      hours: null,
      locationOrArea: null,
      commonQuestions: [],
    },
    unknowns: [],
    objective: null,
    intakeWhitelist: [],
    behaviorSettings: {
      tone: 'friendly',
      responseLength: 'standard',
      priceDisclosure: 'relevant',
    },
    priorConversation: null,
    question: null,
    disclosureLedger: null,
    extractedDraft: null,
  });
});

check('pending draft never enters approvedEvidence', () => {
  const live = {
    ...emptyProfile(),
    name: 'Live Shop',
    whatWeDo: 'Walks',
    services: [{ name: 'Walk', price: '$10', notes: null }],
    unknowns: [],
    informationToCollect: [],
    tone: 'friendly',
    priceDisclosure: 'relevant',
    responseLength: 'standard',
    approvedAt: '2026-01-01T00:00:00.000Z',
    chatflowId: 'cf-live',
    flowiseSyncOk: true,
    draft: {
      name: 'Pending Shop',
      services: [{ name: 'Walk', price: '$99 pending', notes: null }],
      priceDisclosure: 'on_request',
      responseLength: 'short',
      tone: 'secret pending tone',
    },
  };
  const ev = approvedEvidence(live);
  const blob = JSON.stringify(ev);
  assert.ok(!blob.includes('draft'), 'evidence must not contain draft key/content path');
  assert.ok(!blob.includes('chatflowId'));
  assert.ok(!blob.includes('approvedAt'));
  assert.ok(!blob.includes('flowise'));
  assert.ok(!blob.includes('$99 pending'));
  assert.ok(!blob.includes('secret pending tone'));
  assert.ok(!blob.includes('on_request'));
  assert.strictEqual(ev.behaviorSettings.priceDisclosure, 'relevant');
  assert.ok(blob.includes('$10'));
});

check('approvedEvidence snapshot is isolated from later mutation', () => {
  const live = {
    ...emptyProfile(),
    name: 'Snap',
    services: [{ name: 'A', price: '1', notes: null }],
    unknowns: [],
    informationToCollect: [],
  };
  const ev = approvedEvidence(live);
  live.name = 'Mutated';
  live.services[0].price = '999';
  assert.strictEqual(ev.businessFacts.name, 'Snap');
  assert.strictEqual(ev.businessFacts.services[0].price, '1');
});

check('resolveExpected maps legacy expectHint off the model path', () => {
  const e = resolveExpected({
    expectHint: 'case rationale for humans',
    expectVerdict: 'FAIL',
  });
  assert.strictEqual(e.verdict, 'FAIL');
  assert.strictEqual(e.reason, 'case rationale for humans');
});

await checkAsync('judgeSemantic strips expectHint from model input', async () => {
  const prev = process.env.JUDGE_MODE;
  process.env.JUDGE_MODE = 'stub';
  try {
    const r = await judgeSemantic({
      stage: 'business_bot_answer',
      question: 'How much?',
      outputText: 'Lessons are $70 for 60 minutes.',
      approvedConfig: {
        name: 'Maya',
        services: [{ name: 'Private', price: '$70 for 60 minutes', notes: null }],
        unknowns: [],
      },
      expectHint: 'UNIQUE_EXPECT_HINT_TOKEN_XYZ must never reach the model',
      expectVerdict: 'PASS',
    });
    assert.ok(r.judgeInput?.user);
    const userJson = JSON.stringify(r.judgeInput.user);
    assert.ok(
      !userJson.includes('UNIQUE_EXPECT_HINT_TOKEN_XYZ'),
      'expectHint leaked into model user payload'
    );
    assert.ok(!Object.prototype.hasOwnProperty.call(r.judgeInput.user, 'expectHint'));
    assert.ok(!Object.prototype.hasOwnProperty.call(r.judgeInput.user, 'expectVerdict'));
    assert.ok(!Object.prototype.hasOwnProperty.call(r.judgeInput.user, 'expected'));
    assert.strictEqual(r.expected?.reason?.includes('UNIQUE_EXPECT_HINT_TOKEN_XYZ'), true);
  } finally {
    if (prev == null) delete process.env.JUDGE_MODE;
    else process.env.JUDGE_MODE = prev;
  }
});

await checkAsync('judgeUx payload has no facts or expect metadata', async () => {
  const prev = process.env.JUDGE_MODE;
  process.env.JUDGE_MODE = 'stub';
  try {
    const r = await judgeUx({
      channel: 'business_bot',
      scope: 'reply',
      userMessage: 'Hi',
      outputText: 'Hello from the shop!',
      behaviorSettings: { tone: 'warm', responseLength: 'short', priceDisclosure: 'relevant' },
    });
    assert.ok(r.judgeInput?.user);
    assert.ok(!('businessFacts' in r.judgeInput.user));
    assert.ok(!('expectHint' in r.judgeInput.user));
    assert.ok(!('note' in r.judgeInput.user));
  } finally {
    if (prev == null) delete process.env.JUDGE_MODE;
    else process.env.JUDGE_MODE = prev;
  }
});

check('suite files do not pass expectHint into judgeSemantic/judgeUx', () => {
  const suiteFiles = [
    'scripts/e2e-workflow.js',
    'scripts/e2e-ambiguity.js',
    'scripts/e2e-closed-world.js',
    'scripts/e2e-adaptive.js',
    'scripts/e2e-builder-experience.js',
    'scripts/e2e-behavior-settings.js',
    'src/adaptiveRunner.js',
  ];
  const offenders = [];
  for (const rel of suiteFiles) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Top-level expectHint/expectVerdict inside judgeSemantic({...}) or judgeUx({...})
    const re =
      /judge(?:Semantic|Ux)\(\s*\{([\s\S]*?)\}\s*(?:,|\))/g;
    let m;
    while ((m = re.exec(text))) {
      const body = m[1];
      // Ignore expected: { ... reason: args.expectHint } — look for bare keys
      if (/(^|,|\n)\s*expectHint\s*:/.test(body)) {
        offenders.push(`${rel}: expectHint in judge call`);
      }
      if (/(^|,|\n)\s*expectVerdict\s*:/.test(body)) {
        offenders.push(`${rel}: expectVerdict in judge call`);
      }
    }
  }
  assert.deepStrictEqual(offenders, [], offenders.join('; '));
});

check(`versions are 2.0.1 (sem=${JUDGE_VERSION} ux=${UX_JUDGE_VERSION})`, () => {
  assert.strictEqual(JUDGE_VERSION, '2.0.1');
  assert.strictEqual(UX_JUDGE_VERSION, '2.0.1');
});

await checkAsync('forceUnreliable does not convert UX to pass=true', async () => {
  const prev = process.env.JUDGE_MODE;
  process.env.JUDGE_MODE = 'stub';
  try {
    const { EVALUATION_UNRELIABLE } = await import('../src/judge.js');
    const r = await judgeUx({
      channel: 'business_bot',
      scope: 'reply',
      userMessage: 'Hi',
      outputText: 'Hello from the shop!',
      forceUnreliable: true,
    });
    assert.strictEqual(r.pass, false);
    assert.strictEqual(r.unreliable, true);
    assert.strictEqual(r.evaluationStatus, EVALUATION_UNRELIABLE);
    assert.strictEqual(!!r.skippedUnreliable, false);
  } finally {
    if (prev == null) delete process.env.JUDGE_MODE;
    else process.env.JUDGE_MODE = prev;
  }
});

await checkAsync('finalizeEvaluationRun blocks green on calib fail', async () => {
  const { finalizeEvaluationRun, EVALUATION_UNRELIABLE } = await import(
    '../src/judge.js'
  );
  const fin = finalizeEvaluationRun({
    entries: [
      { name: 'a', pass: true },
      {
        name: 'b',
        pass: false,
        unreliable: true,
        evaluationStatus: EVALUATION_UNRELIABLE,
      },
    ],
    judgeUnreliable: false,
    uxJudgeUnreliable: true,
  });
  assert.strictEqual(fin.runStatus, EVALUATION_UNRELIABLE);
  assert.strictEqual(fin.incomplete, true);
  assert.strictEqual(fin.exitCode, 1);
  assert.strictEqual(fin.productFailures.length, 0);
});


console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
