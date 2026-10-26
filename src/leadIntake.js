/**
 * "Get this bot for my business" lead questionnaire. Fixed questions, no LLM.
 * Separate from the Builder: never reads or writes the profile draft,
 * buildHistory, or Builder prompts.
 *
 * session.leadIntake is null, an in-progress `{ step, answers }`, or
 * `{ submittedAt, resumeMenu? }` once a lead was saved (one lead per sender).
 * resumeMenu: the next BUILD message shows the owner menu.
 */

export const LEAD_MENU_LABEL = 'Get this bot for my business';
export const LEAD_INTRO = "Awesome! So glad the bot caught your interest 🙌";
export const LEAD_BRIDGE =
  "Great! To get things moving, I'd love you to answer a few quick questions 😊";
export const LEAD_THANKS_YES = "Thanks! We'll get back to you soon 🙏";
export const LEAD_THANKS_NO = "Thanks! We got your details 🙏";
export const LEAD_ALREADY_SENT = "You've already sent your request. We'll get back to you soon.";

const QUESTIONS = {
  contactConsent: {
    text: 'Can we contact you on this number to follow up and help you get started? 📞',
    options: ['✅ Yes, sure', '❌ No, thanks'],
    multi: false,
    next: 'channels',
    nextIntro: LEAD_BRIDGE,
  },
  channels: {
    text: 'Where would you like the bot to work? (you can pick more than one, e.g. "1, 3")',
    options: ['💬 WhatsApp', '📸 Instagram', '💙 Facebook Messenger', '🌐 My business website', '💡 Other (tell us where)'],
    multi: true,
    followUp: {
      option: 5,
      step: 'channelsOther',
      text: "Tell me briefly where you'd like the bot to work, for example Telegram or your Google Business page.",
    },
    next: 'actions',
  },
  actions: {
    text: 'What would you like the bot to do beyond answering questions? ✨ (you can pick more than one)',
    options: [
      '📅 Book meetings or appointments',
      '📝 Collect details from interested customers',
      '🙋 Hand conversations over to a human agent',
      '🔗 Connect to a calendar or an existing system',
      '💡 Other (tell us more)',
    ],
    multi: true,
    followUp: {
      option: 5,
      step: 'actionsOther',
      text: "Tell me briefly what else you'd like the bot to do for you, for example send appointment reminders.",
    },
    next: 'dailyInquiries',
  },
  dailyInquiries: {
    text: 'About how many customer inquiries do you get per day?',
    options: ['Up to 5', '5-20', '20-50', 'More than 50', 'Not sure'],
    multi: false,
    next: 'chatTools',
  },
  chatTools: {
    text: 'Do you already use a tool to manage your customer chats? 💬',
    options: [
      '❌ No, I reply to customers myself',
      '📱 Yes, the WhatsApp Business app',
      '🤖 Yes, a bot or automation platform (for example ManyChat)',
      '💡 Other (tell us which)',
    ],
    multi: false,
    followUp: {
      option: 4,
      step: 'chatToolsOther',
      text: 'Tell me briefly which tool you use, for example ManyChat or a CRM.',
    },
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

/** Stored / admin labels omit the leading option emoji. */
function optionStoreLabel(label) {
  return String(label).replace(/^\p{Extended_Pictographic}\uFE0F?\s+/u, '');
}

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

/** After a save, the next BUILD message should show the owner menu. */
export function leadResumePending(state) {
  return !!state?.submittedAt && state.resumeMenu === true;
}

export function startLeadIntake() {
  const first = 'contactConsent';
  return { state: { step: first, answers: {} }, reply: `${LEAD_INTRO}\n\n${renderQuestion(first)}` };
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
      reply: `${q.multi ? INVALID_MULTI : INVALID}\n\n${renderQuestion(step)}`,
      done: false,
    };
  }
  const labels = picks.map((n) => optionStoreLabel(q.options[n - 1]));
  answers[step] = q.multi ? labels : labels[0];
  if (q.followUp && picks.includes(q.followUp.option)) {
    return { state: { step: q.followUp.step, answers }, reply: q.followUp.text, done: false };
  }
  return advance(q.next, answers, q.nextIntro);
}

function closingThanks(answers) {
  const yesLabel = optionStoreLabel(QUESTIONS.contactConsent.options[0]);
  return answers.contactConsent === yesLabel ? LEAD_THANKS_YES : LEAD_THANKS_NO;
}

function advance(next, answers, intro = null) {
  if (!next) return { state: { step: null, answers }, reply: closingThanks(answers), done: true };
  const question = renderQuestion(next);
  return {
    state: { step: next, answers },
    reply: intro ? `${intro}\n\n${question}` : question,
    done: false,
  };
}
