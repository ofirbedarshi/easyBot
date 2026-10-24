/**
 * Calibrate Tester judges on fixed labelled examples.
 * Exit 0 only if all required semantic AND UX cases match.
 * Advisory UX cases are recorded but do not fail calibration.
 * Saves exact judge inputs/outputs for reproducibility.
 */
import 'dotenv/config';
import {
  judgeSemantic,
  createResultsCollector,
  SYSTEM_JUDGE,
  EVALUATION_UNRELIABLE,
  RUN_INCOMPLETE,
} from '../src/judge.js';
import { judgeUx, SYSTEM_UX, UX_JUDGE_VERSION } from '../src/judgeUx.js';
import { runCalibration } from '../src/judgeCalibration.js';
import { runUxCalibration } from '../src/judgeUxCalibration.js';

async function main() {
  console.log('=== judge calibration (semantic + UX) ===');
  const collector = createResultsCollector('calibration', {
    uxJudgeVersion: UX_JUDGE_VERSION,
  });
  collector.setUxSystemPrompt(SYSTEM_UX);

  const cal = await runCalibration(judgeSemantic);
  collector.setCalibration(cal);
  for (const r of cal.results) {
    collector.add({
      name: `calib.${r.id}`,
      stage: 'calibration',
      pass: r.matched,
      verdict: r.gotVerdict,
      expectVerdict: r.expectVerdict,
      expected: r.expected,
      rationale: r.rationale,
      quotes: r.quotes,
      mode: r.mode,
      model: r.model,
      judge: {
        input: r.judgeInput,
        rawOutput: r.rawOutput,
      },
    });
    console.log(
      `${r.matched ? 'PASS' : 'FAIL'} [sem/${r.mode}] ${r.id}: expect=${r.expectVerdict} got=${r.gotVerdict} — ${r.rationale}`
    );
  }

  const uxCal = await runUxCalibration(judgeUx);
  collector.setUxCalibration(uxCal);
  for (const r of uxCal.results) {
    const advisoryNote = r.advisory
      ? ` [advisory; preserved=${JSON.stringify(r.preservedResult?.score)}]`
      : '';
    collector.add({
      name: `ux_calib.${r.id}`,
      stage: 'ux_calibration',
      pass: r.advisory ? true : r.matched,
      advisory: !!r.advisory,
      preservedResult: r.preservedResult || null,
      score: r.gotScore,
      expectPass: r.expectPass,
      matched: r.matched,
      rationale: r.rationale,
      quotes: r.quotes,
      mode: r.mode,
      model: r.model,
      judge: {
        input: r.judgeInput,
        rawOutput: r.rawOutput,
      },
    });
    console.log(
      `${r.matched ? 'PASS' : r.advisory ? 'ADVISORY' : 'FAIL'} [ux/${r.mode}] ${r.id}: expectPass=${r.expectPass} gotPass=${r.gotPass} score=${r.gotScore}${advisoryNote} — ${r.rationale}`
    );
  }

  const pathOut = collector.write();
  console.log(`\nWrote ${pathOut}`);
  console.log(`Semantic system sha present: ${!!SYSTEM_JUDGE}`);

  let failed = false;
  if (!cal.ok) {
    failed = true;
    console.error('\nSemantic calibration FAILED.');
    for (const f of cal.failures) {
      console.error(` - ${f.id}: expect ${f.expect}, got ${f.got}: ${f.rationale}`);
    }
  }
  if (!uxCal.ok) {
    failed = true;
    console.error('\nUX calibration FAILED.');
    for (const f of uxCal.failures) {
      console.error(` - ${f.id}: expect ${f.expect}, got ${f.got}: ${f.rationale}`);
    }
  }

  const advisoryMismatches = uxCal.results.filter((r) => r.advisory && !r.matched);
  if (advisoryMismatches.length) {
    console.log('\nAdvisory UX cases (do not fail calibration):');
    for (const a of advisoryMismatches) {
      console.log(
        ` - ${a.id}: expectPass=${a.expectPass} gotPass=${a.gotPass} score=${a.gotScore}; preserved score=${a.preservedResult?.score}. ${a.preservedResult?.whyFourIsDefensible || ''}`
      );
    }
  }

  if (failed) {
    collector.meta.runStatus = EVALUATION_UNRELIABLE;
    collector.meta.incomplete = true;
    collector.write();
    console.error(
      `\nRUN STATUS: ${EVALUATION_UNRELIABLE} (${RUN_INCOMPLETE}) — calibration failed; evaluations are unreliable until fixed.`
    );
    process.exit(1);
  }
  collector.meta.runStatus = 'COMPLETE';
  collector.meta.incomplete = false;
  collector.write();
  console.log('Calibration OK (semantic + required UX).');
}

main().catch((err) => {
  console.error('CALIBRATION ERROR:', err);
  process.exit(1);
});
