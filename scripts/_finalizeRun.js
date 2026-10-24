/**
 * Shared e2e/calib exit helper: EVALUATION_UNRELIABLE vs product failure.
 */
import {
  finalizeEvaluationRun,
  EVALUATION_UNRELIABLE,
} from '../src/judge.js';

/**
 * @param {object} opts
 * @param {Array} opts.results — suite result rows with pass/unreliable
 * @param {ReturnType<import('../src/judge.js').createResultsCollector>} [opts.collector]
 * @param {boolean} opts.judgeUnreliable
 * @param {boolean} opts.uxJudgeUnreliable
 * @param {(name:string, pass:boolean, detail:string, source:string, extra?:object)=>void} [opts.record]
 */
export function finishSuiteRun({
  results,
  collector,
  judgeUnreliable = false,
  uxJudgeUnreliable = false,
  record,
} = {}) {
  const fin = finalizeEvaluationRun({
    entries: results,
    judgeUnreliable,
    uxJudgeUnreliable,
  });

  if (collector?.meta) {
    collector.meta.runStatus = fin.runStatus;
    collector.meta.incomplete = fin.incomplete;
    collector.meta.evaluationUnreliable = fin.runStatus === EVALUATION_UNRELIABLE;
  }

  if (typeof record === 'function') {
    if (judgeUnreliable || uxJudgeUnreliable) {
      record(
        'evaluation.reliability',
        false,
        fin.summaryLines.join(' '),
        'evaluator',
        {
          stage: 'evaluation',
          evaluationStatus: EVALUATION_UNRELIABLE,
          unreliable: true,
          pass: false,
          verdict: EVALUATION_UNRELIABLE,
        }
      );
    }
  }

  console.log('\n=== SUMMARY ===');
  for (const line of fin.summaryLines) console.log(line);
  console.log(
    `Total checks ${results.length}, product failures ${fin.productFailures.length}, unreliable ${fin.unreliableChecks.length}`
  );
  for (const f of fin.productFailures) {
    console.log(' - PRODUCT FAIL', f.name, f.detail || f.rationale || '');
  }
  for (const u of fin.unreliableChecks) {
    if (u.name === 'evaluation.reliability') continue;
    console.log(' - UNRELIABLE (not product)', u.name, u.detail || u.rationale || '');
  }

  if (collector?.write) {
    const out = collector.write();
    console.log(`Results → ${out}`);
  }

  if (fin.exitCode !== 0) {
    process.exit(fin.exitCode);
  }
  console.log(
    fin.runStatus === 'COMPLETE'
      ? 'All checks passed.'
      : `Exiting with status ${fin.runStatus}.`
  );
}
