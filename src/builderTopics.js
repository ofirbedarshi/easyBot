import {
  BUSINESS_DETAILS_ACK,
  BUSINESS_DETAILS_EXAMPLE,
  BUSINESS_DETAILS_MARKER,
  BUSINESS_DETAILS_OR_ELSE,
  FAQ_ACK,
  FAQ_QUESTION,
  HOURS_BULLET,
  INTAKE_ACK,
  INTAKE_QUESTION,
  LOCATION_BULLET,
  SERVICE_BULLET,
} from './copy.js';
import { normalizeCommonQuestions } from './profile.js';

/**
 * Topics the Builder must raise before the first review, in asking order.
 * Add a topic here to make the app ask it; the model still extracts the answer.
 * `src/setupAgenda.js` owns when each topic is asked.
 *
 * - question: fixed text the app asks when the topic is still open.
 * - questionFor(draft): builds the question when it depends on the draft.
 * - askedMarker: unique substring used to detect that this question was asked
 *   (needed when questionFor makes the full text vary).
 * - answerHint: sent to the model on the turn right after the app asked it.
 * - isAnswered(draft): the answer is already in the draft.
 * - skippable: settled when the owner provided data for the topic this turn,
 *   or the model returns topicResponse=skipped. A confused / unclear reply
 *   does not settle it.
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

export { BUSINESS_DETAILS_ACK, BUSINESS_DETAILS_MARKER };

export function businessDetailsQuestion(draft) {
  const name = String(draft?.name || '').trim();
  const lines = [];
  if (!hasServices(draft)) lines.push(SERVICE_BULLET);
  if (!hasText(draft?.hours)) lines.push(HOURS_BULLET);
  if (!hasText(draft?.locationOrArea)) lines.push(LOCATION_BULLET);
  return [
    `Tell me a bit more about ${name}, ${BUSINESS_DETAILS_MARKER}`,
    '',
    BUSINESS_DETAILS_EXAMPLE,
    ...lines,
    '',
    BUSINESS_DETAILS_OR_ELSE,
  ].join('\n');
}

const BUSINESS_DETAILS_TOPIC = {
  key: 'businessDetails',
  ack: BUSINESS_DETAILS_ACK,
  questionFor: businessDetailsQuestion,
  askedMarker: BUSINESS_DETAILS_MARKER,
  answerHint: null,
  isAnswered: (draft) => missingBusinessDetails(draft).length === 0,
  skippable: true,
};

export const WRAP_UP_TOPICS = [
  {
    key: 'commonQuestions',
    ack: FAQ_ACK,
    question: FAQ_QUESTION,
    answerHint:
      'The owner was just asked which questions customers usually ask and how you should answer. Store each one in draft.commonQuestions as { question, answer } with the owner\'s full answer. If they skip, have none, or do not know, leave commonQuestions unchanged and do not ask again.',
    isAnswered: (draft) =>
      normalizeCommonQuestions(draft?.commonQuestions).some((q) => q.answer.trim()),
    skippable: true,
  },
  {
    key: 'informationToCollect',
    ack: INTAKE_ACK,
    question: INTAKE_QUESTION,
    answerHint:
      'The owner was just asked whether you should collect details from customers. Set draft.informationToCollect to the listed items, or [] if they said none / no.',
    isAnswered: (draft) => Array.isArray(draft?.informationToCollect),
    skippable: false,
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
