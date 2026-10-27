import { LEAD_MENU_LABEL } from './copy.js';
import {
  composeReply,
  sectionLines,
  summaryLines,
} from './composeReply.js';

/**
 * App-rendered owner navigation: editing menu, section views, save card,
 * and return-to-editing messages. Templates only (no LLM).
 * Navigation never modifies the profile or draft.
 * Reply text is assembled by `composeReply`.
 */

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

/** One pair of surrounding WhatsApp bold asterisks, if present. */
export function unwrapWhatsAppBold(text) {
  const t = String(text || '').trim();
  const m = /^\*([^*]+)\*$/.exec(t);
  return (m ? m[1] : t).trim();
}

/**
 * Menu request: the whole message is `menu` (case-insensitive, optional
 * WhatsApp `*bold*`), or one of the existing extra aliases. `menu.` and
 * `please menu` are not commands.
 */
export function isMenuRequest(text) {
  const inner = unwrapWhatsAppBold(text).toLowerCase();
  if (inner === 'menu') return true;
  const s = normalizeShort(text).replace(/\s*please$/, '');
  if (s === 'menu') return false;
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
  return composeReply({ kind: 'menu', menuOpts }).reply;
}

/** stop (silent /end alias) before the bot is ready: no editing menu during first-time setup. */
export function renderSetupContinue() {
  return composeReply({ kind: 'setup_continue' }).reply;
}

export function renderReturnToEditing(menuOpts) {
  return composeReply({ kind: 'return_to_editing', menuOpts }).reply;
}

export { summaryLines, sectionLines, LEAD_MENU_LABEL };

/** Two review options (1 Chat with me like a customer, 2 Keep teaching me). */
export function renderReviewOptions() {
  return composeReply({ kind: 'review_options' }).reply;
}

/**
 * Save confirmation: changed lines (new values only), then next-step options.
 */
export function renderSavedChanges(before, after) {
  return composeReply({ kind: 'saved_changes', prior: before, profile: after }).reply;
}

/**
 * First-approval card: the 🏪 business lines, then the two next-step options.
 * No model text. Later edits use renderSavedChanges (changed fields only).
 */
export function renderSetupComplete(profile) {
  return composeReply({ kind: 'setup_complete', profile }).reply;
}

/**
 * Leftover current-bot card (plain Label: value). The session path no longer
 * sends this; unchanged post-approval turns use renderChangeMenu.
 */
export function renderReview(profile) {
  return composeReply({ kind: 'review', profile }).reply;
}

/** "Make changes" reply: ask, then the full editing menu. */
export function renderChangeMenu(menuOpts) {
  return composeReply({ kind: 'change_menu', menuOpts }).reply;
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

/**
 * Section view (1–3). Shows the current values (merged draft = live after save).
 */
export function renderSection(section, profile) {
  return composeReply({ kind: 'section', profile, parts: { section } }).reply;
}
