/**
 * Normalize model-written reply text for WhatsApp and web chat.
 *
 * The send path does not strip newlines (Twilio body is sliced as-is; web
 * chat uses pre-wrap). Models often still emit one dense block, especially
 * in structured JSON `message`. They may mark breaks with || or real blank
 * lines; this converts either to a single blank line and never leaks the marker.
 */

/** Explicit paragraph token the model may emit in JSON / free-form replies. */
export const PARAGRAPH_MARK = '||';

/** One-line prompt instruction — add once to Builder and Business Bot prompts. */
export const PARAGRAPH_PROMPT_LINE =
  'Write in short paragraphs (1-2 sentences each) separated by a blank line or ||.';

const MARK_RE = /\s*\|\|+\s*/g;

/**
 * @param {unknown} text
 * @returns {string}
 */
export function formatModelReply(text) {
  if (text == null) return '';
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(MARK_RE, '\n\n')
    .replace(/[^\S\n]+\n/g, '\n')
    .replace(/\n[^\S\n]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\|{2,}/g, '')
    .trim();
}
