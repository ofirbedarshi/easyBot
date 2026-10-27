/**
 * Code-owned first-setup agenda. Modeled on lead intake: one ordered list,
 * persisted askedTopics, and a pure advance function. The model extracts
 * facts and may write a short ack; it does not pick the next question.
 *
 * `draft.askedTopics` is the only persisted progress (app-owned, same as
 * today). `setupStep` is derived from field presence + that list.
 */
import { IDENTITY_FALLBACK_QUESTION } from './copy.js';
import { normalizeOwnerGoal } from './profile.js';
import {
  businessDetailsSettled,
  hasNameAndWhat,
  topicByKey,
} from './builderTopics.js';

export { IDENTITY_FALLBACK_QUESTION };

export const SETUP_STEPS = Object.freeze([
  'identity',
  'businessDetails',
  'goal',
  'faq',
  'intake',
  'complete',
]);

const WRAP_UP_ASKED_KEYS = new Set(['commonQuestions', 'informationToCollect']);

function askedList(draft, askedTopics) {
  if (Array.isArray(askedTopics)) return askedTopics;
  return Array.isArray(draft?.askedTopics) ? draft.askedTopics : [];
}

function faqSettled(draft, asked) {
  const topic = topicByKey('commonQuestions');
  return !!(topic && (topic.isAnswered(draft) || asked.includes(topic.key)));
}

function intakeSettled(draft) {
  const topic = topicByKey('informationToCollect');
  return !!(topic && topic.isAnswered(draft));
}

/**
 * Current agenda step. `askedTopics` defaults to `draft.askedTopics`
 * (the stored list). During a turn, pass prior-asked so this turn's
 * question is not treated as already settled.
 *
 * Forward-only: once a wrap-up key is asked or `ownerGoal` is set, do not
 * return to identity / tell-me-more / goal.
 *
 * @param {object|null|undefined} draft
 * @param {string[]} [askedTopics]
 * @returns {'identity'|'businessDetails'|'goal'|'faq'|'intake'|'complete'}
 */
export function setupStep(draft, askedTopics) {
  const asked = askedList(draft, askedTopics);
  const goalSet = !!normalizeOwnerGoal(draft?.ownerGoal);
  const wrapAsked = asked.some((k) => WRAP_UP_ASKED_KEYS.has(k));
  const leftIdentity = hasNameAndWhat(draft) || asked.length > 0 || goalSet || wrapAsked;

  if (!hasNameAndWhat(draft) && !leftIdentity) return 'identity';
  if (!wrapAsked && !goalSet) {
    if (!businessDetailsSettled(draft, asked)) return 'businessDetails';
    return 'goal';
  }
  if (!faqSettled(draft, asked)) return 'faq';
  if (!intakeSettled(draft)) return 'intake';
  return 'complete';
}

function topicForStep(step) {
  if (step === 'businessDetails') return topicByKey('businessDetails');
  if (step === 'faq') return topicByKey('commonQuestions');
  if (step === 'intake') return topicByKey('informationToCollect');
  return null;
}

/**
 * Advance the agenda after extraction. Does not read owner text or model
 * flow flags (`readyForReview`, `wantsReview`, `askingTopic`, `asksQuestion`).
 *
 * @param {{
 *   priorAsked?: string[],
 *   draftAfterExtract?: object,
 *   modelMessage?: string,
 *   unresolvedConfig?: boolean,
 * }} [input]
 * @returns {{
 *   step: string,
 *   askedTopics: string[],
 *   topic: object|null,
 *   question: string|null,
 *   ack: string|null,
 *   presentComplete: boolean,
 *   stay: boolean,
 * }}
 */
export function stepSetupAgenda(input = {}) {
  const priorAsked = Array.isArray(input.priorAsked) ? [...input.priorAsked] : [];
  const draft = input.draftAfterExtract || {};
  const step = setupStep(draft, priorAsked);

  if (input.unresolvedConfig) {
    return {
      step,
      askedTopics: priorAsked,
      topic: null,
      question: null,
      ack: null,
      presentComplete: false,
      stay: true,
    };
  }

  if (step === 'identity') {
    const needsFallback = !/\?/.test(String(input.modelMessage || ''));
    return {
      step,
      askedTopics: priorAsked,
      topic: null,
      question: needsFallback ? IDENTITY_FALLBACK_QUESTION : null,
      ack: null,
      presentComplete: false,
      stay: false,
    };
  }

  if (step === 'goal') {
    return {
      step,
      askedTopics: priorAsked,
      topic: null,
      question: null,
      ack: null,
      presentComplete: false,
      stay: false,
    };
  }

  if (step === 'complete') {
    return {
      step,
      askedTopics: priorAsked,
      topic: null,
      question: null,
      ack: null,
      presentComplete: true,
      stay: false,
    };
  }

  const topic = topicForStep(step);
  const askedTopics = topic ? [...new Set([...priorAsked, topic.key])] : priorAsked;
  return {
    step,
    askedTopics,
    topic,
    question: null,
    ack: topic?.ack || null,
    presentComplete: false,
    stay: false,
  };
}
