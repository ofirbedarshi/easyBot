import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILE_PATH = path.join(DATA_DIR, 'business-profile.json');

export function emptyProfile() {
  return {
    name: null,
    whatWeDo: null,
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    /** Explicit gaps the owner left undecided or unclarified (must stay unknown until approved). */
    unknowns: [],
    tone: null,
    approvedAt: null,
    chatflowId: null,
    draft: null,
  };
}

export function loadProfile() {
  if (!fs.existsSync(PROFILE_PATH)) {
    return emptyProfile();
  }
  const raw = fs.readFileSync(PROFILE_PATH, 'utf8');
  return { ...emptyProfile(), ...JSON.parse(raw) };
}

export function saveProfile(profile) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2), 'utf8');
  return profile;
}

export function mergeDraft(profile, draft) {
  const next = { ...profile };
  if (!draft || typeof draft !== 'object') return next;

  for (const key of [
    'name',
    'whatWeDo',
    'hours',
    'locationOrArea',
    'tone',
  ]) {
    if (draft[key] != null && draft[key] !== '') next[key] = draft[key];
  }
  if (Array.isArray(draft.services)) next.services = draft.services;
  if (Array.isArray(draft.commonQuestions)) {
    next.commonQuestions = draft.commonQuestions;
  }
  if (Array.isArray(draft.unknowns)) next.unknowns = draft.unknowns;
  return next;
}

export function formatSummary(profile) {
  const lines = [];
  lines.push(`Business: ${profile.name || '(not set)'}`);
  lines.push(`What they do: ${profile.whatWeDo || '(not set)'}`);
  if (profile.services?.length) {
    lines.push('Services:');
    for (const s of profile.services) {
      const price = s.price != null ? ` — ${s.price}` : '';
      const notes = s.notes ? ` (${s.notes})` : '';
      lines.push(`  • ${s.name || 'Unnamed'}${price}${notes}`);
    }
  } else {
    lines.push('Services: (none yet)');
  }
  lines.push(`Hours: ${profile.hours || '(not set)'}`);
  lines.push(`Location / area: ${profile.locationOrArea || '(not set)'}`);
  lines.push(`Tone: ${profile.tone || '(not set)'}`);
  if (profile.commonQuestions?.length) {
    lines.push('Common questions:');
    for (const q of profile.commonQuestions) lines.push(`  • ${q}`);
  }
  if (profile.unknowns?.length) {
    lines.push('Explicitly unknown / undecided (bot must not invent these):');
    for (const u of profile.unknowns) lines.push(`  • ${u}`);
  }
  return lines.join('\n');
}

export function hasEnoughForFirstBot(profile) {
  const hasIdentity = !!(profile.name || profile.whatWeDo);
  const hasOffering =
    (profile.services && profile.services.length > 0) || !!profile.whatWeDo;
  return hasIdentity && hasOffering;
}
