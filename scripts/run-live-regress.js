#!/usr/bin/env node
/**
 * One live pass of every current replay/eval scenario against gpt-6-luna.
 * Requires OPENAI_API_KEY. Never prints the key or other env values.
 * Exit 1 if the key is missing or any scenario fails.
 */
import 'dotenv/config';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'gpt-6-luna';

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY missing');
  process.exit(1);
}

const env = {
  ...process.env,
  OPENAI_BUILDER_MODEL: MODEL,
  OPENAI_MODEL: MODEL,
};

const SCENARIOS = [
  {
    id: 'corrections-salon',
    args: [
      'scripts/replay-builder-corrections.js',
      '--model',
      MODEL,
      '--runs',
      '1',
      '--scenario',
      'salon-correction',
    ],
  },
  {
    id: 'corrections-generic-areas',
    args: [
      'scripts/replay-builder-corrections.js',
      '--model',
      MODEL,
      '--runs',
      '1',
      '--scenario',
      'generic-areas',
    ],
  },
  { id: 'review-nav', args: ['scripts/replay-review-nav.js'] },
  { id: 'salon-intake', args: ['scripts/replay-salon-intake.js'] },
  { id: 'builder-reaction', args: ['scripts/replay-builder-reaction.js'] },
  { id: 'stale-facts', args: ['scripts/replay-stale-facts.js'] },
  {
    id: 'builder-capture',
    args: [
      'scripts/replay-builder-capture.js',
      '--models',
      MODEL,
      '--modes',
      'delta',
      '--runs',
      '1',
      '--budget',
      '0.25',
    ],
  },
  {
    id: 'closed-world-gaps',
    args: [
      'scripts/eval-closed-world-gaps.js',
      '--live',
      '--models',
      MODEL,
      '--runs',
      '1',
      '--cap',
      '0.25',
    ],
  },
  { id: 'on-purpose', args: ['scripts/replay-on-purpose.js'] },
  { id: 'intake-remove', args: ['scripts/replay-intake-remove.js'] },
];

function redact(text) {
  return String(text || '').replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]');
}

function parseCost(text) {
  const total = text.match(/Total spent:\s*\$([0-9.]+)/i);
  if (total) return Number(total[1]);
  const spend = text.match(/^spend_usd\t([0-9.]+)/m);
  if (spend) return Number(spend[1]);
  return null;
}

function runScenario(scenario) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, scenario.args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    const onChunk = (d) => {
      const s = redact(d.toString());
      out += s;
      process.stdout.write(s);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (err) => {
      console.error(`${scenario.id}: ${err.message}`);
      resolve({
        id: scenario.id,
        pass: false,
        ms: Date.now() - start,
        cost: null,
      });
    });
    child.on('close', (code) => {
      resolve({
        id: scenario.id,
        pass: code === 0,
        ms: Date.now() - start,
        cost: parseCost(out),
      });
    });
  });
}

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtCost(usd) {
  return usd == null || Number.isNaN(usd) ? 'n/a' : `$${usd.toFixed(4)}`;
}

console.log(`Live regress: model=${MODEL} scenarios=${SCENARIOS.length}\n`);

const rows = [];
for (const scenario of SCENARIOS) {
  console.log(`\n======== ${scenario.id} ========`);
  rows.push(await runScenario(scenario));
}

const failed = rows.filter((r) => !r.pass);
const totalMs = rows.reduce((s, r) => s + r.ms, 0);
const costs = rows.map((r) => r.cost).filter((c) => c != null);
const totalCost = costs.reduce((s, c) => s + c, 0);

console.log('\n## npm run regress\n');
console.log('scenario                      result   time     cost');
for (const r of rows) {
  console.log(
    `${r.id.padEnd(28)} ${r.pass ? 'PASS' : 'FAIL'}     ${fmtSec(r.ms).padEnd(8)} ${fmtCost(r.cost)}`
  );
}
console.log(
  `\n${rows.length - failed.length}/${rows.length} passed   ${fmtSec(totalMs)}   ${fmtCost(totalCost)}`
);
process.exit(failed.length ? 1 : 0);
