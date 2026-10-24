/**
 * Adaptive Tester-as-Owner E2E (real /api/chat + Flowise only).
 * Does NOT use approveSeed or direct Flowise predict.
 *
 * Isolation: backs up data/business-profile.json before runs and restores
 * afterward so a manually created profile is not left deleted.
 * Each fixture uses sessionKey=fixture.id → data/test-profiles/<id>.json
 *
 * Env:
 *   OWNER_TURN_LIMIT=20
 *   ADAPTIVE_BUSINESS=yoga-teacher   (optional single business)
 *   ADAPTIVE_CONCURRENCY=2           (parallel businesses; default 2)
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createResultsCollector,
  resolveJudgeMode,
} from '../src/judge.js';
import { runCalibration } from '../src/judgeCalibration.js';
import { judgeSemantic } from '../src/judge.js';
import { judgeUx, UX_JUDGE_VERSION } from '../src/judgeUx.js';
import { runUxCalibration } from '../src/judgeUxCalibration.js';
import { loadAllFixtures, redactSecrets } from '../src/fixtures.js';
import {
  runAdaptiveBusiness,
  health,
} from '../src/adaptiveRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROFILE_PATH = path.join(ROOT, 'data', 'business-profile.json');
const TEST_PROFILES_DIR = path.join(ROOT, 'data', 'test-profiles');
const BACKUP_DIR = path.join(ROOT, 'data', 'test-isolation');
const BACKUP_PATH = path.join(BACKUP_DIR, 'manual-profile-backup.json');

const results = [];
const collector = createResultsCollector('e2e-adaptive', {
  pathLabels: {
    adaptive: true,
    seeded: false,
    directFlowise: false,
    realAppChat: true,
  },
});
let judgeUnreliable = false;
let uxJudgeUnreliable = false;

function adaptiveConcurrency(fixtureCount) {
  const n = Number(process.env.ADAPTIVE_CONCURRENCY || 2);
  const parsed = Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
  return Math.min(parsed, fixtureCount);
}

/**
 * Run items with limited concurrency; results preserve input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

function record(name, pass, detail, source, extra = {}) {
  const safeDetail = redactSecrets(detail);
  results.push({ name, pass, detail: safeDetail, source, ...extra });
  console.log(`${pass ? 'PASS' : 'FAIL'} [${source}] ${name}: ${safeDetail}`);
  if (extra.judge) {
    collector.add({
      name,
      stage: extra.stage || 'business_bot_answer',
      pass,
      detail: safeDetail,
      source,
      question: extra.question,
      outputText: extra.outputText
        ? redactSecrets(extra.outputText)
        : undefined,
      expected: extra.expected,
      actual: extra.actual ? redactSecrets(String(extra.actual)) : undefined,
      turnRefs: extra.turnRefs,
      repairOf: extra.repairOf,
      businessId: extra.businessId,
      evaluationDetail: extra.evaluationDetail,
      disclosureLedger: extra.disclosureLedger,
      ...extra.judge,
    });
  } else {
    collector.add({
      name,
      stage: extra.stage || 'deterministic',
      pass,
      detail: safeDetail,
      source,
      verdict: pass ? 'PASS' : 'FAIL',
      mode: 'deterministic',
      model: null,
      expected: extra.expected,
      actual: extra.actual,
      turnRefs: extra.turnRefs,
      repairOf: extra.repairOf,
      businessId: extra.businessId,
      evaluationDetail: extra.evaluationDetail,
    });
  }
}

function backupManualProfile() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(PROFILE_PATH)) {
    fs.copyFileSync(PROFILE_PATH, BACKUP_PATH);
    console.log(`Backed up profile → ${BACKUP_PATH}`);
    return true;
  }
  if (fs.existsSync(BACKUP_PATH)) fs.unlinkSync(BACKUP_PATH);
  console.log('No existing profile to back up.');
  return false;
}

function restoreManualProfile() {
  if (fs.existsSync(BACKUP_PATH)) {
    fs.mkdirSync(path.dirname(PROFILE_PATH), { recursive: true });
    fs.copyFileSync(BACKUP_PATH, PROFILE_PATH);
    console.log(`Restored manual profile ← ${BACKUP_PATH}`);
  } else {
    // Leave whatever the last test wrote; no prior manual profile
    console.log('No backup to restore (no prior manual profile).');
  }
}

function cleanTestProfiles(fixtureIds) {
  fs.mkdirSync(TEST_PROFILES_DIR, { recursive: true });
  for (const id of fixtureIds) {
    const p = path.join(TEST_PROFILES_DIR, `${id}.json`);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`Cleared test profile → ${p}`);
    }
  }
}

function finalizeBusinessMeta(fixture, meta) {
  // Preserved pre-repair failures stay FAIL in the report but do not fail the
  // business if a later repair of the same check family succeeded.
  const repairedIds = new Set(
    results
      .filter(
        (x) =>
          x.name.startsWith(`${fixture.id}.`) &&
          x.repairOf &&
          x.pass !== false
      )
      .map((x) => x.repairOf)
  );
  const bizFails = results.filter((x) => {
    if (!x.name.startsWith(`${fixture.id}.`) || x.pass) return false;
    if (repairedIds.has(x.name)) return false;
    // Also ignore superseded fidelity_check_rN when a later rM passed
    const m = x.name.match(/\.fidelity_check_r(\d+)$/);
    if (m) {
      const laterPass = results.some(
        (y) =>
          y.name.startsWith(`${fixture.id}.fidelity_check_r`) &&
          y.pass &&
          Number(y.name.match(/_r(\d+)$/)?.[1] || -1) > Number(m[1])
      );
      if (laterPass) return false;
    }
    return true;
  });
  if (meta.status === 'running' || meta.status === 'passed') {
    meta.status = bizFails.length ? 'failed' : 'passed';
  }
  console.log(
    `Business ${fixture.id}: status=${meta.status} turns=${meta.turnsUsed} repairs=${meta.repairs} unresolvedFails=${bizFails.length}`
  );
  return meta;
}

async function main() {
  console.log('=== e2e adaptive (Tester-as-Owner) ===');
  console.log(`Judge mode: ${resolveJudgeMode()}`);

  const fixtures = loadAllFixtures(process.env.ADAPTIVE_BUSINESS || null);
  const concurrency = adaptiveConcurrency(fixtures.length);
  console.log(
    `OWNER_TURN_LIMIT=${process.env.OWNER_TURN_LIMIT || 20} ADAPTIVE_BUSINESS=${process.env.ADAPTIVE_BUSINESS || '(all)'} ADAPTIVE_CONCURRENCY=${concurrency}`
  );

  const hadBackup = backupManualProfile();
  cleanTestProfiles(fixtures.map((f) => f.id));

  try {
    collector.setUxJudgeVersion(UX_JUDGE_VERSION);

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

    const uxCal = await runUxCalibration(judgeUx);
    collector.setUxCalibration({
      ok: uxCal.ok,
      failures: uxCal.failures,
      judgeMode: uxCal.judgeMode,
      judgeModel: uxCal.judgeModel,
      uxJudgeVersion: uxCal.uxJudgeVersion,
    });
    if (!uxCal.ok) {
      uxJudgeUnreliable = true;
      console.warn(
        'UX CALIBRATION FAILED — UX judge results marked unreliable (will not fail run):',
        uxCal.failures.map((f) => f.id).join(', ')
      );
    } else {
      console.log('UX calibration OK.');
    }

    const h = await health();
    record('health.openai', !!h.openai, String(h.openai), 'app');
    record('health.flowise', !!h.flowise, String(h.flowise), 'real-flowise');
    if (!h.openai || !h.flowise) {
      throw new Error('Need OpenAI + Flowise before adaptive e2e');
    }

    const businessSummaries = await mapPool(
      fixtures,
      concurrency,
      async (fixture) => {
        console.log(`\n--- business: ${fixture.id} (${fixture.displayName}) ---`);
        const meta = await runAdaptiveBusiness({
          fixture,
          collector,
          judgeUnreliable,
          uxJudgeUnreliable,
          record,
        });
        return finalizeBusinessMeta(fixture, meta);
      }
    );

    collector.setBusinesses(businessSummaries);
    collector.setPathLabels({
      adaptive: true,
      seeded: false,
      directFlowise: false,
      realAppChat: true,
    });

    const out = collector.write();
    console.log(`\nResults → ${out}`);
    if (collector.lastStamp) console.log(`Stamp → ${collector.lastStamp}`);
    console.log('Viewer → http://localhost:3080/results.html');

    const { finalizeEvaluationRun, EVALUATION_UNRELIABLE } = await import(
      '../src/judge.js'
    );
    const fin = finalizeEvaluationRun({
      entries: results,
      judgeUnreliable,
      uxJudgeUnreliable,
    });
    collector.meta.runStatus = fin.runStatus;
    collector.meta.incomplete = fin.incomplete;
    collector.meta.evaluationUnreliable =
      fin.runStatus === EVALUATION_UNRELIABLE;

    console.log('\n=== SUMMARY ===');
    for (const line of fin.summaryLines) console.log(line);
    const unresolvedBiz = businessSummaries.filter(
      (b) => b.status === 'failed' || b.status === 'incomplete'
    );
    console.log(
      `Total ${results.length}, productFailures=${fin.productFailures.length}, unreliable=${fin.unreliableChecks.length}, unresolvedBusinesses=${unresolvedBiz.length}`
    );
    for (const b of businessSummaries) {
      console.log(` - ${b.id}: ${b.status} (turns=${b.turnsUsed}, repairs=${b.repairs})`);
    }
    for (const f of fin.productFailures) {
      console.log(' - PRODUCT FAIL', f.name, f.detail);
    }
    if (fin.exitCode !== 0 || unresolvedBiz.length) {
      process.exitCode = 1;
    } else {
      console.log('All adaptive businesses resolved (preserved pre-repair fails OK).');
    }
  } finally {
    cleanTestProfiles(fixtures.map((f) => f.id));
    restoreManualProfile();
    void hadBackup;
  }
}

main().catch((err) => {
  console.error('ADAPTIVE E2E FAILED:', err);
  try {
    restoreManualProfile();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
