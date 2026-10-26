import {
  assistantIdentityView,
  defaultCustomerOpening,
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
 * App-rendered owner navigation: editing menu, section views, save card,
 * and return-to-editing messages. Templates only (no LLM).
 * Navigation never modifies the profile or draft.
 */

const STRINGS = {
  menu: [
    '🏪 Tell me more about your business',
    '❓ Teach me more questions and answers',
    '💬 Tell me how to talk to your customers',
    '🤖 Chat with me like a customer',
  ],
  sections: ['Your business', 'Questions and answers', 'How I talk'],
  menuFooter: 'Pick a number, or just tell me what you want me to learn.',
  returned: "I'm back! What should I learn next?",
  setupContinue: "I'm still learning about your business. Tell me more and I'll keep going.",
  ask: 'What should we do next?',
  current: "Here's what I have:",
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
    ownerGoal: 'My goal',
    informationToCollect: "I'll ask customers for",
    intakeNotAnswered: '(not decided yet)',
    commonQuestions: 'Questions and answers',
    q: 'Q',
    a: 'A',
    noAnswer: '(no answer recorded — the bot will not invent one)',
    tone: 'Style',
    responseLength: 'Reply length',
    priceDisclosure: 'Prices',
    openingMessage: 'Opening message',
    defaultOpening: (biz) => `(default) “${defaultCustomerOpening({ name: biz })}”`,
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
export function parseMenuChoice(text, max = 5) {
  const m = /^\s*(\d)\s*[.)]?\s*$/.exec(String(text || ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= max ? n : null;
}

/**
 * Ordered editing-menu items: 'lead', sections 1–3 (numbers), 'try'.
 * Rendering and number parsing both use this list, so a picked number always
 * maps to the item shown at that position.
 */
export function menuItems({ leadOption = false } = {}) {
  return [...(leadOption ? ['lead'] : []), 1, 2, 3, 'try'];
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
    item === 'lead' ? `🚀 ${LEAD_MENU_LABEL}` : item === 'try' ? s.menu[3] : s.menu[item - 1];
  return [
    ...menuItems(menuOpts).map((item, i) => `${i + 1}. ${label(item)}`),
    '',
    s.menuFooter,
  ].join('\n');
}

/** /end before the bot is ready: no editing menu during first-time setup. */
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
    business: 'Business info',
    services: 'Services',
    area: 'Area',
    hours: 'Hours',
    unknowns: 'Not decided',
    goal: 'My goal',
    intake: "I'll ask customers for",
    faq: 'Q&A',
    talks: 'How I talk',
  },
  notSet: 'not set',
  gap: "not set (I'll send them to you)",
  none: 'none',
  nothing: 'nothing',
  notDecided: 'not decided yet',
  faqCount: (n) => `${n} answer${n === 1 ? '' : 's'}`,
  faqNone: "none yet (I'll send them to you)",
  defaultValue: 'default',
  shortReplies: 'short replies',
  standardReplies: 'standard replies',
  pricesOnRequest: 'prices only when asked',
  pricesRelevant: 'prices when relevant',
  customOpening: 'custom opening',
  changesIntro: "Got it, I'll remember that! 🌟 Here's what changed:",
  optionsPrompt: 'What should we do next?',
  options: ['🤖 Chat with me like a customer', '✏️ Keep teaching me'],
  optionsFooter: '(or just tell me what to learn 🙂)',
  changeAsk: 'What should we do next?',
};

const OTHER_FACTS_LABEL = 'Other facts';

/** Review line text: trim and drop a trailing period. Do not clip — owners
 *  must be able to see every stored service, fact, and area on WhatsApp. */
function brief(text) {
  return String(text || '').trim().replace(/\.$/, '');
}

/**
 * Review summary: one `Label: value` line per item (business fields, bot goal
 * and intake, Q&A, then how the bot talks). `full` holds the underlying data so
 * the changes view can detect edits that the trimmed `value` hides.
 */
export function summaryLines(p) {
  const R = REVIEW;
  const L = R.labels;
  const out = [];
  const add = (id, label, value, full) =>
    out.push({ id, label, value, full: JSON.stringify(full ?? null) });

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
  add('area', L.area, area ? brief(area) : R.gap, area);
  const hours = textOrNull(p.hours);
  add('hours', L.hours, hours ? brief(hours) : R.gap, hours);
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
    faq
  );

  const tone = typeof p.tone === 'string' && p.tone.trim() ? p.tone.trim() : null;
  const len = normalizeResponseLength(p.responseLength);
  const price = normalizePriceDisclosure(p.priceDisclosure);
  const id = assistantIdentityView(p);
  const talks = [
    tone,
    len === 'short' ? R.shortReplies : len === 'standard' ? R.standardReplies : null,
    price === 'on_request' ? R.pricesOnRequest : price === 'relevant' ? R.pricesRelevant : null,
    id.openingMessage ? R.customOpening : null,
  ].filter(Boolean);
  add(
    'talks',
    L.talks,
    talks.length ? brief(talks.join(', ')) : R.defaultValue,
    { tone, len, price, opening: id.openingMessage }
  );
  return out;
}

function changeLines(profile, merged) {
  const prev = new Map(summaryLines(profile).map((l) => [l.id, l]));
  const lines = [];
  for (const line of summaryLines(merged)) {
    const before = prev.get(line.id);
    if (before && before.full === line.full) continue;
    lines.push(`${line.label}: ${line.value}`);
  }
  return lines;
}

/** Two review options (1 Chat with me like a customer, 2 Keep teaching me). */
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
 * Save confirmation: changed lines (new values only), then next-step options.
 */
export function renderSavedChanges(before, after) {
  const R = REVIEW;
  return [
    [R.changesIntro, '', ...changeLines(before, after)].join('\n'),
    renderReviewOptions(),
  ].join('\n\n');
}

/**
 * Owner-facing current-bot card: short `Label: value` summary, then two options.
 */
export function renderReview(profile) {
  const R = REVIEW;
  const draft = profile?.draft;
  const view = draft ? mergeDraft(profile, draft) : profile || {};
  const name = textOrNull(view.name);
  return [
    name ? R.intro(name) : R.introNoName,
    summaryLines(view).map((l) => `${l.label}: ${l.value}`).join('\n'),
    renderReviewOptions(),
  ].join('\n\n');
}

/** "Make changes" reply: ask, then the full editing menu. */
export function renderChangeMenu(menuOpts) {
  return `${REVIEW.changeAsk}\n\n${renderMenu(menuOpts)}`;
}

const REVIEW_TRY = new Set(['chat with me like a customer', 'try', 'try it']);
const REVIEW_CHANGE = new Set(['keep teaching me', 'change', 'changes']);

const REVIEW_NUMBER = /^\s*([12])\s*[.)]?\s*$/;

/** 1 / "chat with me like a customer" → 'try'; 2 / "keep teaching me" → 'change'; else null. */
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
  } else if (section === 3) {
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
    const id = assistantIdentityView(p);
    lines.push(
      `• ${f.openingMessage}: ${
        id.openingMessage ? `“${id.openingMessage}”` : f.defaultOpening(p.name)
      }`
    );
  }
  return lines;
}

/**
 * Section view (1–3). Shows the current values (merged draft = live after save).
 */
export function renderSection(section, profile) {
  const s = STRINGS;
  const title = s.sections[section - 1];
  return [title, s.current, ...sectionLines(section, profile), '', s.ask].join('\n');
}
