#!/usr/bin/env node
/**
 * Create a shared client row + bot-XXXXXXXX code. The lead talks only to
 * that business's customer-facing bot. Outputs the code and a wa.me link.
 *
 *   node scripts/create-client.js \
 *     --business-name "Maple Dog Walks" \
 *     [--name "Sam"] [--channel instagram] [--status lead] \
 *     [--what-we-do "Dog walking"] [--profile ./profile.json] \
 *     [--notes "fake fixture"] [--yes] [--dry-run]
 *
 * Requires Supabase env to save (not for --dry-run).
 * Never prints secrets. Use only fake data in fixtures.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import {
  clientRecord,
  clientWaLink,
  formatClientCode,
  generateClientCode,
} from '../src/clients.js';
import { emptyProfile, formatSummary, withKnownProfileKeys } from '../src/profile.js';
import { createStore } from '../src/store/index.js';

export function parseArgs(argv) {
  const out = { yes: false, dryRun: false };
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
    if (
      a === '--business-name' ||
      a === '--name' ||
      a === '--channel' ||
      a === '--status' ||
      a === '--what-we-do' ||
      a === '--profile' ||
      a === '--notes'
    ) {
      const key = {
        '--business-name': 'businessName',
        '--name': 'name',
        '--channel': 'channel',
        '--status': 'status',
        '--what-we-do': 'whatWeDo',
        '--profile': 'profile',
        '--notes': 'notes',
      }[a];
      const val = argv[++i];
      if (val == null || val.startsWith('--')) {
        throw new Error(`Missing value for ${a}`);
      }
      out[key] = val;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

function resolvePath(p, cwd = process.cwd()) {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

export function loadProfileFile(filePath, readFile = fs.readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read profile file: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Profile file must be a JSON object');
  }
  return withKnownProfileKeys(parsed);
}

export function resolveCreateClientInput(args, opts = {}) {
  const readFile = opts.readFile || fs.readFileSync;
  const cwd = opts.cwd || process.cwd();
  const businessName = String(args.businessName || '').trim();
  if (!businessName) {
    throw new Error('Need --business-name');
  }
  let profile = emptyProfile();
  if (args.profile) {
    profile = loadProfileFile(resolvePath(args.profile, cwd), readFile);
  }
  if (args.whatWeDo) profile.whatWeDo = String(args.whatWeDo).trim() || null;
  if (!String(profile.name || '').trim()) profile.name = businessName;
  return {
    name: args.name ?? null,
    businessName,
    contactChannel: args.channel ?? null,
    status: args.status || 'lead',
    profile,
    notes: args.notes ?? null,
  };
}

async function confirmSave(yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error('Refusing to save without --yes on a non-interactive terminal');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('Save this client? [y/N] ', resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(String(answer || '').trim());
}

function usage() {
  return [
    'Usage:',
    '  node scripts/create-client.js --business-name <name> [--name <contact>] [--channel <channel>] [--status lead|demo|trial] [--what-we-do <text>] [--profile <file.json>] [--notes <text>] [--yes] [--dry-run]',
    'Saves a shared client row and prints bot-XXXXXXXX plus a wa.me link.',
  ].join('\n');
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} [deps]
 */
export async function createClient(args, deps = {}) {
  const input = resolveCreateClientInput(args, deps);

  console.log('\nClient profile\n');
  console.log(formatSummary(input.profile));
  console.log('');

  if (args.dryRun) {
    const preview = clientRecord({
      ...input,
      code: generateClientCode(),
    });
    console.log('Dry run. Nothing saved.');
    console.log(`Code would be: ${formatClientCode(preview.code)}`);
    console.log(`Link would be: ${clientWaLink(preview.code)}`);
    return { dryRun: true, saved: null, input, preview };
  }

  const confirm = deps.confirmSave || confirmSave;
  const ok = await confirm(args.yes);
  if (!ok) {
    console.log('Aborted. Nothing saved.');
    return { aborted: true, saved: null, input };
  }

  const store = deps.store || createStore();
  if (!deps.store && store.kind !== 'supabase') {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const record = clientRecord({
    ...input,
    code: generateClientCode(),
  });
  const saved = await store.insertClient(record);
  console.log(`Saved client ${saved.id} for ${saved.business_name} (status=${saved.status}).`);
  console.log(`Code: ${formatClientCode(saved.code)}`);
  console.log(`Link: ${clientWaLink(saved.code)}`);
  return { dryRun: false, saved, input };
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
    await createClient(args);
  } catch (err) {
    console.error(err.message);
    if (/Usage:/.test(err.message)) console.error(usage());
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

export { confirmSave };
