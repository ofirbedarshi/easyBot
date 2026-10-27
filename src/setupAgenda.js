/**
 * Code-owned first-setup agenda. Modeled on lead intake: one ordered list,
 * persisted askedTopics, and a pure advance function. The model extracts
 * facts and may write a short ack; it does not pick the next question.
 *
 * `draft.askedTopics` is the only persisted progress (app-owned).
 * `setupStep` is derived from field presence + that list.
 */
import { IDENTITY_FALLBACK_QUESTION } from './copy.js';
import {
  businessDetailsSettled,
  hasNameAndWhat,
  hasServices,
  topicByKey,
} from './builderTopics.js';

export { IDENTITY_FALLBACK_QUESTION };

export const SETUP_STEPS = Object.freeze(['identity', 'businessDetails', 'complete']);

function askedList(draft, askedTopics) {
  if (Array.isArray(askedTopics)) return askedTopics;
  return Array.isArray(draft?.askedTopics) ? draft.askedTopics : [];
}

/**
 * Current agenda step. `askedTopics` defaults to `draft.askedTopics`
 * (the stored list). During a turn, pass prior-asked so this turn's
 * question is not treated as already settled.
 *
 * Forward-only: once tell-me-more is asked, do not return to identity.
 *
 * @param {object|null|undefined} draft
 * @param {string[]} [askedTopics]
 * @returns {'identity'|'businessDetails'|'complete'}
 */
export function setupStep(draft, askedTopics) {
  const asked = askedList(draft, askedTopics);
  const leftIdentity = hasNameAndWhat(draft) || asked.length > 0;

  if (!hasNameAndWhat(draft) && !leftIdentity) return 'identity';
  if (!businessDetailsSettled(draft, asked)) return 'businessDetails';
  return 'complete';
}

function topicForStep(step) {
  if (step === 'businessDetails') return topicByKey('businessDetails');
  return null;
}

/** Fixed ack only on the first ask, and only if the previous step has an answer. */
function previousStepAnswered(step, draft) {
  if (step === 'businessDetails') return hasNameAndWhat(draft);
  return false;
}

function topicAck(topic, priorAsked, step, draft) {
  if (!topic?.ack) return null;
  if (priorAsked.includes(topic.key)) return null;
  if (!previousStepAnswered(step, draft)) return null;
  return topic.ack;
}

function hasText(value) {
  return !!String(value || '').trim();
}

function detailsGained(before, after) {
  return (
    (hasServices(after) && !hasServices(before)) ||
    (hasText(after?.hours) && !hasText(before?.hours)) ||
    (hasText(after?.locationOrArea) && !hasText(before?.locationOrArea))
  );
}

function justAskedKeyOf(justAsked) {
  if (!justAsked) return null;
  if (typeof justAsked === 'string') return justAsked;
  return justAsked.key || null;
}

/** Stay on a skippable topic only when the owner is answering it this turn. */
function shouldStayOnOptional(topicKey, input, draft) {
  if (justAskedKeyOf(input.justAsked ?? input.justAskedKey) !== topicKey) return false;
  if (input.topicResponse === 'skipped') return false;
  const topic = topicByKey(topicKey);
  if (topic?.isAnswered(draft)) return false;
  const prior = input.priorDraft || {};
  if (topicKey === 'businessDetails' && detailsGained(prior, draft)) return false;
  return true;
}

/**
 * Advance the agenda after extraction. Does not read owner text. The model
 * no longer returns flow flags; this function never did.
 *
 * @returns {{
 *   step: string,
 *   askedTopics: string[],
 *   topic: object|null,
 *   question: string|null,
 *   ack: string|null,
 *   presentComplete: boolean,
 *   stay: boolean,
 *   keepLead: boolean,
 * }}
 */
export function stepSetupAgenda(input = {}) {
  const priorAsked = Array.isArray(input.priorAsked) ? [...input.priorAsked] : [];
  const draft = input.draftAfterExtract || {};
  let step = setupStep(draft, priorAsked);

  if (input.unresolvedConfig) {
    return {
      step,
      askedTopics: priorAsked,
      topic: null,
      question: null,
      ack: null,
      presentComplete: false,
      stay: true,
      keepLead: false,
    };
  }

  if (
    shouldStayOnOptional('businessDetails', input, draft) &&
    priorAsked.includes('businessDetails')
  ) {
    step = 'businessDetails';
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
      keepLead: false,
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
      keepLead: false,
    };
  }

  const topic = topicForStep(step);
  const askedTopics = topic ? [...new Set([...priorAsked, topic.key])] : priorAsked;
  const keepLead =
    step === 'businessDetails' && shouldStayOnOptional('businessDetails', input, draft);
  return {
    step,
    askedTopics,
    topic,
    question: null,
    ack: topicAck(topic, priorAsked, step, draft),
    presentComplete: false,
    stay: false,
    keepLead,
  };
}
