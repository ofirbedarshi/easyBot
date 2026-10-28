#!/usr/bin/env node
/**
 * Build a reviewed demo profile from public text the operator pasted from
 * the business's own website. No scraping. Saves only after y/N (or --yes).
 *
 *   node scripts/create-demo.js \
 *     --label "Harbor Cuts" \
 *     --phone +15125550100 \
 *     --source https://harborcuts.example \
 *     --text ./harbor-cuts.txt
 *     [--yes]
 *
 * Requires OPENAI_API_KEY and Supabase env. Never prints secrets.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { runBuilderTurn } from '../src/builder.js';
import {
  extractDemoProfile,
  fallbackWaLink,
  generateDemoCode,
  normalizeBusinessPhone,
  reviewedDemoRecord,
} from '../src/demoProfiles.js';
import { formatSummary } from '../src/profile.js';
import { createStore } from '../src/store/index.js';

function parseArgs(argv) {
  const out = { yes: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--yes' || a === '-y') {
      out.yes = true;
      continue;
    }
    if (a === '--label' || a === '--phone' || a === '--source' || a === '--text') {
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
  return out;
}

async function confirmSave(yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error('Refusing to save without --yes on a non-interactive terminal');
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('Save this demo profile? [y/N] ', resolve);
  });
  rl.close();
  return /^y(es)?$/i.test(String(answer || '').trim());
}

function usage() {
  return [
    'Usage: node scripts/create-demo.js --label <name> --phone <e164> --source <url> --text <file> [--yes]',
    'Paste public text from the business website into <file>. The script does not scrape.',
  ].join('\n');
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

  if (!args.label || !args.phone || !args.source || !args.text) {
    console.error(usage());
    process.exit(1);
  }

  const phone = normalizeBusinessPhone(args.phone);
  if (!phone) {
    console.error('Invalid business phone. Use E.164, for example +15125550100.');
    process.exit(1);
  }

  const textPath = path.isAbsolute(args.text) ? args.text : path.join(process.cwd(), args.text);
  if (!fs.existsSync(textPath)) {
    console.error(`Text file not found: ${args.text}`);
    process.exit(1);
  }
  const siteText = fs.readFileSync(textPath, 'utf8');
  if (!siteText.trim()) {
    console.error('Text file is empty.');
    process.exit(1);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }

  const store = createStore();
  if (store.kind !== 'supabase') {
    console.error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  console.log(`Extracting demo profile for ${args.label} from ${args.source}…`);
  const { profile } = await extractDemoProfile({
    siteText,
    sourceUrl: args.source,
    runBuilderTurn,
  });

  console.log('\nExtracted profile\n');
  console.log(formatSummary(profile));
  console.log('');

  const ok = await confirmSave(args.yes);
  if (!ok) {
    console.log('Aborted. Nothing saved.');
    process.exit(0);
  }

  const record = reviewedDemoRecord({
    businessLabel: args.label,
    businessPhone: phone,
    sourceUrl: args.source,
    profile,
    code: generateDemoCode(),
  });
  const saved = await store.insertDemo(record);
  console.log(`Saved demo ${saved.id} for ${saved.business_label} (${saved.business_phone}).`);
  console.log(`Fallback link: ${fallbackWaLink(saved.code)}`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

export { parseArgs, confirmSave };
