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
  hasServices,
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

/** Fixed ack only on the first ask, and only if the previous step has an answer. */
function previousStepAnswered(step, draft) {
  if (step === 'businessDetails') return hasNameAndWhat(draft);
  if (step === 'faq') return !!normalizeOwnerGoal(draft?.ownerGoal);
  if (step === 'intake') {
    const faq = topicByKey('commonQuestions');
    return !!(faq && faq.isAnswered(draft));
  }
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

function faqGained(before, after) {
  const topic = topicByKey('commonQuestions');
  return !!(topic && topic.isAnswered(after) && !topic.isAnswered(before));
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
  if (topicKey === 'commonQuestions' && faqGained(prior, draft)) return false;
  return true;
}

/**
 * Advance the agenda after extraction. Does not read owner text. The model
 * no longer returns flow flags; this function never did.
 *
 * @param {{
 *   priorAsked?: string[],
 *   draftAfterExtract?: object,
 *   modelMessage?: string,
 *   unresolvedConfig?: boolean,
 *   topicResponse?: string|null,
 *   justAsked?: { key?: string }|string|null,
 *   priorDraft?: object,
 * }} [input]
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
  } else if (
    shouldStayOnOptional('commonQuestions', input, draft) &&
    priorAsked.includes('commonQuestions')
  ) {
    step = 'faq';
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

  if (step === 'goal') {
    return {
      step,
      askedTopics: priorAsked,
      topic: null,
      question: null,
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
    (step === 'businessDetails' && shouldStayOnOptional('businessDetails', input, draft)) ||
    (step === 'faq' && shouldStayOnOptional('commonQuestions', input, draft));
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
