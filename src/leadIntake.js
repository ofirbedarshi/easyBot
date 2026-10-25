/**
 * "Get this bot for my business" lead questionnaire. Fixed questions, no LLM,
 * English only. Separate from the Builder: never reads or writes the profile
 * draft, buildHistory, or Builder prompts.
 *
 * session.leadIntake is null, an in-progress `{ step, answers }`, or
 * `{ submittedAt }` once a lead was saved (one lead per sender).
 */

export const LEAD_MENU_LABEL = 'Get this bot for my business';
export const LEAD_THANKS = "Thanks! We'll get back to you soon.";
export const LEAD_ALREADY_SENT = "You've already sent your request. We'll get back to you soon.";

const QUESTIONS = {
  channels: {
    text: 'Where would you like the bot to work? (you can pick more than one, e.g. "1, 3")',
    options: ['WhatsApp', 'Instagram', 'Facebook Messenger', 'My business website', 'Other'],
    multi: true,
    followUp: { option: 5, step: 'channelsOther', text: 'Where else would you like the bot to work?' },
    next: 'actions',
  },
  actions: {
    text: 'What would you like the bot to do beyond answering questions? (you can pick more than one)',
    options: [
      'Book meetings or appointments',
      'Collect details from interested customers',
      'Hand conversations over to a human agent',
      'Connect to a calendar or an existing system',
      'Something else',
    ],
    multi: true,
    followUp: { option: 5, step: 'actionsOther', text: 'What else would you like the bot to do?' },
    next: 'dailyInquiries',
  },
  dailyInquiries: {
    text: 'About how many customer inquiries do you get per day?',
    options: ['Up to 5', '5-20', '20-50', 'More than 50', 'Not sure'],
    multi: false,
    next: 'system',
  },
  system: {
    text: 'Do you currently use a system for managing customers or appointments?',
    options: ['No', 'Yes'],
    multi: false,
    followUp: { option: 2, step: 'systemName', text: 'Which system do you use?' },
    next: null,
  },
};

const FOLLOW_UPS = Object.fromEntries(
  Object.entries(QUESTIONS)
    .filter(([, q]) => q.followUp)
    .map(([id, q]) => [q.followUp.step, { parent: id, text: q.followUp.text }])
);

const INVALID = 'Please reply with the number of your choice.';
const INVALID_MULTI = 'Please reply with one or more numbers, e.g. "1, 3".';

function renderQuestion(id) {
  const q = QUESTIONS[id];
  return [q.text, ...q.options.map((label, i) => `${i + 1}. ${label}`)].join('\n');
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

export function startLeadIntake() {
  const first = 'channels';
  return { state: { step: first, answers: {} }, reply: renderQuestion(first) };
}

/**
 * One questionnaire turn.
 * @returns {{ state: object, reply: string|null, done: boolean }}
 *   done → `state.answers` is complete; caller saves the lead.
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
      reply: `${q.multi ? INVALID_MULTI : INVALID}\n\n${renderQuestion(step)}`,
      done: false,
    };
  }
  const labels = picks.map((n) => q.options[n - 1]);
  answers[step] = q.multi ? labels : labels[0];
  if (q.followUp && picks.includes(q.followUp.option)) {
    return { state: { step: q.followUp.step, answers }, reply: q.followUp.text, done: false };
  }
  return advance(q.next, answers);
}

function advance(next, answers) {
  if (!next) return { state: { step: null, answers }, reply: null, done: true };
  return { state: { step: next, answers }, reply: renderQuestion(next), done: false };
}
