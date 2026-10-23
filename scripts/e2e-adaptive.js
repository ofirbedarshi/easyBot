/**
 * Adaptive Tester-as-Owner E2E (real /api/chat + Flowise only).
 * Does NOT use approveSeed or direct Flowise predict.
 *
 * Isolation: backs up data/business-profile.json before runs and restores
 * afterward so a manually created profile is not left deleted.
 *
 * Env:
 *   OWNER_TURN_LIMIT=20
 *   ADAPTIVE_BUSINESS=yoga-teacher   (optional single business)
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
import { loadAllFixtures, redactSecrets } from '../src/fixtures.js';
import {
  runAdaptiveBusiness,
  health,
} from '../src/adaptiveRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PROFILE_PATH = path.join(ROOT, 'data', 'business-profile.json');
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

async function main() {
  console.log('=== e2e adaptive (Tester-as-Owner) ===');
  console.log(`Judge mode: ${resolveJudgeMode()}`);
  console.log(
    `OWNER_TURN_LIMIT=${process.env.OWNER_TURN_LIMIT || 20} ADAPTIVE_BUSINESS=${process.env.ADAPTIVE_BUSINESS || '(all)'}`
  );

  const hadBackup = backupManualProfile();

  try {
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

    const h = await health();
    record('health.openai', !!h.openai, String(h.openai), 'app');
    record('health.flowise', !!h.flowise, String(h.flowise), 'real-flowise');
    if (!h.openai || !h.flowise) {
      throw new Error('Need OpenAI + Flowise before adaptive e2e');
    }

    const fixtures = loadAllFixtures(process.env.ADAPTIVE_BUSINESS || null);
    const businessSummaries = [];

    for (const fixture of fixtures) {
      console.log(`\n--- business: ${fixture.id} (${fixture.displayName}) ---`);
      const meta = await runAdaptiveBusiness({
        fixture,
        collector,
        judgeUnreliable,
        record,
      });
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
      businessSummaries.push(meta);
      console.log(
        `Business ${fixture.id}: status=${meta.status} turns=${meta.turnsUsed} repairs=${meta.repairs} unresolvedFails=${bizFails.length}`
      );
    }

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

    console.log('\n=== SUMMARY ===');
    const unresolvedBiz = businessSummaries.filter(
      (b) => b.status === 'failed' || b.status === 'incomplete'
    );
    const allFails = results.filter((x) => !x.pass);
    console.log(
      `Total ${results.length}, recordedFails=${allFails.length} (includes preserved pre-repair), unresolvedBusinesses=${unresolvedBiz.length}`
    );
    for (const b of businessSummaries) {
      console.log(` - ${b.id}: ${b.status} (turns=${b.turnsUsed}, repairs=${b.repairs})`);
    }
    if (judgeUnreliable) {
      console.log('Note: judge calibration failed — semantic checks unreliable/REVIEW.');
    }
    for (const f of allFails) console.log(' -', f.name, f.detail);
    if (unresolvedBiz.length) process.exitCode = 1;
    else console.log('All adaptive businesses resolved (preserved pre-repair fails OK).');
  } finally {
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
