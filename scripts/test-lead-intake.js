/**
 * Lead questionnaire ("Get this bot for my business"): parsing, state machine,
 * session hooks, and memory-store lead record. No API calls.
 */
import assert from 'assert';
import { emptyProfile } from '../src/profile.js';
import {
  LEAD_BRIDGE,
  LEAD_INTRO,
  LEAD_MENU_LABEL,
  LEAD_THANKS_NO,
  LEAD_THANKS_YES,
  parseChoices,
  startLeadIntake,
  stepLeadIntake,
} from '../src/leadIntake.js';
import { leadWhatToDoQuestion } from '../src/copy.js';
import { renderMenu } from '../src/ownerNav.js';
import { createSenderSession, handleMessage } from '../src/session.js';
import { createMemoryStore } from '../src/store/memoryStore.js';

// Parsing: numbers only
assert.deepEqual(parseChoices('1, 3', 5, true), [1, 3]);
assert.deepEqual(parseChoices('3 1 3', 5, true), [1, 3]);
assert.deepEqual(parseChoices('2,4', 5, true), [2, 4]);
assert.equal(parseChoices('1, 6', 5, true), null);
assert.equal(parseChoices('whatsapp', 5, true), null);
assert.equal(parseChoices('', 5, true), null);
assert.deepEqual(parseChoices('2.', 5, false), [2]);
assert.equal(parseChoices('1 2', 5, false), null);
assert.equal(parseChoices('0', 2, false), null);

// State machine
let { state, reply } = startLeadIntake();
assert.ok(reply.startsWith(LEAD_INTRO));
assert.ok(!reply.includes('To get it set up for you'));
assert.ok(reply.includes('Can we contact you on this number'));
assert.ok(reply.includes('1. ✅ Yes, sure'));
assert.ok(reply.includes('2. ❌ No, thanks'));
let r = stepLeadIntake(state, 'yes please');
assert.equal(r.state.step, 'contactConsent');
assert.ok(r.reply.includes('1. ✅ Yes, sure'));
assert.ok(!r.reply.includes(LEAD_INTRO));
r = stepLeadIntake(r.state, '1');
assert.equal(r.done, false);
assert.equal(r.state.step, 'whatToDo');
assert.equal(r.state.answers.contactConsent, 'Yes, sure');
assert.equal(r.reply, leadWhatToDoQuestion(''));
r = stepLeadIntake(r.state, '');
assert.equal(r.done, false);
assert.equal(r.state.step, 'whatToDo');
assert.equal(r.reply, leadWhatToDoQuestion(''));
r = stepLeadIntake(r.state, 'Answer questions and pass on bookings');
assert.equal(r.done, false);
assert.equal(r.state.step, 'channels');
assert.equal(r.state.answers.whatToDo, 'Answer questions and pass on bookings');
assert.ok(r.reply.startsWith(LEAD_BRIDGE));
assert.ok(r.reply.includes('Where would you like me to work?'));
assert.ok(r.reply.includes('1. 💬 WhatsApp'));
r = stepLeadIntake(r.state, '1, 5');
assert.equal(r.state.step, 'channelsOther');
assert.equal(
  r.reply,
  "Tell me briefly where you'd like me to work, for example Telegram or your Google Business page."
);
r = stepLeadIntake(r.state, 'Telegram');
assert.equal(r.state.step, 'actions');
assert.ok(r.reply.includes('beyond answering questions? ✨'));
assert.ok(r.reply.includes('1. 📅 Book meetings or appointments'));
r = stepLeadIntake(r.state, '2 3');
assert.equal(r.state.step, 'dailyInquiries');
r = stepLeadIntake(r.state, '1, 2');
assert.equal(r.state.step, 'dailyInquiries');
r = stepLeadIntake(r.state, '3');
assert.equal(r.state.step, 'chatTools');
assert.ok(r.reply.includes('Do you already use a tool to manage your customer chats?'));
r = stepLeadIntake(r.state, '4');
assert.equal(r.state.step, 'chatToolsOther');
assert.equal(r.reply, 'Tell me briefly which tool you use, for example ManyChat or a CRM.');
r = stepLeadIntake(r.state, 'A booking app');
assert.equal(r.done, true);
assert.equal(r.reply, LEAD_THANKS_YES);
assert.deepEqual(r.state.answers, {
  contactConsent: 'Yes, sure',
  whatToDo: 'Answer questions and pass on bookings',
  channels: ['WhatsApp', 'Other (tell us where)'],
  channelsOther: 'Telegram',
  actions: ['Collect details from interested customers', 'Hand conversations over to a human agent'],
  dailyInquiries: '20-50',
  chatTools: 'Other (tell us which)',
  chatToolsOther: 'A booking app',
});

// Consent no still continues; closing uses the stored consent answer
r = stepLeadIntake({ step: 'contactConsent', answers: {} }, '2');
assert.equal(r.done, false);
assert.equal(r.state.step, 'whatToDo');
assert.equal(r.reply, leadWhatToDoQuestion(''));
assert.equal(r.state.answers.contactConsent, 'No, thanks');
r = stepLeadIntake(r.state, 'Just answer questions');
assert.equal(r.state.step, 'channels');
assert.ok(r.reply.startsWith(LEAD_BRIDGE));
assert.equal(r.state.answers.whatToDo, 'Just answer questions');
r = stepLeadIntake({ step: 'chatTools', answers: { contactConsent: 'No, thanks' } }, '1');
assert.equal(r.done, true);
assert.equal(r.reply, LEAD_THANKS_NO);
assert.equal(r.state.answers.contactConsent, 'No, thanks');

// Menu: item 1 only when requested
assert.ok(!renderMenu().includes(LEAD_MENU_LABEL));
assert.ok(
  renderMenu({ leadOption: true }).startsWith(`1. 🚀 ${LEAD_MENU_LABEL}\n2. 🤖 Chat with me like a customer\n`)
);

// Session flow (memory store)
const store = createMemoryStore();
const sender = 'whatsapp:+15550000001';
const profile = {
  ...emptyProfile(),
  name: 'Test Studio',
  approvedAt: new Date().toISOString(),
  firstTestedAt: new Date().toISOString(),
};
await store.saveProfile(sender, profile);
const menuEntry = {
  role: 'assistant',
  content: renderMenu({ leadOption: true, chatsOption: true }),
  nav: 'menu',
};
await store.saveSession(sender, {
  mode: 'BUILD',
  buildHistory: [menuEntry],
  testHistory: [],
  testSessionId: 't',
});

async function send(text) {
  const session = await createSenderSession(store, sender);
  const res = await handleMessage(session, text);
  await store.saveSession(sender, session);
  return res;
}

const profileBefore = JSON.stringify(await store.loadProfile(sender));

// Cancel with "menu": nothing saved, menu shown, item 1 still offered
let res = await send('1');
assert.equal(res.event, 'lead_question');
assert.ok(res.reply.startsWith(LEAD_INTRO));
assert.ok(res.reply.includes('Can we contact you on this number'));
assert.ok(!res.reply.includes('To get it set up for you'));
res = await send('menu');
assert.equal(res.event, 'lead_cancelled');
assert.ok(res.reply.includes(`1. 🚀 ${LEAD_MENU_LABEL}`));
assert.equal(Object.keys(store._dump().leads).length, 0);

// Cancel with stop
await send('1');
await send('1');
res = await send('stop');
assert.equal(res.event, 'enter_build');
assert.ok(res.reply.includes(`1. 🚀 ${LEAD_MENU_LABEL}`));
assert.equal((await store.loadSession(sender)).leadIntake, null);
assert.equal(Object.keys(store._dump().leads).length, 0);

// Full run
await send('1');
res = await send('1');
assert.equal(res.event, 'lead_question');
assert.equal(res.reply, leadWhatToDoQuestion('Test Studio'));
res = await send('Answer questions and pass on bookings');
assert.equal(res.event, 'lead_question');
assert.ok(res.reply.startsWith(LEAD_BRIDGE));
assert.ok(res.reply.includes('Where would you like me to work?'));
await send('1 4');
res = await send('5');
assert.equal(
  res.reply,
  "Tell me briefly what else you'd like me to do for you, for example send appointment reminders."
);
await send('Track orders');
res = await send('lots');
assert.ok(res.reply.startsWith('Please reply with the number of your choice.'));
await send('5');
res = await send('1');
assert.equal(res.event, 'lead_saved');
assert.equal(res.reply, LEAD_THANKS_YES);
assert.equal((await store.loadSession(sender)).leadIntake.resumeMenu, true);
assert.ok(!res.reply.includes('Tell me more about your business'));
assert.ok(!res.reply.includes('Chat with me like a customer'));
assert.ok(!res.reply.includes(LEAD_MENU_LABEL));

const lead = store._dump().leads[sender];
assert.equal(lead.senderId, sender);
assert.equal(lead.businessName, 'Test Studio');
assert.ok(lead.createdAt);
assert.deepEqual(lead.answers, {
  contactConsent: 'Yes, sure',
  whatToDo: 'Answer questions and pass on bookings',
  channels: ['WhatsApp', 'My business website'],
  actions: ['Other (tell us more)'],
  actionsOther: 'Track orders',
  dailyInquiries: 'Not sure',
  chatTools: 'No, I reply to customers myself',
});

// Builder state untouched
const sess = await store.loadSession(sender);
assert.equal(sess.buildHistory.filter((m) => m.role === 'user').length, 0);
assert.equal(JSON.stringify(await store.loadProfile(sender)), profileBefore);

// Next BUILD message shows the editing menu (no lead item), then 2 is business info
res = await send('hello');
assert.equal(res.event, 'menu');
assert.equal(
  res.reply,
  [
    'What should we do next?',
    '',
    '1. 🤖 Chat with me like a customer',
    '2. 📋 See what customers asked me today',
    '3. 🏪 Tell me more about your business',
    '4. ❓ Teach me more questions and answers',
    '5. 📝 Choose details to collect from customers',
    '6. 💬 Tell me how to talk to your customers',
    '',
    'Pick a number, or just tell me what you want me to learn.',
  ].join('\n')
);
assert.ok(!res.reply.includes(LEAD_MENU_LABEL));
assert.equal((await store.loadSession(sender)).leadIntake.resumeMenu, undefined);
res = await send('3');
assert.equal(res.event, 'menu_section');
assert.ok(res.reply.startsWith('🏪 This is what I know about your business:\n\n'), res.reply);
assert.ok((await store.loadSession(sender)).leadIntake.submittedAt);

// Not offered before first approval: 7 falls through to the Builder
const sender2 = 'whatsapp:+15550000002';
await store.saveSession(sender2, {
  mode: 'BUILD',
  buildHistory: [menuEntry],
  testHistory: [],
  testSessionId: 't',
});
let builderCalled = false;
const s2 = await createSenderSession(store, sender2, {
  deps: {
    runBuilderTurn: async ({ profile: p }) => {
      builderCalled = true;
      return { message: 'ok', draft: p.draft, source: 'mock' };
    },
  },
});
res = await handleMessage(s2, '7');
assert.equal(builderCalled, true);
assert.equal(s2.leadIntake, null);

// /reset clears this sender's lead so 🚀 can show after a new first setup
const otherSender = 'whatsapp:+15550000003';
await store.saveProfile(otherSender, {
  ...emptyProfile(),
  name: 'Other Studio',
  approvedAt: new Date().toISOString(),
});
await store.saveLead(otherSender, {
  senderId: otherSender,
  businessName: 'Other Studio',
  answers: { contactConsent: 'Yes, sure' },
  createdAt: '2026-01-01T00:00:00.000Z',
});
await store.saveSession(otherSender, {
  mode: 'BUILD',
  buildHistory: [],
  testHistory: [],
  testSessionId: 't',
  leadIntake: { submittedAt: '2026-01-01T00:00:00.000Z' },
});

res = await send('/reset');
assert.equal(res.event, 'reset');
assert.equal((await store.loadSession(sender)).leadIntake, null);
assert.equal(store._dump().leads[sender], undefined);
assert.ok(store._dump().leads[otherSender], 'other sender lead stays');
assert.equal(
  (await store.loadSession(otherSender)).leadIntake.submittedAt,
  '2026-01-01T00:00:00.000Z'
);

const setupDraft = {
  name: 'Ofir Baber',
  whatWeDo: 'Barber',
  services: [{ name: 'Haircut', price: '50', notes: null }],
  hours: 'Mon–Fri 9–5',
  locationOrArea: 'Tel Aviv',
  commonQuestions: [{ question: 'Price?', answer: 'Ask in the shop.' }],
  informationToCollect: null,
  unknowns: [],
};
const setup = await createSenderSession(store, sender, {
  deps: {
    runBuilderTurn: async () => ({
      message: 'Got it, thanks!',
      draft: setupDraft,
      ownerName: 'Ofir',
      readyForReview: true,
      source: 'stub-builder',
    }),
  },
});
const opened = await handleMessage(setup, 'hello');
assert.equal(opened.event, 'opening');
const first = await handleMessage(setup, "I'm a barber");
await store.saveSession(sender, setup);
assert.ok((await store.loadProfile(sender)).approvedAt);
assert.match(first.reply, /I'm ready for a first try, Ofir!/);
assert.ok(!first.reply.includes(LEAD_MENU_LABEL));
assert.doesNotMatch(first.reply, /Got it, thanks!|I'll remember that/);
const entered = await handleMessage(setup, 'chat with me like a customer');
assert.equal(entered.event, 'enter_test');
const stopped = await handleMessage(setup, 'stop');
await store.saveSession(sender, setup);
assert.equal(stopped.event, 'enter_build');
assert.ok(
  (stopped.replies || [stopped.reply]).join('\n').includes(`1. 🚀 ${LEAD_MENU_LABEL}`),
  stopped.replies ? stopped.replies.join('\n') : stopped.reply
);

// Control: submit without reset → Stop still hides 🚀
const sender4 = 'whatsapp:+15550000004';
await store.saveProfile(sender4, {
  ...emptyProfile(),
  name: 'Control Studio',
  whatWeDo: 'Cuts',
  approvedAt: new Date().toISOString(),
  firstTestedAt: new Date().toISOString(),
});
await store.saveSession(sender4, {
  mode: 'BUILD',
  buildHistory: [
    { role: 'assistant', content: renderMenu({ leadOption: true, chatsOption: true }), nav: 'menu' },
  ],
  testHistory: [],
  testSessionId: 't',
});
async function send4(text) {
  const s = await createSenderSession(store, sender4);
  const out = await handleMessage(s, text);
  await store.saveSession(sender4, s);
  return out;
}
let r4 = await send4('1');
assert.equal(r4.event, 'lead_question');
r4 = await send4('1');
assert.equal(r4.reply, leadWhatToDoQuestion('Control Studio'));
r4 = await send4('Answer questions');
r4 = await send4('1');
r4 = await send4('2');
r4 = await send4('5');
r4 = await send4('1');
assert.equal(r4.event, 'lead_saved');
r4 = await send4('/test');
assert.equal(r4.event, 'enter_test');
r4 = await send4('stop');
assert.equal(r4.event, 'enter_build');
assert.ok(!(r4.replies || [r4.reply]).join('\n').includes(LEAD_MENU_LABEL));

// Menu without firstTestedAt must not start lead on 1 (even if last menu listed it).
const senderNoTest = 'whatsapp:+15550000005';
await store.saveProfile(senderNoTest, {
  ...emptyProfile(),
  name: 'No Test Studio',
  approvedAt: new Date().toISOString(),
});
await store.saveSession(senderNoTest, {
  mode: 'BUILD',
  buildHistory: [menuEntry],
  testHistory: [],
  testSessionId: 't',
});
const sNoTest = await createSenderSession(store, senderNoTest);
const noLead = await handleMessage(sNoTest, '1');
assert.notEqual(noLead.event, 'lead_question');
assert.equal(sNoTest.leadIntake, null);

console.log('test-lead-intake: all passed');
