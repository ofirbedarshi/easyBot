#!/usr/bin/env node
/**
 * Validate cto-workflow/state.json against the v1 schema (structural).
 * Exit 0 on success; 1 on failure. No network.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, '..', 'cto-workflow', 'state.json');

const GOAL_STATUSES = new Set(['active', 'completed', 'blocked', 'paused']);
const MILESTONE_STATUSES = new Set([
  'pending',
  'in_progress',
  'implemented',
  'verified',
  'failed',
  'blocked',
]);
const AGENT_STATUSES = new Set(['idle', 'working', 'waiting']);
const VERDICTS = new Set(['pass', 'fail', 'blocked', 'needs_decision', null]);
const ACTORS = new Set(['cto', 'developer', 'verifier', 'user']);

function fail(msg) {
  console.error(`INVALID: ${msg}`);
  process.exit(1);
}

function req(obj, key, ctx) {
  if (obj == null || !(key in obj)) fail(`${ctx}: missing "${key}"`);
}

function main() {
  if (!fs.existsSync(STATE_PATH)) fail(`missing ${STATE_PATH}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    fail(`JSON parse: ${err.message}`);
  }

  if (data.version !== 1) fail(`version must be 1, got ${data.version}`);
  req(data, 'updatedAt', 'root');
  req(data, 'goal', 'root');
  req(data, 'milestones', 'root');
  req(data, 'agents', 'root');
  req(data, 'blockers', 'root');
  req(data, 'decisionsNeeded', 'root');
  req(data, 'activity', 'root');
  req(data, 'stale', 'root');

  const g = data.goal;
  for (const k of [
    'id',
    'title',
    'description',
    'status',
    'agreedScope',
    'outOfScope',
  ]) {
    req(g, k, 'goal');
  }
  if (!GOAL_STATUSES.has(g.status)) fail(`goal.status invalid: ${g.status}`);
  if (!Array.isArray(g.outOfScope)) fail('goal.outOfScope must be array');

  if (!Array.isArray(data.milestones)) fail('milestones must be array');
  const ids = new Set();
  for (const m of data.milestones) {
    for (const k of [
      'id',
      'title',
      'acceptanceCriteria',
      'status',
      'fixAttempts',
      'maxFixAttempts',
      'implementation',
      'verification',
    ]) {
      req(m, k, `milestone ${m?.id || '?'}`);
    }
    if (ids.has(m.id)) fail(`duplicate milestone id ${m.id}`);
    ids.add(m.id);
    if (!MILESTONE_STATUSES.has(m.status)) {
      fail(`milestone ${m.id} status invalid: ${m.status}`);
    }
    if (!Array.isArray(m.acceptanceCriteria)) {
      fail(`milestone ${m.id}: acceptanceCriteria must be array`);
    }
    if (typeof m.implementation.complete !== 'boolean') {
      fail(`milestone ${m.id}: implementation.complete must be boolean`);
    }
    const v = m.verification;
    req(v, 'independent', `milestone ${m.id} verification`);
    if (typeof v.independent !== 'boolean') {
      fail(`milestone ${m.id}: verification.independent must be boolean`);
    }
    if (!VERDICTS.has(v.verdict)) {
      fail(`milestone ${m.id}: verification.verdict invalid: ${v.verdict}`);
    }
    if (m.status === 'verified') {
      if (!m.implementation.complete) {
        fail(`milestone ${m.id}: verified but implementation.complete is false`);
      }
      if (!v.independent || v.verdict !== 'pass') {
        fail(
          `milestone ${m.id}: verified requires independent=true and verdict=pass`
        );
      }
    }
    if (m.status === 'implemented' && v.verdict === 'pass' && v.independent) {
      fail(
        `milestone ${m.id}: independent pass should use status verified, not implemented`
      );
    }
  }

  if (
    data.currentMilestoneId != null &&
    !ids.has(data.currentMilestoneId)
  ) {
    fail(`currentMilestoneId unknown: ${data.currentMilestoneId}`);
  }

  for (const name of ['cto', 'developer', 'verifier']) {
    req(data.agents, name, 'agents');
    const a = data.agents[name];
    req(a, 'status', `agents.${name}`);
    req(a, 'activity', `agents.${name}`);
    if (!AGENT_STATUSES.has(a.status)) {
      fail(`agents.${name}.status invalid: ${a.status}`);
    }
  }

  for (const listName of ['blockers', 'decisionsNeeded', 'activity']) {
    if (!Array.isArray(data[listName])) fail(`${listName} must be array`);
  }
  for (const ev of data.activity) {
    req(ev, 'at', 'activity');
    req(ev, 'actor', 'activity');
    req(ev, 'type', 'activity');
    req(ev, 'message', 'activity');
    if (!ACTORS.has(ev.actor)) fail(`activity actor invalid: ${ev.actor}`);
  }

  req(data.stale, 'interrupted', 'stale');
  if (typeof data.stale.interrupted !== 'boolean') {
    fail('stale.interrupted must be boolean');
  }

  console.log(`OK ${STATE_PATH}`);
  console.log(
    `goal=${g.id} status=${g.status} milestones=${data.milestones.length} current=${data.currentMilestoneId}`
  );
}

main();
