#!/usr/bin/env node
/**
 * Run every deterministic (no network, no OpenAI) suite.
 * Each file is a child process so env stubs cannot leak.
 * Exit 1 if any suite fails. Never prints env values.
 */
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const SUITES = [
  { id: 'approval-boundaries', file: 'scripts/test-approval-boundaries.js' },
  { id: 'builder-nav', file: 'scripts/test-builder-nav.js' },
  { id: 'customer-prompt', file: 'scripts/test-customer-prompt.js' },
  { id: 'twilio-webhook', file: 'scripts/test-twilio-webhook.js' },
  { id: 'sender-isolation', file: 'scripts/test-sender-isolation.js' },
  { id: 'lead-intake', file: 'scripts/test-lead-intake.js' },
  { id: 'business-bot', file: 'scripts/test-business-bot.js' },
  { id: 'builder-output', file: 'test/test-builder-output.js' },
  { id: 'format-reply', file: 'test/test-format-reply.js' },
  { id: 'identical-reply', file: 'test/test-identical-reply.js' },
  { id: 'fact-preservation', file: 'test/test-fact-preservation.js' },
  { id: 'validate-cto-state', file: 'scripts/validate-cto-state.js' },
  { id: 'admin-dashboard', file: 'scripts/test-admin-dashboard.js' },
  { id: 'demo-playback', file: 'scripts/test-demo-playback.js' },
];

function runSuite(suite) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [suite.file], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (err) => {
      console.error(`${suite.id}: ${err.message}`);
      resolve({ id: suite.id, pass: false, ms: Date.now() - start });
    });
    child.on('close', (code) => {
      resolve({ id: suite.id, pass: code === 0, ms: Date.now() - start });
    });
  });
}

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

const rows = [];
for (const suite of SUITES) {
  console.log(`\n======== ${suite.id} ========`);
  rows.push(await runSuite(suite));
}

const failed = rows.filter((r) => !r.pass);
const totalMs = rows.reduce((s, r) => s + r.ms, 0);
console.log('\n## npm test\n');
console.log('suite                   result   time');
for (const r of rows) {
  console.log(`${r.id.padEnd(23)} ${r.pass ? 'PASS' : 'FAIL'}     ${fmtSec(r.ms)}`);
}
console.log(`\n${rows.length - failed.length}/${rows.length} passed   ${fmtSec(totalMs)}`);
process.exit(failed.length ? 1 : 0);
