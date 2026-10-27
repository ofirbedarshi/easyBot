/**
 * "Get this bot for my business" lead questionnaire. Fixed questions, no LLM.
 * Separate from the Builder: never reads or writes the profile draft,
 * buildHistory, or Builder prompts.
 *
 * session.leadIntake is null, an in-progress `{ step, answers }`, or
 * `{ submittedAt, resumeMenu? }` once a lead was saved (one lead per sender
 * until `/reset` clears this sender's lead state).
 * resumeMenu: the next BUILD message shows the owner menu.
 */

import {
  LEAD_ALREADY_SENT,
  LEAD_BRIDGE,
  LEAD_INTRO,
  LEAD_MENU_LABEL,
  LEAD_STEPS,
  LEAD_THANKS_NO,
  LEAD_THANKS_YES,
} from './copy.js';
import { composeReply } from './composeReply.js';

export {
  LEAD_ALREADY_SENT,
  LEAD_BRIDGE,
  LEAD_INTRO,
  LEAD_MENU_LABEL,
  LEAD_THANKS_NO,
  LEAD_THANKS_YES,
};

const QUESTIONS = {
  contactConsent: {
    text: LEAD_STEPS.contactConsent.text,
    options: LEAD_STEPS.contactConsent.options,
    multi: false,
    next: 'channels',
    nextIntro: LEAD_BRIDGE,
  },
  channels: {
    text: LEAD_STEPS.channels.text,
    options: LEAD_STEPS.channels.options,
    multi: true,
    followUp: {
      option: 5,
      step: 'channelsOther',
      text: LEAD_STEPS.channels.followUp,
    },
    next: 'actions',
  },
  actions: {
    text: LEAD_STEPS.actions.text,
    options: LEAD_STEPS.actions.options,
    multi: true,
    followUp: {
      option: 5,
      step: 'actionsOther',
      text: LEAD_STEPS.actions.followUp,
    },
    next: 'dailyInquiries',
  },
  dailyInquiries: {
    text: LEAD_STEPS.dailyInquiries.text,
    options: LEAD_STEPS.dailyInquiries.options,
    multi: false,
    next: 'chatTools',
  },
  chatTools: {
    text: LEAD_STEPS.chatTools.text,
    options: LEAD_STEPS.chatTools.options,
    multi: false,
    followUp: {
      option: 4,
      step: 'chatToolsOther',
      text: LEAD_STEPS.chatTools.followUp,
    },
    next: null,
  },
};

const FOLLOW_UPS = Object.fromEntries(
  Object.entries(QUESTIONS)
    .filter(([, q]) => q.followUp)
    .map(([id, q]) => [q.followUp.step, { parent: id, text: q.followUp.text }])
);

/** Stored / admin labels omit the leading option emoji. */
function optionStoreLabel(label) {
  return String(label).replace(/^\p{Extended_Pictographic}\uFE0F?\s+/u, '');
}

/**
 * Numbers only. Multi: "1, 3" / "1 3" / "1,3" (unique, sorted). Single: one
 * number with optional trailing "." or ")". Returns null when invalid.
 */
export function parseChoices(text, max, multi) {
  const s = String(text || '').trim();
  if (!multi) {
    const m = /^(\d+)\s*[.)]?$/.exec(s);
    const n = m ? Number(m[1]) : NaN;
    return n >= 1 && n <= max ? [n] : null;
  }
  if (!/^\d+(\s*[,\s]\s*\d+)*$/.test(s)) return null;
  const nums = [...new Set(s.split(/[,\s]+/).map(Number))].sort((a, b) => a - b);
  return nums.every((n) => n >= 1 && n <= max) ? nums : null;
}

export function leadInProgress(state) {
  return !!state && typeof state.step === 'string';
}

export function leadSubmitted(state) {
  return !!state?.submittedAt;
}

/** After a save, the next BUILD message should show the owner menu. */
export function leadResumePending(state) {
  return !!state?.submittedAt && state.resumeMenu === true;
}

export function startLeadIntake() {
  const first = 'contactConsent';
  return {
    state: { step: first, answers: {} },
    reply: composeReply({ kind: 'lead_start' }).reply,
  };
}

/**
 * One questionnaire turn.
 * @returns {{ state: object, reply: string|null, done: boolean }}
 *   done → `state.answers` is complete; `reply` is the closing thanks.
 */
export function stepLeadIntake(state, text) {
  const answers = { ...state.answers };
  const step = state.step;

  if (FOLLOW_UPS[step]) {
    answers[step] = String(text || '').trim();
    return advance(QUESTIONS[FOLLOW_UPS[step].parent].next, answers);
  }

  const q = QUESTIONS[step];
  const picks = parseChoices(text, q.options.length, q.multi);
  if (!picks) {
    return {
      state: { step, answers },
      reply: composeReply({
        kind: 'lead_invalid',
        parts: { step, multi: q.multi },
      }).reply,
      done: false,
    };
  }
  const labels = picks.map((n) => optionStoreLabel(q.options[n - 1]));
  answers[step] = q.multi ? labels : labels[0];
  if (q.followUp && picks.includes(q.followUp.option)) {
    return {
      state: { step: q.followUp.step, answers },
      reply: composeReply({ kind: 'lead_followup', parts: { text: q.followUp.text } }).reply,
      done: false,
    };
  }
  return advance(q.next, answers, q.nextIntro);
}

function advance(next, answers, intro = null) {
  if (!next) {
    return {
      state: { step: null, answers },
      reply: composeReply({ kind: 'lead_thanks', parts: { answers } }).reply,
      done: true,
    };
  }
  return {
    state: { step: next, answers },
    reply: composeReply({ kind: 'lead_question', parts: { step: next, intro } }).reply,
    done: false,
  };
}
