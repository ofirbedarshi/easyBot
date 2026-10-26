/**
 * One-shot guard against sending the same outgoing text twice in a row.
 * Comparison folds whitespace and case. Regeneration is at most once;
 * standing system prompts are not changed.
 */

export const IDENTICAL_REPLY_RETRY_NOTE =
  "Your draft repeated your previous message verbatim. Respond to the user's latest message differently — for example, treat a short answer as the answer to the question just asked, or confirm it.";

/** Fold whitespace and case so "Hello  World" matches "hello world". */
export function normalizeReplyForCompare(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** True when both sides have text and match after whitespace/case folding. */
export function isSameReply(next, previous) {
  const a = normalizeReplyForCompare(next);
  const b = normalizeReplyForCompare(previous);
  return Boolean(a && b && a === b);
}

/** Latest non-empty assistant content in a conversation history. */
export function lastOutgoingMessage(history) {
  if (!Array.isArray(history)) return '';
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return '';
}

/** Append the one-off retry note for this call only. */
export function messagesWithRetryNote(messages, note = IDENTICAL_REPLY_RETRY_NOTE) {
  return [...(messages || []), { role: 'system', content: note }];
}

/**
 * Call `generate()` once. If the extracted text matches the previous outgoing
 * message, call `generate(retryNote)` once more. A still-identical retry is
 * returned as-is (no further loops) and a warning is logged.
 *
 * @template T
 * @param {{
 *   generate: (retryNote?: string) => Promise<T>,
 *   extractText: (result: T) => string,
 *   previousOutgoing?: string,
 *   label?: string,
 *   log?: { warn?: Function },
 * }} args
 * @returns {Promise<T>}
 */
export async function generateWithIdenticalRetry({
  generate,
  extractText,
  previousOutgoing,
  label = 'reply',
  log = console,
} = {}) {
  const first = await generate();
  if (!isSameReply(extractText(first), previousOutgoing)) {
    return first;
  }
  const second = await generate(IDENTICAL_REPLY_RETRY_NOTE);
  if (isSameReply(extractText(second), previousOutgoing)) {
    log.warn?.(
      `${label} identical consecutive reply after one regeneration; sending anyway`
    );
  }
  return second;
}
