import { LEAD_MENU_LABEL } from './copy.js';
import {
  composeReply,
  menuItems,
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
export function parseMenuChoice(text, max = 9) {
  const m = /^\s*(\d)\s*[.)]?\s*$/.exec(String(text || ''));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= max ? n : null;
}

export { menuItems };

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
 * Navigation on the latest assistant Builder entry (`review`, `menu`,
 * `section:N`), or null. A later reply without `nav` clears the previous
 * card or menu; numbered options are valid only for the reply that showed them.
 */
export function lastShownNav(buildHistory) {
  return lastAssistant(buildHistory)?.nav || null;
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

export function renderReturnToEditing(menuOpts, ownerName) {
  return composeReply({ kind: 'return_to_editing', menuOpts, ownerName }).reply;
}

export { summaryLines, sectionLines, LEAD_MENU_LABEL };

/**
 * Save confirmation: changed lines (new values only), then the main menu.
 */
export function renderSavedChanges(before, after, menuOpts) {
  return composeReply({
    kind: 'saved_changes',
    prior: before,
    profile: after,
    menuOpts,
  }).reply;
}

/** First-ready: opener plus the main menu. */
export function renderReadyFirst(menuOpts, ownerName) {
  return composeReply({ kind: 'ready_first', menuOpts, ownerName }).reply;
}

/**
 * Leftover current-bot card (plain Label: value). The session path no longer
 * sends this; unchanged post-approval turns use renderChangeMenu.
 */
export function renderReview(profile) {
  return composeReply({ kind: 'review', profile }).reply;
}

/** "Make changes" reply: ask, then the full editing menu. */
export function renderChangeMenu(menuOpts, ownerName) {
  return composeReply({ kind: 'change_menu', menuOpts, ownerName }).reply;
}

const TRY_WORDS = new Set(['chat with me like a customer', 'try', 'try it']);

/** "chat with me like a customer" / "try" / "try it" while a menu is showing. */
export function parseReviewChoice(text) {
  const s = normalizeShort(text);
  if (TRY_WORDS.has(s)) return 'try';
  return null;
}

/** Bare digits are menu numbers, not try-words. */
export function isReviewNumberChoice(text) {
  return parseMenuChoice(text, 9) != null;
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

/** True when the latest assistant Builder entry was the two-option review. Dead. */
export function reviewActive(buildHistory) {
  return lastAssistant(buildHistory)?.nav === 'review';
}

/**
 * Section view (1–3). Shows the current values (merged draft = live after save).
 */
export function renderSection(section, profile) {
  return composeReply({ kind: 'section', profile, parts: { section } }).reply;
}
