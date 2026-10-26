import { getClient } from './builder.js';
import { buildCustomerSystemPrompt } from './customerPrompt.js';
import { formatModelReply } from './formatReply.js';
import {
  generateWithIdenticalRetry,
  lastOutgoingMessage,
  messagesWithRetryNote,
} from './identicalReply.js';
import { createChatCompletion } from './openaiChat.js';
import { customerOpeningText } from './profile.js';

/** Most recent history messages sent to the model per Business Bot reply. */
export const BUSINESS_BOT_CONTEXT_MESSAGES = 20;
/** Most recent history messages kept in the stored test conversation. */
export const BUSINESS_BOT_STORED_MESSAGES = 40;

/** First-turn-only: the app already prepends the opening. */
export const FIRST_TURN_SYSTEM =
  'A welcome opening was already sent. Do not greet or introduce yourself; answer the customer\'s message directly.';

/**
 * @param {{ role: string, content: string }[]} history
 * @param {number} limit
 */
export function recentHistory(history, limit) {
  return (history || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }));
}

export function isFirstCustomerTurn(history) {
  return recentHistory(history, BUSINESS_BOT_CONTEXT_MESSAGES).length === 0;
}

/**
 * Chat messages for one Business Bot turn: approved-profile system prompt,
 * bounded conversation history, then the customer question.
 */
export function buildBusinessBotMessages({ profile, history, question }) {
  const messages = [
    { role: 'system', content: buildCustomerSystemPrompt(profile) },
  ];
  if (isFirstCustomerTurn(history)) {
    messages.push({ role: 'system', content: FIRST_TURN_SYSTEM });
  }
  messages.push(...recentHistory(history, BUSINESS_BOT_CONTEXT_MESSAGES));
  messages.push({ role: 'user', content: question });
  return messages;
}

/** Prepend the opening on the first turn of a conversation. */
export function withCustomerOpening(profile, history, reply) {
  const text = (reply || '').trim();
  if (!text || !isFirstCustomerTurn(history)) return text;
  return `${customerOpeningText(profile)}\n\n${text}`;
}

/**
 * @param {{ profile: object, history: object[], question: string, client?: object }} args
 * @returns {Promise<string>}
 */
export async function businessBotReply({ profile, history, question, client }) {
  const openai = client || getClient();
  const messages = buildBusinessBotMessages({ profile, history, question });
  const previousOutgoing = lastOutgoingMessage(history);
  const completeOnce = async (retryNote) => {
    const { completion } = await createChatCompletion(openai, {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: retryNote ? messagesWithRetryNote(messages, retryNote) : messages,
    });
    return formatModelReply(completion.choices?.[0]?.message?.content || '');
  };
  const reply = await generateWithIdenticalRetry({
    generate: completeOnce,
    extractText: (text) => text,
    previousOutgoing,
    label: 'Business Bot',
  });
  return withCustomerOpening(profile, history, reply);
}
