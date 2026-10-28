#!/usr/bin/env node
/**
 * Remove a pre-built demo profile by prospect id, code, or phone.
 *
 *   node scripts/delete-demo.js --id <prospect id> [--yes] [--dry-run] [--include-claimed]
 *   node scripts/delete-demo.js --code <CODE> ...
 *   node scripts/delete-demo.js --phone +E164 ...
 *
 * --dry-run prints row counts per table plus local asset paths and deletes nothing.
 * A claimed demo refuses until --include-claimed (then sender data is removed too).
 * Prints counts only, never message bodies. Never prints secrets.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { normalizeBusinessPhone } from '../src/demoProfiles.js';
import { createStore } from '../src/store/index.js';

export const DELETE_COUNT_KEYS = [
  'easybot_demo_profiles',
  'easybot_senders',
  'easybot_business_profiles',
  'easybot_sessions',
  'easybot_messages',
  'easybot_inbound_messages',
  'easybot_leads',
];

export function emptyCounts() {
  return Object.fromEntries(DELETE_COUNT_KEYS.map((k) => [k, 0]));
}

export function parseArgs(argv) {
  const out = { yes: false, dryRun: false, includeClaimed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') {
      out.yes = true;
      continue;
    }
    if (a === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (a === '--include-claimed') {
      out.includeClaimed = true;
      continue;
    }
    if (a === '--id' || a === '--code' || a === '--phone') {
      const key = a.slice(2);
      const val = argv[++i];
      if (val == null || val.startsWith('--')) {
        throw new Error(`Missing value for ${a}`);
      }
      out[key] = val;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  const keys = ['id', 'code', 'phone'].filter((k) => out[k] != null);
  if (keys.length === 0) {
    throw new Error('Need exactly one of --id, --code, or --phone');
  }
  if (keys.length > 1) {
    throw new Error('Use only one of --id, --code, or --phone');
  }
  return out;
}

export function lookupLabel(args) {
  if (args.id != null) return `prospect id ${args.id}`;
  if (args.code != null) return `code ${String(args.code).toUpperCase()}`;
  return `phone ${args.phone}`;
}

export function demoOutputDir(prospectId, cwd = process.cwd()) {
  const id = prospectId == null ? '' : String(prospectId).trim();
  if (!id) return null;
  return path.join(cwd, 'demo-output', id);
}

export function existingAssetPaths(prospectId, cwd, existsFn = fs.existsSync) {
  const dir = demoOutputDir(prospectId, cwd);
  if (!dir) return [];
  return existsFn(dir) ? [dir] : [];
}

export async function findDemo(store, args) {
  if (args.id != null) {
    return store.findDemoByProspectId(String(args.id).trim());
  }
  if (args.code != null) {
    return store.findDemoByCode(String(args.code).toUpperCase());
  }
  const phone = normalizeBusinessPhone(args.phone);
  if (!phone) {
    throw new Error(`${JSON.stringify(args.phone)} is not E.164`);
  }
  return store.findDemoByPhone(phone);
}

export async function planDelete(store, demo, { cwd, existsFn } = {}) {
  const counts = emptyCounts();
  counts.easybot_demo_profiles = 1;
  if (demo.claimed_by) {
    const senderCounts = await store.countSenderDelete(demo.claimed_by);
    for (const key of DELETE_COUNT_KEYS) {
      if (key === 'easybot_demo_profiles') continue;
      counts[key] = senderCounts[key] || 0;
    }
  }
  const assetPaths = existingAssetPaths(demo.prospect_id, cwd || process.cwd(), existsFn);
  return { counts, assetPaths };
}

export function formatDeletePlan(plan) {
  const lines = [];
  for (const key of DELETE_COUNT_KEYS) {
    lines.push(`  ${key}: ${plan.counts[key] ?? 0}`);
  }
  lines.push('Local assets:');
  if (plan.assetPaths.length) {
    for (const p of plan.assetPaths) lines.push(`  ${p}`);
  } else {
    lines.push('  (none)');
  }
  return lines.join('\n');
}

async function confirmDelete(yes, prompt) {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error('Refusing to delete without --yes on a non-interactive terminal');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(String(answer || '').trim());
}

function usage() {
  return [
    'Usage:',
    '  node scripts/delete-demo.js --id <prospect id> [--yes] [--dry-run] [--include-claimed]',
    '  node scripts/delete-demo.js --code <CODE> [--yes] [--dry-run] [--include-claimed]',
    '  node scripts/delete-demo.js --phone <+E164> [--yes] [--dry-run] [--include-claimed]',
    'Deletes the demo row. Claimed demos also need --include-claimed to remove sender data.',
    '--dry-run prints counts and local paths and deletes nothing.',
  ].join('\n');
}

function removeAssetDir(dir, rmFn) {
  rmFn(dir, { recursive: true, force: true });
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} [deps]
 */
export async function deleteDemo(args, deps = {}) {
  const store = deps.store || createStore();
  if (!deps.store && store.kind !== 'supabase') {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const cwd = deps.cwd || process.cwd();
  const existsFn = deps.existsFn || fs.existsSync;
  const rmFn = deps.rmFn || fs.rmSync;
  const log = deps.log || console.log;
  const warn = deps.warn || console.warn;

  const demo = await findDemo(store, args);
  if (!demo) {
    log(`No demo found for ${lookupLabel(args)}. Nothing deleted.`);
    return { found: false, deleted: false, dryRun: !!args.dryRun, plan: null };
  }

  const claimed = demo.claimed_by != null;
  const wouldRefuse = claimed && !args.includeClaimed;
  const plan = await planDelete(store, demo, { cwd, existsFn });
  log(`Would delete:\n${formatDeletePlan(plan)}`);

  if (args.dryRun) {
    if (wouldRefuse) {
      warn(
        `Demo ${demo.business_label} (${demo.code}) is claimed by ${demo.claimed_by}. Pass --include-claimed to also delete that sender's data.`
      );
    }
    log('Dry run. Nothing deleted.');
    return {
      found: true,
      deleted: false,
      dryRun: true,
      refused: wouldRefuse,
      demo,
      plan,
    };
  }

  if (wouldRefuse) {
    warn(
      `Demo ${demo.business_label} (${demo.code}) is claimed by ${demo.claimed_by}. Pass --include-claimed to also delete that sender's data. Nothing deleted.`
    );
    return { found: true, deleted: false, dryRun: false, refused: true, demo, plan };
  }

  const confirm = deps.confirmDelete || confirmDelete;
  const claimedNote = claimed ? ` and sender ${demo.claimed_by}` : '';
  const ok = await confirm(
    args.yes,
    `Delete demo ${demo.business_label} (${demo.code})${claimedNote}? [y/N] `
  );
  if (!ok) {
    log('Aborted. Nothing deleted.');
    return { found: true, deleted: false, aborted: true, demo, plan };
  }

  const deletedCounts = emptyCounts();
  // Sender children first, then senders, then the demo row (claimed_by is not an FK).
  if (claimed && demo.claimed_by) {
    const senderCounts = await store.deleteSenderData(demo.claimed_by);
    for (const key of DELETE_COUNT_KEYS) {
      if (key === 'easybot_demo_profiles') continue;
      deletedCounts[key] = senderCounts[key] || 0;
    }
  }
  deletedCounts.easybot_demo_profiles = await store.deleteDemo(demo.id);

  const removedAssets = [];
  for (const dir of plan.assetPaths) {
    removeAssetDir(dir, rmFn);
    removedAssets.push(dir);
  }

  log(`Deleted:\n${formatDeletePlan({ counts: deletedCounts, assetPaths: removedAssets })}`);
  return {
    found: true,
    deleted: true,
    dryRun: false,
    demo,
    plan: { counts: deletedCounts, assetPaths: removedAssets },
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exit(1);
  }

  try {
    const result = await deleteDemo(args);
    if (result.refused) process.exit(1);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export { confirmDelete, usage };
