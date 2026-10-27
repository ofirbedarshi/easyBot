import {
  BUSINESS_DETAILS_ACK,
  BUSINESS_DETAILS_MARKER,
  businessDetailsQuestionText,
} from './copy.js';

/**
 * Topics the Builder must raise before the first ready menu, in asking order.
 * Add a topic here to make the app ask it; the model still extracts the answer.
 * `src/setupAgenda.js` owns when each topic is asked.
 *
 * - questionFor(draft): builds the question when it depends on the draft.
 * - askedMarker: unique substring used to detect that this question was asked.
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
  return businessDetailsQuestionText(draft?.name);
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

export const REQUIRED_TOPICS = [BUSINESS_DETAILS_TOPIC];

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
