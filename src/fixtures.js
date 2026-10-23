/**
 * Load and validate Tester-only business fixtures.
 * fullKnowledge is never for Builder/Business Bot — only Tester owner + evaluation details.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'businesses');
const SCHEMA_PATH = path.join(FIXTURES_DIR, 'schema.json');

const BUSINESS_IDS = [
  'yoga-teacher',
  'fitness-coach',
  'dog-walker',
  'home-baker',
];

let _validate;

function getValidator() {
  if (_validate) return _validate;
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  _validate = ajv.compile(schema);
  return _validate;
}

export function listBusinessIds() {
  return [...BUSINESS_IDS];
}

export function loadFixture(id) {
  const file = path.join(FIXTURES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Unknown business fixture: ${id}`);
  }
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const validate = getValidator();
  if (!validate(data)) {
    const err = (validate.errors || [])
      .map((e) => `${e.instancePath || '/'} ${e.message}`)
      .join('; ');
    throw new Error(`Fixture ${id} failed schema: ${err}`);
  }
  if (data.id !== id) {
    throw new Error(`Fixture id mismatch: file ${id} vs data.id ${data.id}`);
  }
  return data;
}

export function loadAllFixtures(filterId) {
  const ids = filterId
    ? BUSINESS_IDS.filter((x) => x === filterId)
    : BUSINESS_IDS;
  if (filterId && !ids.length) {
    throw new Error(
      `ADAPTIVE_BUSINESS=${filterId} not in ${BUSINESS_IDS.join(', ')}`
    );
  }
  return ids.map(loadFixture);
}

/** Empty disclosure ledger for adaptive interview. */
export function emptyDisclosureLedger() {
  return {
    disclosures: [],
    explicitUnknowns: [],
    known: {},
    neverDisclosed: [],
  };
}

/**
 * Observable boundary: judge/bot payloads must not include fullKnowledge.hiddenNeverDisclose
 * or other Tester-only secrets as approved facts.
 */
export function assertNoHiddenInApproved(approved, fixture, label = 'approved') {
  const blob = JSON.stringify(approved || {}).toLowerCase();
  const hidden = fixture.fullKnowledge?.hiddenNeverDisclose || [];
  const leaks = [];
  for (const h of hidden) {
    if (h && blob.includes(String(h).toLowerCase())) {
      leaks.push(h);
    }
  }
  const mustNot = fixture.expectedApprovedCore?.mustNotContain || [];
  for (const m of mustNot) {
    if (m && blob.includes(String(m).toLowerCase())) {
      leaks.push(m);
    }
  }
  return {
    ok: leaks.length === 0,
    leaks,
    detail:
      leaks.length === 0
        ? `${label}: no hidden fixture secrets in approved snapshot`
        : `${label}: hidden secrets present: ${leaks.join('; ')}`,
  };
}

/**
 * Observable: owner message text must not contain hiddenNeverDisclose strings.
 */
export function assertOwnerMessageSafe(message, fixture) {
  const blob = String(message || '').toLowerCase();
  const hidden = fixture.fullKnowledge?.hiddenNeverDisclose || [];
  const leaks = hidden.filter((h) => h && blob.includes(String(h).toLowerCase()));
  return {
    ok: leaks.length === 0,
    leaks,
    detail:
      leaks.length === 0
        ? 'owner message free of hidden secrets'
        : `owner message leaked hidden: ${leaks.join('; ')}`,
  };
}

/**
 * Structured fidelity (deterministic):
 * - Hard fail: hiddenNeverDisclose leaked into draft
 * - Soft warn: fixture explicitUnknowns that the owner actually disclosed as unknown
 *   but draft.unknowns omit (substring match)
 * - Soft warn: core price missing when services exist
 * Does NOT invent requirements for ad-hoc owner/ledger unknowns outside the fixture list.
 */
export function structuredDraftFidelity(draft, ledger, fixture) {
  const issues = [];
  const soft = [];
  const draftBlob = JSON.stringify(draft || {}).toLowerCase();
  const servicesBlob = JSON.stringify(draft?.services || []).toLowerCase();
  const unknownsBlob = JSON.stringify(draft?.unknowns || []).toLowerCase();

  for (const h of fixture.fullKnowledge?.hiddenNeverDisclose || []) {
    if (h && draftBlob.includes(String(h).toLowerCase())) {
      issues.push(`invention_hidden:${h}`);
    }
  }

  const fixtureUnknowns = fixture.fullKnowledge?.explicitUnknowns || [];
  const ledgerUnknowns = ledger.explicitUnknowns || [];
  for (const u of fixtureUnknowns) {
    const disclosed = ledgerUnknowns.some(
      (lu) =>
        String(lu).toLowerCase().includes(String(u).toLowerCase().slice(0, 12)) ||
        String(u).toLowerCase().includes(String(lu).toLowerCase().slice(0, 12))
    );
    // Also treat as disclosed if owner text mentioned key uncertainty words + topic
    const topic = String(u)
      .toLowerCase()
      .split(/\s+/)
      .find((w) => w.length > 5);
    const inLedgerText = (ledger.disclosures || []).some((d) =>
      topic ? String(d.text || '').toLowerCase().includes(topic) : false
    );
    if (!(disclosed || inLedgerText)) continue;
    const hint =
      topic ||
      String(u)
        .toLowerCase()
        .split(/\s+/)
        .find((w) => w.length > 4);
    if (hint && !unknownsBlob.includes(hint)) {
      soft.push(`missing_unknown:${u}`);
    }
  }

  const core = fixture.expectedApprovedCore;
  if (core?.priceSubstrings?.length && servicesBlob) {
    const anyPrice = core.priceSubstrings.some((p) =>
      servicesBlob.includes(String(p).toLowerCase())
    );
    if (draft?.services?.length && !anyPrice) {
      soft.push('stale_or_missing_price');
    }
  }

  return {
    ok: issues.length === 0,
    hardFail: issues.length > 0,
    softIssues: soft,
    issues: [...issues, ...soft],
    detail:
      issues.length || soft.length
        ? [...issues, ...soft.map((s) => `soft:${s}`)].join(', ')
        : 'structured draft fidelity ok',
  };
}

export function redactSecrets(text) {
  let s = String(text ?? '');
  s = s.replace(/sk-[a-zA-Z0-9]{10,}/g, '[REDACTED_KEY]');
  s = s.replace(/OPENAI_API_KEY\s*=\s*\S+/gi, 'OPENAI_API_KEY=[REDACTED]');
  s = s.replace(/FLOWISE_API_KEY\s*=\s*\S+/gi, 'FLOWISE_API_KEY=[REDACTED]');
  s = s.replace(/Bearer\s+[a-zA-Z0-9._\-]+/gi, 'Bearer [REDACTED]');
  return s;
}
