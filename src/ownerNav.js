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
  he: {
    menu: [
      'פרטי העסק',
      'תפקיד העוזר ואיסוף פרטים',
      'שאלות ותשובות',
      'סגנון והצגת מחירים',
      'שם העוזר והודעת פתיחה',
      'לנסות את הבוט',
    ],
    menuFooter: 'אפשר לבחור מספר או פשוט לכתוב מה רוצים לשנות.',
    synced: 'הבוט עודכן ✅\nאנחנו במצב עריכה. מה תרצה לעשות?',
    syncedShort: 'הבוט עודכן ✅',
    syncedInTest:
      'הבוט עודכן ✅ ההודעות הבאות ימשיכו לעבור לבוט הלקוחות. כדי לחזור למצב עריכה כתוב /end.',
    returned: 'חזרנו למצב עריכה. מה תרצה לעשות?',
    setupContinue: 'אנחנו עדיין בהגדרה הראשונית. ספר לי עוד על העסק.',
    ask: 'מה תרצה לשנות?',
    current: 'כרגע:',
    live: 'פעיל כרגע:',
    pending: 'שינוי ממתין לאישור (לא פעיל עד שתאשר):',
    was: 'היה',
    notSet: '(לא הוגדר)',
    none: '(אין)',
    defaultMark: '(ברירת מחדל)',
    fields: {
      name: 'שם העסק',
      whatWeDo: 'מה העסק עושה',
      services: 'שירותים',
      hours: 'שעות',
      locationOrArea: 'מיקום / אזור',
      unknowns: 'עדיין לא הוחלט',
      ownerGoal: 'מטרת הבוט',
      informationToCollect: 'פרטים לאסוף מהלקוח',
      intakeNotAnswered: '(עוד לא נקבע)',
      commonQuestions: 'שאלות ותשובות',
      q: 'ש',
      a: 'ת',
      noAnswer: '(אין תשובה שמורה — הבוט לא ימציא)',
      tone: 'סגנון',
      responseLength: 'אורך תשובות',
      priceDisclosure: 'מחירים',
      assistantName: 'שם העוזר',
      noName: '(לא הוגדר — בלי שם)',
      openingMessage: 'הודעת פתיחה',
      defaultOpening: (biz) =>
        `(ברירת מחדל) היכרות קצרה כעוזר הדיגיטלי של ${biz || 'העסק'}`,
    },
    defaultTone: 'ידידותי, ברור ומקצועי',
    responseLengthLabels: { short: 'קצרות', standard: 'רגילות' },
    priceDisclosureLabels: {
      relevant: 'כשזה מועיל ורלוונטי',
      on_request: 'רק כשהלקוח שואל על מחיר',
    },
  },
  en: {
    menu: [
      'Business',
      'Bot goal & customer details',
      'Q&A',
      'Style & prices',
      'Name & opening',
      'Try my bot',
    ],
    menuFooter: 'Pick a number or just write what you want to change.',
    synced: "Bot updated ✅\nYou're in editing mode. What would you like to do?",
    syncedShort: 'Bot updated ✅',
    syncedInTest:
      'Bot updated ✅ Your next messages keep going to the customer bot. Type /end to return to editing mode.',
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
    defaultTone: null,
    responseLengthLabels: { short: 'short', standard: 'standard' },
    priceDisclosureLabels: {
      relevant: 'when useful and relevant',
      on_request: 'only when the customer asks about pricing',
    },
  },
};

function t(lang) {
  return STRINGS[lang] || STRINGS.en;
}

const MENU_REQUESTS = new Set([
  'menu',
  '/menu',
  'main menu',
  'show menu',
  'show the menu',
  'back to menu',
  'back to the menu',
  'options',
  'תפריט',
  'התפריט',
  'הצג תפריט',
  'תראה תפריט',
  'תפריט ראשי',
  'חזרה לתפריט',
  'לתפריט',
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
  const s = normalizeShort(text).replace(/\s*(please|בבקשה)$/, '');
  return MENU_REQUESTS.has(s);
}

/** Standalone 1–max (optional trailing "." or ")"), else null. */
export function parseMenuChoice(text, max = 6) {
  const m = /^\s*(\d)\s*[.)]?\s*$/.exec(String(text || ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= max ? n : null;
}

/** True when the latest assistant Builder entry was a menu. */
export function menuActive(buildHistory) {
  const list = Array.isArray(buildHistory) ? buildHistory : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'assistant') return list[i].nav === 'menu';
  }
  return false;
}

const APPROVE_LIKE = /^(approve|looks good|lgtm|yes|ok|okay|מאשר|מאשרת|אישור|כן|אוקיי)\.?$/i;

/**
 * Owner conversation language from Builder history (owner messages only).
 * Newest owner message with letters decides, skipping commands, approve
 * phrases, menu requests, and bare numbers. Hebrew letters >= Latin → 'he'.
 */
export function ownerLanguage(buildHistory, currentText = null) {
  const owner = (Array.isArray(buildHistory) ? buildHistory : [])
    .filter((m) => m?.role === 'user')
    .map((m) => m.content);
  if (currentText != null) owner.push(currentText);
  for (let i = owner.length - 1; i >= 0; i -= 1) {
    const s = String(owner[i] || '').trim();
    if (!s || s.startsWith('/')) continue;
    if (APPROVE_LIKE.test(s) || isMenuRequest(s) || parseMenuChoice(s)) continue;
    if (parseReviewChoice(s)) continue;
    const he = (s.match(/[\u05D0-\u05EA]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    if (!he && !latin) continue;
    return he >= latin ? 'he' : 'en';
  }
  return 'en';
}

/**
 * Editing menu. `leadOption` appends item 7 (English label in every language);
 * it is last, so hiding it never renumbers the other items.
 */
export function renderMenu(lang, { leadOption = false } = {}) {
  const s = t(lang);
  const items = leadOption ? [...s.menu, LEAD_MENU_LABEL] : s.menu;
  return [...items.map((label, i) => `${i + 1}. ${label}`), '', s.menuFooter].join('\n');
}

export function renderSyncSuccess(lang, menuOpts) {
  return `${t(lang).synced}\n\n${renderMenu(lang, menuOpts)}`;
}

/** Bare success line when the owner's mode is unknown (no mode claim, no menu). */
export function renderSyncDone(lang) {
  return t(lang).syncedShort || t(lang).synced.split('\n')[0];
}

/** Sync finished while the owner is in TEST mode: no editing-mode claim, no menu. */
export function renderSyncSuccessInTest(lang) {
  return t(lang).syncedInTest;
}

/** Short "Bot updated ✅" line (used before entering TEST after menu option 6). */
export function renderSyncedShort(lang) {
  return t(lang).syncedShort;
}

/** /end before anything is approved: no editing menu during first-time setup. */
export function renderSetupContinue(lang) {
  return t(lang).setupContinue;
}

export function renderReturnToEditing(lang, menuOpts) {
  return `${t(lang).returned}\n\n${renderMenu(lang, menuOpts)}`;
}

function textOrNull(v) {
  if (v == null || v === '') return null;
  return String(v);
}

const REVIEW = {
  en: {
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
  },
  he: {
    intro: (name) => `זה הבוט שלך עבור ${name}:`,
    introNoName: 'זה הבוט שלך:',
    labels: {
      business: 'העסק',
      services: 'שירותים',
      area: 'אזור',
      hours: 'שעות',
      unknowns: 'לא הוחלט',
      goal: 'מטרת הבוט',
      intake: 'מבקש מהלקוחות',
      faq: 'שאלות ותשובות',
      style: 'סגנון',
      identity: 'שם ופתיחה',
    },
    notSet: 'לא הוגדר',
    gap: 'לא הוגדר (הבוט יפנה אליך)',
    none: 'אין',
    nothing: 'כלום',
    notDecided: 'עוד לא נקבע',
    faqCount: (n) => `${n} תשובות`,
    faqNone: 'אין עדיין (הבוט יפנה אליך)',
    defaultValue: 'ברירת מחדל',
    shortReplies: 'תשובות קצרות',
    standardReplies: 'תשובות רגילות',
    pricesOnRequest: 'מחירים רק כשמבקשים',
    pricesRelevant: 'מחירים כשרלוונטי',
    customOpening: 'פתיחה מותאמת',
    changesIntro: 'אלה השינויים:',
    was: (v) => `(היה: ${v})`,
    updated: '(עודכן)',
    optionsPrompt: 'מה תרצה לעשות עכשיו?',
    options: ['לנסות את הבוט', 'לעשות שינויים'],
    optionsFooter: 'אפשר לענות 1 או 2, או פשוט לכתוב מה לשנות.',
    changeAsk: 'מה תרצה לשנות?',
  },
};

function r(lang) {
  return REVIEW[lang] || REVIEW.en;
}

/** Same label in every owner language. */
const OTHER_FACTS_LABEL = 'Other facts';

const SUMMARY_MAX = 80;

/** Trim to about SUMMARY_MAX chars at a word boundary; drop a trailing period. */
function brief(text) {
  const s = String(text || '').trim().replace(/\.$/, '');
  if (s.length <= SUMMARY_MAX) return s;
  const cut = s.slice(0, SUMMARY_MAX - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, '')}…`;
}

/**
 * Review summary: one `Label: value` line per item, in editing-menu order
 * (sections 1–5). `full` holds the underlying data so the changes view can
 * detect edits that the trimmed `value` hides.
 */
export function summaryLines(p, lang) {
  const R = r(lang);
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

function changeLines(profile, merged, lang) {
  const R = r(lang);
  const prev = new Map(summaryLines(profile, lang).map((l) => [l.id, l]));
  const lines = [];
  for (const line of summaryLines(merged, lang)) {
    const was = prev.get(line.id);
    if (was && was.full === line.full) continue;
    const suffix = !was ? '' : was.value === line.value ? ` ${R.updated}` : ` ${R.was(was.was)}`;
    lines.push(`${line.label}: ${line.value}${suffix}`);
  }
  return lines;
}

/** Two review options (1 Try my bot, 2 Make changes). */
export function renderReviewOptions(lang) {
  const R = r(lang);
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
export function renderReview(profile, lang) {
  const R = r(lang);
  const draft = profile?.draft;
  const merged = draft ? mergeDraft(profile, draft) : profile || {};
  const parts = [];
  if (profile?.approvedAt && draft && draftDiffersFromLive(profile, draft)) {
    parts.push([R.changesIntro, '', ...changeLines(profile, merged, lang)].join('\n'));
  } else {
    const name = textOrNull(merged.name);
    parts.push(name ? R.intro(name) : R.introNoName);
    parts.push(summaryLines(merged, lang).map((l) => `${l.label}: ${l.value}`).join('\n'));
  }
  parts.push(renderReviewOptions(lang));
  return parts.join('\n\n');
}

/** "Make changes" reply: ask, then the full editing menu. */
export function renderChangeMenu(lang, menuOpts) {
  return `${r(lang).changeAsk}\n\n${renderMenu(lang, menuOpts)}`;
}

const REVIEW_TRY = new Set(['try my bot', 'try', 'try it', 'לנסות את הבוט', 'לנסות']);
const REVIEW_CHANGE = new Set(['make changes', 'change', 'changes', 'לעשות שינויים', 'שינויים']);

/** 1 / "Try my bot" → 'try'; 2 / "Make changes" → 'change'; else null. */
export function parseReviewChoice(text) {
  const m = /^\s*([12])\s*[.)]?\s*$/.exec(String(text || ''));
  if (m) return m[1] === '1' ? 'try' : 'change';
  const s = normalizeShort(text);
  if (REVIEW_TRY.has(s)) return 'try';
  if (REVIEW_CHANGE.has(s)) return 'change';
  return null;
}

/** True when the latest assistant Builder entry was a review (two options). */
export function reviewActive(buildHistory) {
  const list = Array.isArray(buildHistory) ? buildHistory : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'assistant') return list[i].nav === 'review';
  }
  return false;
}

function sectionLines(section, p, lang) {
  const s = t(lang);
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
    const tone = toneSet ? p.tone.trim() : `${s.defaultTone || eff.tone} ${s.defaultMark}`;
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
export function renderSection(section, profile, lang) {
  const s = t(lang);
  const title = `${section}. ${s.menu[section - 1]}`;
  const draft = profile?.draft;
  if (!profile?.approvedAt) {
    const view = draft ? mergeDraft(profile, draft) : profile;
    return [title, s.current, ...sectionLines(section, view, lang), '', s.ask].join(
      '\n'
    );
  }
  const live = sectionLines(section, profile, lang);
  let pending = null;
  if (draft && draftDiffersFromLive(profile, draft)) {
    const p = sectionLines(section, mergeDraft(profile, draft), lang);
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
