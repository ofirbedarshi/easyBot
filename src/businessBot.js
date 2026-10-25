import { getClient } from './builder.js';
import { buildCustomerSystemPrompt } from './customerPrompt.js';
import { createChatCompletion } from './openaiChat.js';

/** Most recent history messages sent to the model per Business Bot reply. */
export const BUSINESS_BOT_CONTEXT_MESSAGES = 20;
/** Most recent history messages kept in the stored test conversation. */
export const BUSINESS_BOT_STORED_MESSAGES = 40;

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

/**
 * Chat messages for one Business Bot turn: approved-profile system prompt,
 * bounded conversation history, then the customer question.
 */
export function buildBusinessBotMessages({ profile, history, question }) {
  return [
    { role: 'system', content: buildCustomerSystemPrompt(profile) },
    ...recentHistory(history, BUSINESS_BOT_CONTEXT_MESSAGES),
    { role: 'user', content: question },
  ];
}

/**
 * @param {{ profile: object, history: object[], question: string, client?: object }} args
 * @returns {Promise<string>}
 */
export async function businessBotReply({ profile, history, question, client }) {
  const openai = client || getClient();
  const { completion } = await createChatCompletion(openai, {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: buildBusinessBotMessages({ profile, history, question }),
  });
  return (completion.choices?.[0]?.message?.content || '').trim();
}
