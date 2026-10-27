import { normalizeCommonQuestions } from './profile.js';

/**
 * Topics the Builder must raise before the first review, in asking order.
 * Add a topic here to make the app ask it; the model still extracts the answer.
 *
 * - question: fixed text the app asks when the topic is still open.
 * - questionFor(draft): builds the question when it depends on the draft.
 * - askedMarker: unique substring used to detect that this question was asked
 *   (needed when questionFor makes the full text vary).
 * - answerHint: sent to the model on the turn right after the app asked it.
 * - isAnswered(draft): the answer is already in the draft.
 * - skippable: once asked and the owner replied, the topic is settled even
 *   with no answer stored (the owner may decline).
 * - mentions: detects the model asking this topic in its own words, so the app
 *   can swap in the fixed question and record it as asked (null = rely on askingTopic).
 * - phase: 'afterName' is asked as soon as name + whatWeDo are set; wrap-up
 *   topics stay on the wrap-up / continue-required path.
 */
const hasText = (value) => !!String(value || '').trim();

export function hasNameAndWhat(draft) {
  return hasText(draft?.name) && hasText(draft?.whatWeDo);
}

export function hasServices(draft) {
  return Array.isArray(draft?.services) && draft.services.length > 0;
}

/** Details still missing from the profile (services / hours / location). */
export function missingBusinessDetails(draft) {
  const missing = [];
  if (!hasServices(draft)) missing.push('services');
  if (!hasText(draft?.hours)) missing.push('hours');
  if (!hasText(draft?.locationOrArea)) missing.push('location');
  return missing;
}

export const BUSINESS_DETAILS_ACK = 'Nice! ✨';
export const BUSINESS_DETAILS_MARKER = 'so I can answer your customers well 🏪';

const SERVICE_BULLET = '🛠️ What services do you offer, and how much do they cost?';
const HOURS_BULLET = '🕒 What are your opening hours?';
const LOCATION_BULLET = '📍 Where are you located?';

export function businessDetailsQuestion(draft) {
  const name = String(draft?.name || '').trim();
  const lines = [];
  if (!hasServices(draft)) lines.push(SERVICE_BULLET);
  if (!hasText(draft?.hours)) lines.push(HOURS_BULLET);
  if (!hasText(draft?.locationOrArea)) lines.push(LOCATION_BULLET);
  return [
    `Tell me a bit more about ${name}, ${BUSINESS_DETAILS_MARKER}`,
    '',
    'For example:',
    ...lines,
    '',
    "Or anything else you'd like me to know ✨",
  ].join('\n');
}

const BUSINESS_DETAILS_TOPIC = {
  key: 'businessDetails',
  phase: 'afterName',
  ack: BUSINESS_DETAILS_ACK,
  questionFor: businessDetailsQuestion,
  askedMarker: BUSINESS_DETAILS_MARKER,
  answerHint: null,
  isAnswered: (draft) => missingBusinessDetails(draft).length === 0,
  skippable: true,
  mentions: null,
};

export const WRAP_UP_TOPICS = [
  {
    key: 'commonQuestions',
    ack: 'Got it! 💛',
    question:
      'What do customers usually ask you, and how would you like me to answer? 🤔💬\nShare a few in your own words, or say "skip" for now.',
    answerHint:
      'The owner was just asked which questions customers usually ask and how you should answer. Store each one in draft.commonQuestions as { question, answer } with the owner\'s full answer. If they skip, have none, or do not know, leave commonQuestions unchanged and do not ask again.',
    isAnswered: (draft) =>
      normalizeCommonQuestions(draft?.commonQuestions).some((q) => q.answer.trim()),
    skippable: true,
    mentions:
      /\b(common|frequent|usual(ly)?|typical(ly)?|often)\b.{0,40}\b(questions?|ask)|\bquestions?\b.{0,30}\bcustomers?\b.{0,20}\bask/i,
  },
  {
    key: 'informationToCollect',
    ack: 'Perfect, noted! ✨',
    question:
      'One last thing before we wrap up 🙌\nShould I collect any details from customers in the chat? For example, their name, phone number, etc.\nIf not, just say "none".',
    answerHint:
      'The owner was just asked whether you should collect details from customers. Set draft.informationToCollect to the listed items, or [] if they said none / no.',
    isAnswered: (draft) => Array.isArray(draft?.informationToCollect),
    skippable: false,
    mentions: null,
  },
];

export const REQUIRED_TOPICS = [BUSINESS_DETAILS_TOPIC, ...WRAP_UP_TOPICS];

export const WRAP_UP_TOPIC_KEYS = new Set(WRAP_UP_TOPICS.map((t) => t.key));

export function topicByKey(key) {
  return REQUIRED_TOPICS.find((t) => t.key === key) || null;
}

export function topicQuestion(topic, draft) {
  if (!topic) return '';
  if (typeof topic.questionFor === 'function') return topic.questionFor(draft);
  return topic.question || '';
}

/** True when the tell-me-more topic is answered or has already been asked. */
export function businessDetailsSettled(draft, askedTopics = []) {
  const topic = topicByKey('businessDetails');
  if (!topic) return false;
  if (topic.isAnswered(draft)) return true;
  return (askedTopics || []).includes(topic.key);
}

/**
 * First required topic still open for this draft, or null.
 * `priorAskedTopics` are topics the app asked before the current owner message.
 */
export function nextOpenTopic(profile, draft, priorAskedTopics = []) {
  if (profile?.approvedAt) return null;
  const asked = new Set(priorAskedTopics || []);
  const wrapUpStarted = [...asked].some((k) => WRAP_UP_TOPIC_KEYS.has(k));
  for (const topic of REQUIRED_TOPICS) {
    if (topic.phase === 'afterName') {
      if (wrapUpStarted) continue;
      if (!hasNameAndWhat(draft)) continue;
    }
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
      !(t.skippable && (priorAskedTopics || []).includes(t.key)) &&
      (t.phase !== 'afterName' || (hasNameAndWhat(draft) && !wrapUpStarted(priorAskedTopics)))
  );
  const questions = (text.match(/[^.!?。\n]+\?/g) || []).join(' ');
  return (
    open.find((t) => t.key === askingTopic) ||
    open.find((t) => t.mentions?.test(questions)) ||
    null
  );
}

function wrapUpStarted(priorAskedTopics) {
  return (priorAskedTopics || []).some((k) => WRAP_UP_TOPIC_KEYS.has(k));
}

/** Topic whose fixed question the latest assistant message asked, or null. */
export function topicJustAsked(buildHistory) {
  const last = [...(buildHistory || [])].reverse().find((m) => m.role === 'assistant');
  if (!last) return null;
  const content = String(last.content || '');
  return (
    REQUIRED_TOPICS.find((t) => {
      if (t.askedMarker) return content.includes(t.askedMarker);
      return t.question && content.includes(t.question);
    }) || null
  );
}
