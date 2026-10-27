/**
 * All chat-visible scripted copy. Wording is frozen — do not edit for style.
 * The composer (`composeReply.js`) is the only assembler of outgoing replies.
 */

export const OPENING_MESSAGE =
  "Hi, I'm Adam, nice to meet you 👋😊\n\nI'm going to be the one talking to your customers 💬\n\nYou're one of the very first businesses I'm working with, so please be patient with me while I learn 🙈💛\n\nSo let's start by getting to know each other a little, so I can learn about your business ✨\n\nFirst of all, what's your business called, and what does it do?";

export const IDENTITY_FALLBACK_QUESTION =
  "First of all, what's your business called, and what does it do?";

export const OWNER_GOAL_QUESTION =
  "Now tell me, how can I help you the most? 🌟\n\nFor example, I can:\n💬 Answer your customers' questions\n📝 Ask customers for their details and pass them on to you\n\nOr anything else you have in mind 😊";

export const GOAL_FALLBACK_DISCLAIMER =
  "I'd love to! 😊 Right now I can answer your customers' questions and collect their details for you. More is coming soon ✨";

export const OFF_PURPOSE_OWNER_REPLY =
  "I'm here to help small businesses chat with their customers 😊 Want to tell me about your business?";

export const PARSE_FALLBACK_MESSAGE = 'Tell me a bit more about your business.';

export const BUSINESS_DETAILS_ACK = 'Nice! ✨';
export const BUSINESS_DETAILS_MARKER = 'so I can answer your customers well 🏪';
export const SERVICE_BULLET = '🛠️ What services do you offer, and how much do they cost?';
export const HOURS_BULLET = '🕒 What are your opening hours?';
export const LOCATION_BULLET = '📍 Where are you located?';
export const BUSINESS_DETAILS_EXAMPLE = 'For example:';
export const BUSINESS_DETAILS_OR_ELSE = "Or anything else you'd like me to know ✨";

export const FAQ_ACK = 'Got it! 💛';
export const FAQ_QUESTION =
  'What do customers usually ask you, and how would you like me to answer? 🤔💬\nShare a few in your own words, or say "skip" for now.';

export const INTAKE_ACK = 'Perfect, noted! ✨';
export const INTAKE_QUESTION =
  'One last thing before we wrap up 🙌\nShould I collect any details from customers in the chat? For example, their name, phone number, etc.\nIf not, just say "none".';

export const OWNER_GOAL_LABELS = {
  answer_questions: 'Answer customer questions',
  collect_details: 'Collect details from interested customers',
  answer_and_collect: 'Answer customer questions and collect their details',
};

export const PRICE_POLICY_OWNER_LABELS = {
  relevant: "I mention prices when they're relevant",
  on_request: 'I share prices only when a customer asks',
};

export const NAV = {
  menu: [
    '🏪 Tell me more about your business',
    '❓ Teach me more questions and answers',
    '💬 Tell me how to talk to your customers',
    '🤖 Chat with me like a customer',
  ],
  sectionIntros: [
    '🏪 This is what I know about your business:',
    '❓ These are the questions I know how to answer:',
    '💬 This is how I talk to your customers right now:',
  ],
  menuFooter: 'Pick a number, or just tell me what you want me to learn.',
  returned: "I'm back! What should I learn next?",
  setupContinue: "I'm still learning about your business. Tell me more and I'll keep going.",
  ask: 'What do you want to change?',
  menuHint: 'Type *menu* to go back to the main menu.',
  notAdded: 'not added yet',
  noQuestions: 'No questions yet.',
  fields: {
    name: 'Name',
    whatYouDo: 'What you do',
    services: 'Services & prices',
    hours: 'Hours',
    location: 'Location',
    pricePolicy: 'Price policy',
    tone: 'Style',
    openingMessage: 'Opening message',
  },
};

export const REVIEW = {
  intro: (name) => `Here's your bot for ${name}:`,
  introNoName: "Here's your bot:",
  labels: {
    name: 'Name',
    business: 'Business info',
    services: 'Services',
    area: 'Area',
    hours: 'Hours',
    pricePolicy: 'Price policy',
    unknowns: 'Not decided',
    goal: 'My goal',
    intake: "I'll ask customers for",
    faq: 'Q&A',
    talks: 'How I talk',
  },
  notSet: 'not set',
  gap: "not set (I'll send them to you)",
  none: 'none',
  nothing: 'nothing',
  notDecided: 'not decided yet',
  faqCount: (n) => `${n} answer${n === 1 ? '' : 's'}`,
  faqNone: "none yet (I'll send them to you)",
  defaultValue: 'default',
  shortReplies: 'short replies',
  standardReplies: 'standard replies',
  pricesOnRequest: 'prices only when asked',
  pricesRelevant: 'prices when relevant',
  customOpening: 'custom opening',
  changesIntro: "Here's what changed:",
  optionsPrompt: 'What should we do next?',
  options: ['🤖 Chat with me like a customer', '✏️ Keep teaching me'],
  optionsFooter: '(or just tell me what to learn 🙂)',
  changeAsk: 'What should we do next?',
};

export const OTHER_FACTS_LABEL = 'Other facts';

export const SETUP_COMPLETE_INTRO = "🎉 I'm all set! This is what I know about your business:";

export const CHANGE_LABELS = {
  name: NAV.fields.name,
  business: NAV.fields.whatYouDo,
  services: NAV.fields.services,
  hours: NAV.fields.hours,
  area: NAV.fields.location,
  pricePolicy: NAV.fields.pricePolicy,
};

export const RESET_REPLY = "All cleared. Send any message and I'll start fresh.";
export const TEST_REFUSE =
  'Tell me your business name and what you do (or a service) before I can chat as your assistant.';
export const BOT_ERROR_REPLY =
  "Sorry, your bot couldn't answer right now. Please try again in a moment.";
export const BUILDER_ERROR_PREFIX = 'Builder error: ';
export const EMPTY_MESSAGE_ERROR = 'Empty message';
export const GENERIC_ERROR_REPLY =
  'Sorry, something went wrong processing that message. Please try again.';
export const BURST_LIMIT_REPLY =
  "You're sending a bit fast. Wait a few minutes and try again.";
export const FALLBACK_BUSINESS_NAME = 'this business';

export function enterTestBannerText(business) {
  return [
    '🎭 ━━━━━━━━━━━━ 🎭',
    '*Test mode is on*',
    '',
    `Now you're the customer, and I'm ${business}'s assistant.`,
    'Type *stop* when you want to keep teaching me.',
    '🎭 ━━━━━━━━━━━━ 🎭',
  ].join('\n');
}

export function exitTestBannerText() {
  return [
    '🎭 ━━━━━━━━━━━━ 🎭',
    '*Test mode is off*',
    '',
    "I'm back to learning about your business.",
    '🎭 ━━━━━━━━━━━━ 🎭',
  ].join('\n');
}

export function messageTooLongReason(max) {
  return `Message too long (max ${max} characters).`;
}

export const DEFAULT_CUSTOMER_HELP_LINE = 'How can I help you? ✨';

export function defaultCustomerOpeningText(businessName) {
  const biz =
    typeof businessName === 'string' && businessName.trim()
      ? businessName.trim()
      : FALLBACK_BUSINESS_NAME;
  return `Hi! I'm Adam, ${biz}'s digital assistant 😊\n\n${DEFAULT_CUSTOMER_HELP_LINE}`;
}

export const LEAD_MENU_LABEL = 'Get me working for your business';
export const LEAD_INTRO = "Awesome! So glad you're interested 🙌";
export const LEAD_BRIDGE =
  "Great! To get things moving, I'd love you to answer a few quick questions 😊";
export const LEAD_THANKS_YES = "Thanks! We'll get back to you soon 🙏";
export const LEAD_THANKS_NO = "Thanks! We got your details 🙏";
export const LEAD_ALREADY_SENT = "You've already sent your request. We'll get back to you soon.";
export const LEAD_INVALID = 'Please reply with the number of your choice.';
export const LEAD_INVALID_MULTI = 'Please reply with one or more numbers, e.g. "1, 3".';

export const LEAD_STEPS = {
  contactConsent: {
    text: 'Can we contact you on this number to follow up and help you get started? 📞',
    options: ['✅ Yes, sure', '❌ No, thanks'],
  },
  channels: {
    text: 'Where would you like me to work? (you can pick more than one, e.g. "1, 3")',
    options: [
      '💬 WhatsApp',
      '📸 Instagram',
      '💙 Facebook Messenger',
      '🌐 My business website',
      '💡 Other (tell us where)',
    ],
    followUp:
      "Tell me briefly where you'd like me to work, for example Telegram or your Google Business page.",
  },
  actions: {
    text: 'What would you like me to do beyond answering questions? ✨ (you can pick more than one)',
    options: [
      '📅 Book meetings or appointments',
      '📝 Collect details from interested customers',
      '🙋 Hand conversations over to a human agent',
      '🔗 Connect to a calendar or an existing system',
      '💡 Other (tell us more)',
    ],
    followUp:
      "Tell me briefly what else you'd like me to do for you, for example send appointment reminders.",
  },
  dailyInquiries: {
    text: 'About how many customer inquiries do you get per day?',
    options: ['Up to 5', '5-20', '20-50', 'More than 50', 'Not sure'],
  },
  chatTools: {
    text: 'Do you already use a tool to manage your customer chats? 💬',
    options: [
      '❌ No, I reply to customers myself',
      '📱 Yes, the WhatsApp Business app',
      '🤖 Yes, a bot or automation platform (for example ManyChat)',
      '💡 Other (tell us which)',
    ],
    followUp: 'Tell me briefly which tool you use, for example ManyChat or a CRM.',
  },
};
