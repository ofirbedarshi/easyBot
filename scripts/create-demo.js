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
 *     [--owner-name "Dana"] [--yes] [--dry-run]
 *
 *   node scripts/create-demo.js --prospect ./prospects.json --id fake-harbor [--yes] [--dry-run]
 *
 * Requires OPENAI_API_KEY. Supabase env is required to save (not for --dry-run).
 * Never prints secrets. Do not commit real prospect files.
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
import { normalizeOwnerName } from '../src/copy.js';
import { formatSummary } from '../src/profile.js';
import { createStore } from '../src/store/index.js';

export const SOURCE_PAGES_MAX_CHARS = 12_000;

const PHONE_MISSING_WARNING =
  'No valid mobile E.164. Saving with business_phone null (code link only).';

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
    if (a === '--owner-name') {
      const val = argv[++i];
      if (val == null || val.startsWith('--')) {
        throw new Error(`Missing value for ${a}`);
      }
      out.ownerName = val;
      continue;
    }
    if (
      a === '--label' ||
      a === '--phone' ||
      a === '--source' ||
      a === '--text' ||
      a === '--prospect' ||
      a === '--id'
    ) {
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

export function resolveOptionalPhone(raw) {
  const trimmed = raw == null ? '' : String(raw).trim();
  if (!trimmed) {
    return { phone: null, warning: PHONE_MISSING_WARNING };
  }
  const phone = normalizeBusinessPhone(trimmed);
  if (!phone) {
    return {
      phone: null,
      warning: `${PHONE_MISSING_WARNING} ${JSON.stringify(trimmed)} is not E.164 (short links are not resolved).`,
    };
  }
  return { phone, warning: null };
}

function capExtractionText(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';
  return cleaned.length > SOURCE_PAGES_MAX_CHARS
    ? cleaned.slice(0, SOURCE_PAGES_MAX_CHARS)
    : cleaned;
}

function fieldText(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(value || '').trim();
}

/** When source_pages is empty, use the prospect's structured public fields. */
export function structuredProspectText(prospect) {
  const lines = [];
  const add = (label, value) => {
    const v = fieldText(value);
    if (v) lines.push(`${label}:\n${v}`);
  };
  add('Category', prospect?.category);
  add('City', prospect?.city);
  add('Services', prospect?.services);
  add('Prices', prospect?.prices);
  add('Hours', prospect?.hours);
  add('Notes', prospect?.notes);
  return lines.join('\n\n');
}

/**
 * `source_pages` is an array of `{url, text}`. Join each page with its URL as
 * a header. Empty array → caller should fall back to structured fields.
 */
export function siteTextFromSourcePages(sourcePages) {
  if (!Array.isArray(sourcePages) || sourcePages.length === 0) return '';
  const chunks = [];
  for (const page of sourcePages) {
    if (!page || typeof page !== 'object') continue;
    const url = String(page.url || '').trim();
    const text = String(page.text || '').trim();
    if (!url && !text) continue;
    chunks.push(url ? `${url}\n${text}`.trim() : text);
  }
  return capExtractionText(chunks.join('\n\n'));
}

export function extractionTextFromProspect(prospect) {
  const fromPages = siteTextFromSourcePages(prospect?.source_pages);
  if (fromPages) return fromPages;
  return capExtractionText(structuredProspectText(prospect));
}

export function mapProspect(prospect) {
  if (!prospect || typeof prospect !== 'object') {
    throw new Error('Prospect is missing');
  }
  const label = String(prospect.name || '').trim();
  if (!label) throw new Error('Prospect has no name');
  const sourceUrl =
    String(prospect.whatsapp_source_url || prospect.website || '').trim() || null;
  const siteText = extractionTextFromProspect(prospect);
  if (!siteText) throw new Error('Prospect has no source_pages text or structured fields');
  const { phone, warning } = resolveOptionalPhone(prospect.whatsapp_e164);
  return {
    businessLabel: label,
    businessPhone: phone,
    phoneWarning: warning,
    sourceUrl,
    siteText,
    prospectId: prospect.id ?? null,
    ownerName: normalizeOwnerName(prospect.owner_name),
  };
}

export function loadProspectById(filePath, id, readFile = fs.readFileSync) {
  let parsed;
  try {
    parsed = JSON.parse(readFile(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read prospect file: ${err.message}`);
  }
  const list = Array.isArray(parsed?.prospects) ? parsed.prospects : null;
  if (!list) throw new Error('Prospect file must have a prospects array');
  const needle = String(id);
  const found = list.find((p) => String(p?.id) === needle);
  if (!found) throw new Error(`Prospect id ${needle} not found`);
  return mapProspect(found);
}

function resolvePath(p, cwd = process.cwd()) {
  return path.isAbsolute(p) ? p : path.join(cwd, p);
}

export function resolveCreateDemoInput(args, opts = {}) {
  const readFile = opts.readFile || fs.readFileSync;
  const cwd = opts.cwd || process.cwd();
  const hasProspect = !!(args.prospect || args.id);
  const hasFlags = !!(args.label || args.source || args.text || args.phone);
  if (hasProspect && (args.label || args.source || args.text)) {
    throw new Error('Use either --prospect/--id or --label/--source/--text, not both');
  }
  if (args.prospect || args.id) {
    if (!args.prospect || args.id == null) {
      throw new Error('Both --prospect and --id are required');
    }
    return loadProspectById(resolvePath(args.prospect, cwd), args.id, readFile);
  }
  if (hasFlags) {
    if (!args.label || !args.source || !args.text) {
      throw new Error('Flag mode needs --label, --source, and --text (--phone is optional)');
    }
    const textPath = resolvePath(args.text, cwd);
    let siteText;
    try {
      siteText = readFile(textPath, 'utf8');
    } catch {
      throw new Error(`Text file not found: ${args.text}`);
    }
    if (!String(siteText).trim()) throw new Error('Text file is empty.');
    const { phone, warning } = resolveOptionalPhone(args.phone);
    return {
      businessLabel: String(args.label).trim(),
      businessPhone: phone,
      phoneWarning: warning,
      sourceUrl: args.source,
      siteText: String(siteText),
      prospectId: null,
      ownerName: normalizeOwnerName(args.ownerName),
    };
  }
  throw new Error('Need --label/--source/--text or --prospect/--id');
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
    'Usage:',
    '  node scripts/create-demo.js --label <name> [--owner-name <name>] [--phone <e164>] --source <url> --text <file> [--yes] [--dry-run]',
    '  node scripts/create-demo.js --prospect <file.json> --id <id> [--yes] [--dry-run]',
    'Paste public text from the business website into <file>, or pass cleaned source_pages via --prospect.',
    'The script does not scrape and does not resolve short links.',
  ].join('\n');
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 * @param {object} [deps]
 */
export async function createDemo(args, deps = {}) {
  const input = resolveCreateDemoInput(args, deps);
  if (input.phoneWarning) {
    console.warn(input.phoneWarning);
  }

  const extract = deps.extractDemoProfile || extractDemoProfile;
  const { profile } = await extract({
    siteText: input.siteText,
    sourceUrl: input.sourceUrl,
    runBuilderTurn: deps.runBuilderTurn || runBuilderTurn,
  });

  console.log('\nExtracted profile\n');
  console.log(formatSummary(profile));
  console.log('');

  if (args.dryRun) {
    console.log('Dry run. Nothing saved.');
    return { dryRun: true, saved: null, input, profile };
  }

  const confirm = deps.confirmSave || confirmSave;
  const ok = await confirm(args.yes);
  if (!ok) {
    console.log('Aborted. Nothing saved.');
    return { aborted: true, saved: null, input, profile };
  }

  const store = deps.store || createStore();
  if (!deps.store && store.kind !== 'supabase') {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const record = reviewedDemoRecord({
    businessLabel: input.businessLabel,
    businessPhone: input.businessPhone,
    sourceUrl: input.sourceUrl,
    profile,
    code: generateDemoCode(),
    prospectId: input.prospectId,
    ownerName: input.ownerName,
  });
  const saved = await store.insertDemo(record);
  const phoneNote = saved.business_phone || 'code link only';
  console.log(`Saved demo ${saved.id} for ${saved.business_label} (${phoneNote}).`);
  console.log(`Fallback link: ${fallbackWaLink(saved.code)}`);
  return { dryRun: false, saved, input, profile };
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

  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }

  try {
    await createDemo(args);
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

export { confirmSave, PHONE_MISSING_WARNING };
