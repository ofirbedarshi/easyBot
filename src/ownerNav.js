import {
  assistantIdentityView,
  draftDiffersFromLive,
  effectiveBehavior,
  mergeDraft,
  normalizeFaqItem,
  normalizePriceDisclosure,
  normalizeResponseLength,
} from './profile.js';

/**
 * App-rendered owner navigation for an already-approved bot: editing menu,
 * section views, and sync / return-to-editing messages. Templates only (no LLM).
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
      'לנסות כלקוח',
    ],
    menuFooter: 'אפשר לבחור מספר או פשוט לכתוב מה רוצים לשנות.',
    synced: 'הבוט עודכן ✅\nאנחנו במצב עריכה. מה תרצה לעשות?',
    syncedInTest:
      'הבוט עודכן ✅ ההודעות הבאות ימשיכו לעבור לבוט הלקוחות. כדי לחזור למצב עריכה כתוב /end.',
    returned: 'חזרנו למצב עריכה. מה תרצה לעשות?',
    setupContinue: 'אנחנו עדיין בהגדרה הראשונית. ספר לי עוד על העסק.',
    ask: 'מה תרצה לשנות?',
    current: 'כרגע:',
    live: 'פעיל כרגע:',
    pending: 'שינוי ממתין לאישור (לא פעיל עד שתאשר):',
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
      'Business details',
      'Assistant role and information to collect',
      'Questions and answers',
      'Conversation style and price disclosure',
      'Assistant name and opening message',
      'Try as a customer',
    ],
    menuFooter: 'Pick a number or just write what you want to change.',
    synced: "Bot updated ✅\nYou're in editing mode. What would you like to do?",
    syncedInTest:
      'Bot updated ✅ Your next messages keep going to the customer bot. Type /end to return to editing mode.',
    returned: 'Back in editing mode. What would you like to do?',
    setupContinue: "We're still in first-time setup. Tell me more about your business.",
    ask: 'What would you like to change?',
    current: 'Current:',
    live: 'Live now:',
    pending: 'Pending change (not live until you approve):',
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

/** Standalone 1–6 (optional trailing "." or ")"), else null. */
export function parseMenuChoice(text) {
  const m = /^\s*([1-6])\s*[.)]?\s*$/.exec(String(text || ''));
  return m ? Number(m[1]) : null;
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
    const he = (s.match(/[\u05D0-\u05EA]/g) || []).length;
    const latin = (s.match(/[A-Za-z]/g) || []).length;
    if (!he && !latin) continue;
    return he >= latin ? 'he' : 'en';
  }
  return 'en';
}

export function renderMenu(lang) {
  const s = t(lang);
  return [...s.menu.map((label, i) => `${i + 1}. ${label}`), '', s.menuFooter].join(
    '\n'
  );
}

export function renderSyncSuccess(lang) {
  return `${t(lang).synced}\n\n${renderMenu(lang)}`;
}

/** Bare success line when the owner's mode is unknown (no mode claim, no menu). */
export function renderSyncDone(lang) {
  return t(lang).synced.split('\n')[0];
}

/** Sync finished while the owner is in TEST mode: no editing-mode claim, no menu. */
export function renderSyncSuccessInTest(lang) {
  return t(lang).syncedInTest;
}

/** /end before anything is approved: no editing menu during first-time setup. */
export function renderSetupContinue(lang) {
  return t(lang).setupContinue;
}

export function renderReturnToEditing(lang) {
  return `${t(lang).returned}\n\n${renderMenu(lang)}`;
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
  } else if (section === 2) {
    lines.push(`• ${f.ownerGoal}: ${val(p.ownerGoal)}`);
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
 * Section view (1–5) of the approved profile. When an unapproved draft changes
 * this section, shows live and pending values separately.
 */
export function renderSection(section, profile, lang) {
  const s = t(lang);
  const title = `${section}. ${s.menu[section - 1]}`;
  const live = sectionLines(section, profile, lang);
  const draft = profile?.draft;
  let pending = null;
  if (profile?.approvedAt && draft && draftDiffersFromLive(profile, draft)) {
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
