import { normalizeCommonQuestions } from './profile.js';

/**
 * Topics the Builder must raise before the first review, in asking order.
 * Add a topic here to make the app ask it; the model still extracts the answer.
 *
 * - question: fixed text the app asks when the topic is still open.
 * - answerHint: sent to the model on the turn right after the app asked it.
 * - isAnswered(draft): the answer is already in the draft.
 * - skippable: once asked and the owner replied, the topic is settled even
 *   with no answer stored (the owner may decline).
 * - mentions: detects the model asking this topic in its own words, so the app
 *   can swap in the fixed question and record it as asked (null = rely on askingTopic).
 */
export const REQUIRED_TOPICS = [
  {
    key: 'commonQuestions',
    question:
      'What questions do customers usually ask you, and what do you answer? Share a few in your own words — or say skip if you prefer not to now.',
    answerHint:
      'The owner was just asked which questions customers usually ask and what they answer. Store each one in draft.commonQuestions as { question, answer } with the owner\'s full answer. If they skip, have none, or do not know, leave commonQuestions unchanged and do not ask again.',
    isAnswered: (draft) =>
      normalizeCommonQuestions(draft?.commonQuestions).some((q) => q.answer.trim()),
    skippable: true,
    mentions:
      /\b(common|frequent|usual(ly)?|typical(ly)?|often)\b.{0,40}\b(questions?|ask)|\bquestions?\b.{0,30}\bcustomers?\b.{0,20}\bask/i,
  },
  {
    key: 'informationToCollect',
    question:
      'Before we finalize: should the customer bot collect any information from the customer in chat (for example name, phone number, preferred time)? If yes, list what. If not, say none.',
    answerHint:
      'The owner was just asked whether the bot should collect information from customers. Set draft.informationToCollect to the listed items, or [] if they said none / no.',
    isAnswered: (draft) => Array.isArray(draft?.informationToCollect),
    skippable: false,
    mentions: null,
  },
];

export function topicByKey(key) {
  return REQUIRED_TOPICS.find((t) => t.key === key) || null;
}

/**
 * First required topic still open for this draft, or null.
 * `priorAskedTopics` are topics the app asked before the current owner message.
 */
export function nextOpenTopic(profile, draft, priorAskedTopics = []) {
  if (profile?.approvedAt) return null;
  const asked = new Set(priorAskedTopics || []);
  for (const topic of REQUIRED_TOPICS) {
    if (topic.isAnswered(draft)) continue;
    if (topic.skippable && asked.has(topic.key)) continue;
    return topic;
  }
  return null;
}

/**
 * Open required topic the model's own question is about, or null.
 * Uses the model's askingTopic when it names an open topic, else the text.
 */
export function topicModelAsked(profile, draft, priorAskedTopics, message, askingTopic) {
  const text = String(message || '');
  if (!/\?/.test(text)) return null;
  const open = REQUIRED_TOPICS.filter(
    (t) =>
      !profile?.approvedAt &&
      !t.isAnswered(draft) &&
      !(t.skippable && (priorAskedTopics || []).includes(t.key))
  );
  const questions = (text.match(/[^.!?。\n]+\?/g) || []).join(' ');
  return (
    open.find((t) => t.key === askingTopic) ||
    open.find((t) => t.mentions?.test(questions)) ||
    null
  );
}

/** Topic whose fixed question the latest assistant message asked, or null. */
export function topicJustAsked(buildHistory) {
  const last = [...(buildHistory || [])].reverse().find((m) => m.role === 'assistant');
  if (!last) return null;
  return REQUIRED_TOPICS.find((t) => String(last.content || '').includes(t.question)) || null;
}
