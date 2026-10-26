import {
  assistantIdentityView,
  draftDiffersFromLive,
  effectiveBehavior,
  mergeDraft,
  normalizeCommonQuestions,
  normalizeFaqItem,
  normalizeOwnerGoal,
  normalizePriceDisclosure,
  normalizeResponseLength,
  OWNER_GOAL_LABELS,
} from './profile.js';
import { LEAD_MENU_LABEL } from './leadIntake.js';

/**
 * App-rendered owner navigation: editing menu, section views, review summary,
 * and sync / return-to-editing messages. Templates only (no LLM).
 * Navigation never modifies the profile, draft, or review state.
 */

const STRINGS = {
  menu: [
    'Edit business',
    'Edit bot goal & customer details',
    'Edit Q&A',
    'Edit style & prices',
    'Edit name & opening',
    'Try my bot',
  ],
  sections: ['Business', 'Bot goal & customer details', 'Q&A', 'Style & prices', 'Name & opening'],
  menuFooter: 'Pick a number or just write what you want to change.',
  synced: "Bot updated ✅\nYou're in editing mode. What would you like to do?",
  syncedShort: 'Bot updated ✅',
  returned: 'Back in editing mode. What would you like to do?',
  setupContinue: "We're still in first-time setup. Tell me more about your business.",
  ask: 'What would you like to change?',
  current: 'Current:',
  live: 'Live now:',
  pending: 'Pending change (not live until you approve):',
  was: 'was',
  notSet: '(not set)',
  none: '(none)',
  defaultMark: '(default)',
  fields: {
    name: 'Business name',
    whatWeDo: 'What the business does',
    services: 'Services',
    hours: 'Hours',
    locationOrArea: 'Location / area',
    unknowns: 'Not decided yet',
    ownerGoal: 'Bot goal',
    informationToCollect: 'Details to collect from the customer',
    intakeNotAnswered: '(not decided yet)',
    commonQuestions: 'Questions and answers',
    q: 'Q',
    a: 'A',
    noAnswer: '(no answer recorded — the bot will not invent one)',
    tone: 'Style',
    responseLength: 'Reply length',
    priceDisclosure: 'Prices',
    assistantName: 'Assistant name',
    noName: '(not set — no name)',
    openingMessage: 'Opening message',
    defaultOpening: (biz) =>
      `(default) short introduction as the digital assistant of ${biz || 'this business'}`,
  },
  responseLengthLabels: { short: 'short', standard: 'standard' },
  priceDisclosureLabels: {
    relevant: 'when useful and relevant',
    on_request: 'only when the customer asks about pricing',
  },
};

const MENU_REQUESTS = new Set([
  'menu',
  '/menu',
  'main menu',
  'show menu',
  'show the menu',
  'back to menu',
  'back to the menu',
  'options',
]);

function normalizeShort(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?,:;]+$/g, '')
    .replace(/\s+/g, ' ');
}

/** Short, explicit navigation request (whitelist; longer phrasing goes to the Builder). */
export function isMenuRequest(text) {
  const s = normalizeShort(text).replace(/\s*please$/, '');
  return MENU_REQUESTS.has(s);
}

/** Standalone 1–max (optional trailing "." or ")"), else null. */
export function parseMenuChoice(text, max = 6) {
  const m = /^\s*(\d)\s*[.)]?\s*$/.exec(String(text || ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= max ? n : null;
}

/**
 * Ordered editing-menu items: 'lead', sections 1–5 (numbers), 'try'.
 * Rendering and number parsing both use this list, so a picked number always
 * maps to the item shown at that position.
 */
export function menuItems({ leadOption = false } = {}) {
  return [...(leadOption ? ['lead'] : []), 1, 2, 3, 4, 5, 'try'];
}

/** Bare menu number → item from `menuItems(menuOpts)`, else null. */
export function parseMenuItem(text, menuOpts) {
  const items = menuItems(menuOpts);
  const n = parseMenuChoice(text, items.length);
  return n == null ? null : items[n - 1];
}

/** Latest assistant Builder entry, or null. */
export function lastAssistant(buildHistory) {
  const list = Array.isArray(buildHistory) ? buildHistory : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'assistant') return list[i];
  }
  return null;
}

/**
 * Last navigation the app actually showed (`review`, `menu`, `section:N`).
 * Intervening Builder replies have no `nav` and do not replace this.
 */
export function lastShownNav(buildHistory) {
  const list = Array.isArray(buildHistory) ? buildHistory : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (m?.role === 'assistant' && m.nav) return m.nav;
  }
  return null;
}

/** True when the latest assistant Builder entry was a menu. */
export function menuActive(buildHistory) {
  return lastAssistant(buildHistory)?.nav === 'menu';
}

/**
 * Editing menu. `leadOption` adds the lead item first, which shifts the other
 * items down by one.
 */
export function renderMenu(menuOpts) {
  const s = STRINGS;
  const label = (item) =>
    item === 'lead' ? LEAD_MENU_LABEL : item === 'try' ? s.menu[5] : s.menu[item - 1];
  return [
    ...menuItems(menuOpts).map((item, i) => `${i + 1}. ${label(item)}`),
    '',
    s.menuFooter,
  ].join('\n');
}

export function renderSyncSuccess(menuOpts) {
  return `${STRINGS.synced}\n\n${renderMenu(menuOpts)}`;
}

/** Short "Bot updated ✅" line (used before entering TEST after the Try my bot menu item). */
export function renderSyncedShort() {
  return STRINGS.syncedShort;
}

/** /end before anything is approved: no editing menu during first-time setup. */
export function renderSetupContinue() {
  return STRINGS.setupContinue;
}

export function renderReturnToEditing(menuOpts) {
  return `${STRINGS.returned}\n\n${renderMenu(menuOpts)}`;
}

function textOrNull(v) {
  if (v == null || v === '') return null;
  return String(v);
}

const REVIEW = {
  intro: (name) => `Here's your bot for ${name}:`,
  introNoName: "Here's your bot:",
  labels: {
    business: 'Business',
    services: 'Services',
    area: 'Area',
    hours: 'Hours',
    unknowns: 'Not decided',
    goal: 'Bot goal',
    intake: 'Asks customers for',
    faq: 'Q&A',
    style: 'Style',
    identity: 'Name & opening',
  },
  notSet: 'not set',
  gap: 'not set (bot refers customers to you)',
  none: 'none',
  nothing: 'nothing',
  notDecided: 'not decided yet',
  faqCount: (n) => `${n} answer${n === 1 ? '' : 's'}`,
  faqNone: 'none yet (bot refers customers to you)',
  defaultValue: 'default',
  shortReplies: 'short replies',
  standardReplies: 'standard replies',
  pricesOnRequest: 'prices only when asked',
  pricesRelevant: 'prices when relevant',
  customOpening: 'custom opening',
  changesIntro: "Here's what will change:",
  was: (v) => `(was: ${v})`,
  updated: '(updated)',
  optionsPrompt: 'What would you like to do next?',
  options: ['Try my bot', 'Make changes'],
  optionsFooter: '(or just tell me what to change 🙂)',
  changeAsk: 'What would you like to change?',
};

const OTHER_FACTS_LABEL = 'Other facts';

/** Review line text: trim and drop a trailing period. Do not clip — owners
 *  must be able to see every stored service, fact, and area on WhatsApp. */
function brief(text) {
  return String(text || '').trim().replace(/\.$/, '');
}

/**
 * Review summary: one `Label: value` line per item, in editing-menu order
 * (the five edit items). `full` holds the underlying data so the changes view can
 * detect edits that the trimmed `value` hides.
 */
export function summaryLines(p) {
  const R = REVIEW;
  const L = R.labels;
  const out = [];
  // `was` is the value shown as "(was: …)" in the changes view (no gap note).
  const add = (id, label, value, full, was = value) =>
    out.push({ id, label, value, was, full: JSON.stringify(full ?? null) });

  const what = textOrNull(p.whatWeDo);
  add('business', L.business, what ? brief(what) : R.notSet, what);
  const services = Array.isArray(p.services) ? p.services : [];
  add(
    'services',
    L.services,
    services.length
      ? brief(services.map((s) => `${s.name || '?'}${s.price ? ` — ${s.price}` : ''}`).join('; '))
      : R.none,
    services
  );
  const area = textOrNull(p.locationOrArea);
  add('area', L.area, area ? brief(area) : R.gap, area, area ? brief(area) : R.notSet);
  const hours = textOrNull(p.hours);
  add('hours', L.hours, hours ? brief(hours) : R.gap, hours, hours ? brief(hours) : R.notSet);
  const unknowns = Array.isArray(p.unknowns) ? p.unknowns : [];
  if (unknowns.length) add('unknowns', L.unknowns, brief(unknowns.join('; ')), unknowns);
  const otherFacts = Array.isArray(p.otherFacts) ? p.otherFacts : [];
  if (otherFacts.length) {
    add('otherFacts', OTHER_FACTS_LABEL, brief(otherFacts.join('; ')), otherFacts);
  }

  const goal = normalizeOwnerGoal(p.ownerGoal);
  add('goal', L.goal, goal ? OWNER_GOAL_LABELS[goal] : R.notSet, goal);
  const intake = p.informationToCollect;
  add(
    'intake',
    L.intake,
    !Array.isArray(intake) ? R.notDecided : intake.length ? brief(intake.join(', ')) : R.nothing,
    intake ?? null
  );

  const faq = normalizeCommonQuestions(p.commonQuestions).filter((f) => f.answer);
  add(
    'faq',
    L.faq,
    faq.length ? R.faqCount(faq.length) : R.faqNone,
    faq,
    faq.length ? R.faqCount(faq.length) : R.none
  );

  const tone = typeof p.tone === 'string' && p.tone.trim() ? p.tone.trim() : null;
  const len = normalizeResponseLength(p.responseLength);
  const price = normalizePriceDisclosure(p.priceDisclosure);
  const style = [
    tone,
    len === 'short' ? R.shortReplies : len === 'standard' ? R.standardReplies : null,
    price === 'on_request' ? R.pricesOnRequest : price === 'relevant' ? R.pricesRelevant : null,
  ].filter(Boolean);
  add('style', L.style, style.length ? brief(style.join(', ')) : R.defaultValue, { tone, len, price });

  const id = assistantIdentityView(p);
  const identity = [id.assistantName, id.openingMessage ? R.customOpening : null].filter(Boolean);
  add(
    'identity',
    L.identity,
    identity.length ? identity.join(', ') : R.defaultValue,
    { name: id.assistantName, opening: id.openingMessage }
  );
  return out;
}

function changeLines(profile, merged) {
  const R = REVIEW;
  const prev = new Map(summaryLines(profile).map((l) => [l.id, l]));
  const lines = [];
  for (const line of summaryLines(merged)) {
    const was = prev.get(line.id);
    if (was && was.full === line.full) continue;
    const suffix = !was ? '' : was.value === line.value ? ` ${R.updated}` : ` ${R.was(was.was)}`;
    lines.push(`${line.label}: ${line.value}${suffix}`);
  }
  return lines;
}

/** Two review options (1 Try my bot, 2 Make changes). */
export function renderReviewOptions() {
  const R = REVIEW;
  return [
    R.optionsPrompt,
    ...R.options.map((label, i) => `${i + 1}. ${label}`),
    '',
    R.optionsFooter,
  ].join('\n');
}

/**
 * Owner-facing review: short `Label: value` summary in editing-menu order
 * (gaps shown), then two options. When already approved and the draft differs
 * from live, shows only the changed lines with their previous value.
 */
export function renderReview(profile) {
  const R = REVIEW;
  const draft = profile?.draft;
  const merged = draft ? mergeDraft(profile, draft) : profile || {};
  const parts = [];
  if (profile?.approvedAt && draft && draftDiffersFromLive(profile, draft)) {
    parts.push([R.changesIntro, '', ...changeLines(profile, merged)].join('\n'));
  } else {
    const name = textOrNull(merged.name);
    parts.push(name ? R.intro(name) : R.introNoName);
    parts.push(summaryLines(merged).map((l) => `${l.label}: ${l.value}`).join('\n'));
  }
  parts.push(renderReviewOptions());
  return parts.join('\n\n');
}

/** "Make changes" reply: ask, then the full editing menu. */
export function renderChangeMenu(menuOpts) {
  return `${REVIEW.changeAsk}\n\n${renderMenu(menuOpts)}`;
}

const REVIEW_TRY = new Set(['try my bot', 'try', 'try it']);
const REVIEW_CHANGE = new Set(['make changes', 'change', 'changes']);

const REVIEW_NUMBER = /^\s*([12])\s*[.)]?\s*$/;

/** 1 / "Try my bot" → 'try'; 2 / "Make changes" → 'change'; else null. */
export function parseReviewChoice(text) {
  const m = REVIEW_NUMBER.exec(String(text || ''));
  if (m) return m[1] === '1' ? 'try' : 'change';
  const s = normalizeShort(text);
  if (REVIEW_TRY.has(s)) return 'try';
  if (REVIEW_CHANGE.has(s)) return 'change';
  return null;
}

/** Standalone 1 or 2 (optional trailing "." or ")"), matching the review options. */
export function isReviewNumberChoice(text) {
  return REVIEW_NUMBER.test(String(text || ''));
}

/**
 * Latest assistant turn is a Builder question the owner is expected to answer
 * (`asksQuestion` on the history entry), not an app menu/review/section.
 * A bare number after that is an answer, not a review option.
 */
export function interveningBuilderQuestion(buildHistory) {
  const last = lastAssistant(buildHistory);
  if (!last || last.nav) return false;
  return last.asksQuestion === true;
}

/** True when the last navigation the app showed was the two-option review. */
export function reviewActive(buildHistory) {
  return lastShownNav(buildHistory) === 'review';
}

function sectionLines(section, p) {
  const s = STRINGS;
  const f = s.fields;
  const val = (v) => (v == null || v === '' ? s.notSet : String(v));
  const lines = [];
  if (section === 1) {
    lines.push(`• ${f.name}: ${val(p.name)}`);
    lines.push(`• ${f.whatWeDo}: ${val(p.whatWeDo)}`);
    if (Array.isArray(p.services) && p.services.length) {
      lines.push(`• ${f.services}:`);
      for (const svc of p.services) {
        const price = svc.price != null && svc.price !== '' ? ` — ${svc.price}` : '';
        const notes = svc.notes ? ` (${svc.notes})` : '';
        lines.push(`   - ${svc.name || '?'}${price}${notes}`);
      }
    } else {
      lines.push(`• ${f.services}: ${s.none}`);
    }
    lines.push(`• ${f.hours}: ${val(p.hours)}`);
    lines.push(`• ${f.locationOrArea}: ${val(p.locationOrArea)}`);
    if (Array.isArray(p.unknowns) && p.unknowns.length) {
      lines.push(`• ${f.unknowns}:`);
      for (const u of p.unknowns) lines.push(`   - ${u}`);
    }
    if (Array.isArray(p.otherFacts) && p.otherFacts.length) {
      lines.push(`• ${OTHER_FACTS_LABEL}:`);
      for (const fact of p.otherFacts) lines.push(`   - ${fact}`);
    }
  } else if (section === 2) {
    const goal = normalizeOwnerGoal(p.ownerGoal);
    lines.push(`• ${f.ownerGoal}: ${goal ? OWNER_GOAL_LABELS[goal] : s.notSet}`);
    if (!Array.isArray(p.informationToCollect)) {
      lines.push(`• ${f.informationToCollect}: ${f.intakeNotAnswered}`);
    } else if (!p.informationToCollect.length) {
      lines.push(`• ${f.informationToCollect}: ${s.none}`);
    } else {
      lines.push(`• ${f.informationToCollect}: ${p.informationToCollect.join(', ')}`);
    }
  } else if (section === 3) {
    const faq = (Array.isArray(p.commonQuestions) ? p.commonQuestions : [])
      .map(normalizeFaqItem)
      .filter(Boolean);
    if (!faq.length) {
      lines.push(`• ${f.commonQuestions}: ${s.none}`);
    } else {
      for (const item of faq) {
        lines.push(`• ${f.q}: ${item.question}`);
        lines.push(`  ${f.a}: ${item.answer || f.noAnswer}`);
      }
    }
  } else if (section === 4) {
    const eff = effectiveBehavior(p);
    const toneSet = typeof p.tone === 'string' && p.tone.trim();
    const tone = toneSet ? p.tone.trim() : `${eff.tone} ${s.defaultMark}`;
    const lenSet = normalizeResponseLength(p.responseLength);
    const priceSet = normalizePriceDisclosure(p.priceDisclosure);
    const len = s.responseLengthLabels[eff.responseLength];
    const price = s.priceDisclosureLabels[eff.priceDisclosure];
    lines.push(`• ${f.tone}: ${tone}`);
    lines.push(`• ${f.responseLength}: ${lenSet ? len : `${len} ${s.defaultMark}`}`);
    lines.push(`• ${f.priceDisclosure}: ${priceSet ? price : `${price} ${s.defaultMark}`}`);
  } else if (section === 5) {
    const id = assistantIdentityView(p);
    lines.push(`• ${f.assistantName}: ${id.assistantName || f.noName}`);
    lines.push(
      `• ${f.openingMessage}: ${
        id.openingMessage ? `“${id.openingMessage}”` : f.defaultOpening(p.name)
      }`
    );
  }
  return lines;
}

/**
 * Section view (1–5). Before first approval, shows the merged draft. After
 * approval, shows live values; when an unapproved draft changes this section,
 * shows live and pending separately.
 */
export function renderSection(section, profile) {
  const s = STRINGS;
  const title = s.sections[section - 1];
  const draft = profile?.draft;
  if (!profile?.approvedAt) {
    const view = draft ? mergeDraft(profile, draft) : profile;
    return [title, s.current, ...sectionLines(section, view), '', s.ask].join('\n');
  }
  const live = sectionLines(section, profile);
  let pending = null;
  if (draft && draftDiffersFromLive(profile, draft)) {
    const p = sectionLines(section, mergeDraft(profile, draft));
    if (p.join('\n') !== live.join('\n')) pending = p;
  }
  const parts = [title];
  if (pending) {
    parts.push(s.live, ...live, '', s.pending, ...pending);
  } else {
    parts.push(s.current, ...live);
  }
  parts.push('', s.ask);
  return parts.join('\n');
}
