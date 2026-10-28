/**
 * Owner review of recent TEST-mode customer chats.
 * Dedicated prompt — do not fold this into the Builder or customer prompts.
 */
import { getClient } from './builder.js';
import { recentHistory } from './businessBot.js';
import { GENERIC_ERROR_REPLY } from './copy.js';
import { formatModelReply, PARAGRAPH_PROMPT_LINE } from './formatReply.js';
import {
  generateWithIdenticalRetry,
  lastOutgoingMessage,
  messagesWithRetryNote,
} from './identicalReply.js';
import { createChatCompletion } from './openaiChat.js';

export const DEFAULT_CHATS_WINDOW_HOURS = 3;
export const MAX_REVIEW_CHATS = 8;
export const MAX_MESSAGES_PER_CHAT = 30;
export const REVIEW_CHATS_HISTORY_LIMIT = 10;

export function chatsWindowHours() {
  const n = Number(process.env.EASYBOT_CHATS_WINDOW_HOURS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CHATS_WINDOW_HOURS;
}

export function chatsWindowMs() {
  return chatsWindowHours() * 60 * 60 * 1000;
}

export function reviewChatsActive(state) {
  return !!(state && state.active);
}

function messageTime(row) {
  const t = new Date(row?.created_at || row?.createdAt || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Split stored log rows into TEST conversations.
 * A non-test row (enter_test / stop / menu) starts a new chat.
 * Only `mode === 'test'` rows inside the rolling window are kept.
 *
 * @param {object[]} messages
 * @param {number} [now]
 * @param {number} [windowMs]
 */
export function groupTestChats(
  messages,
  now = Date.now(),
  windowMs = chatsWindowMs()
) {
  const cutoff = now - windowMs;
  const ordered = [...(messages || [])].sort((a, b) => {
    const ida = a.id ?? 0;
    const idb = b.id ?? 0;
    if (ida !== idb) return ida - idb;
    return messageTime(a) - messageTime(b);
  });
  const chats = [];
  let current = [];
  for (const row of ordered) {
    if (row.mode === 'test') {
      if (messageTime(row) >= cutoff) current.push(row);
    } else if (current.length) {
      chats.push(current);
      current = [];
    }
  }
  if (current.length) chats.push(current);
  return chats.slice(-MAX_REVIEW_CHATS).map((chat) => chat.slice(-MAX_MESSAGES_PER_CHAT));
}

export async function loadLoggedMessages(session) {
  if (session?.store && session.senderId && typeof session.store.listMessages === 'function') {
    return session.store.listMessages(session.senderId);
  }
  return Array.isArray(session?.loggedTestMessages) ? session.loggedTestMessages : [];
}

export function formatChatsForPrompt(chats) {
  if (!chats?.length) return 'No customer chats in this window.';
  return chats
    .map((chat, i) => {
      const lines = [`--- Chat ${i + 1} ---`];
      for (const row of chat) {
        const who = row.direction === 'inbound' ? 'Customer' : 'Adam';
        lines.push(`${who}: ${row.body || ''}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

export const REVIEW_CHATS_SYSTEM = `You are Adam, this business's digital assistant. The owner is asking about customer conversations you already had. Write as Adam in first person, in English.

Use only the customer chats provided. Do not invent chats, names, prices, or details that are not in that data. If the owner asks about something that is not in the chats, say you do not have that in these chats.

When writing the report:
- Say how many chats you had.
- For each chat, say what the customer wanted and which details you collected.
- At the end, name anything you could not answer, and invite the owner to teach you so you will know it next time.

${PARAGRAPH_PROMPT_LINE}
Do not add a menu footer. Do not say there were no chats — the app handles that.`;

export function buildReviewChatsMessages({ snapshot, history, question }) {
  const messages = [
    { role: 'system', content: REVIEW_CHATS_SYSTEM },
    { role: 'system', content: `CUSTOMER CHATS:\n${formatChatsForPrompt(snapshot)}` },
  ];
  messages.push(...recentHistory(history, REVIEW_CHATS_HISTORY_LIMIT));
  if (question) {
    messages.push({ role: 'user', content: question });
  } else {
    messages.push({ role: 'user', content: 'Write the report of these customer chats.' });
  }
  return messages;
}

/**
 * @param {{ snapshot: object[][], history?: object[], question?: string|null, client?: object }} args
 * @returns {Promise<string>}
 */
export async function reviewChatsReply({ snapshot, history = [], question = null, client }) {
  const openai = client || getClient();
  const messages = buildReviewChatsMessages({ snapshot, history, question });
  const previousOutgoing = lastOutgoingMessage(history);
  const completeOnce = async (retryNote) => {
    const { completion } = await createChatCompletion(openai, {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: retryNote ? messagesWithRetryNote(messages, retryNote) : messages,
    });
    return formatModelReply(completion.choices?.[0]?.message?.content || '');
  };
  try {
    return await generateWithIdenticalRetry({
      generate: completeOnce,
      extractText: (text) => text,
      previousOutgoing,
      label: 'review-chats',
    });
  } catch (err) {
    console.error(
      'Review chats reply failed:',
      err?.status || err?.code || err?.name || 'error'
    );
    return GENERIC_ERROR_REPLY;
  }
}
