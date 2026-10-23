/**
 * Calibrate Tester judge on fixed labelled examples.
 * Exit 0 only if all cases match expected verdicts.
 */
import 'dotenv/config';
import { judgeSemantic, createResultsCollector } from '../src/judge.js';
import { runCalibration } from '../src/judgeCalibration.js';

async function main() {
  console.log('=== judge calibration ===');
  const collector = createResultsCollector('calibration');
  const cal = await runCalibration(judgeSemantic);
  collector.setCalibration(cal);
  for (const r of cal.results) {
    collector.add({
      name: `calib.${r.id}`,
      stage: 'calibration',
      pass: r.matched,
      verdict: r.gotVerdict,
      expectVerdict: r.expectVerdict,
      rationale: r.rationale,
      quotes: r.quotes,
      mode: r.mode,
      model: r.model,
    });
    console.log(
      `${r.matched ? 'PASS' : 'FAIL'} [${r.mode}] ${r.id}: expect=${r.expectVerdict} got=${r.gotVerdict} — ${r.rationale}`
    );
  }
  const pathOut = collector.write();
  console.log(`\nWrote ${pathOut}`);
  if (!cal.ok) {
    console.error('\nCalibration FAILED — semantic evaluations are unreliable until fixed.');
    for (const f of cal.failures) {
      console.error(` - ${f.id}: expect ${f.expect}, got ${f.got}: ${f.rationale}`);
    }
    process.exit(1);
  }
  console.log('Calibration OK.');
}

main().catch((err) => {
  console.error('CALIBRATION ERROR:', err);
  process.exit(1);
});
