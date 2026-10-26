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
assert.equal(r.state.step, 'channels');
assert.equal(r.state.answers.contactConsent, 'Yes, sure');
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
assert.equal(r.state.step, 'channels');
assert.ok(r.reply.startsWith(LEAD_BRIDGE));
assert.equal(r.state.answers.contactConsent, 'No, thanks');
r = stepLeadIntake({ step: 'chatTools', answers: { contactConsent: 'No, thanks' } }, '1');
assert.equal(r.done, true);
assert.equal(r.reply, LEAD_THANKS_NO);
assert.equal(r.state.answers.contactConsent, 'No, thanks');

// Menu: item 1 only when requested
assert.ok(!renderMenu().includes(LEAD_MENU_LABEL));
assert.ok(
  renderMenu({ leadOption: true }).startsWith(`1. 🚀 ${LEAD_MENU_LABEL}\n2. 🏪 Tell me more about your business\n`)
);

// Session flow (memory store)
const store = createMemoryStore();
const sender = 'whatsapp:+15550000001';
const profile = { ...emptyProfile(), name: 'Test Studio', approvedAt: new Date().toISOString() };
await store.saveProfile(sender, profile);
const menuEntry = { role: 'assistant', content: renderMenu({ leadOption: true }), nav: 'menu' };
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

// Next BUILD message shows the 4-item menu (no lead item), then 1 is Edit business info
res = await send('hello');
assert.equal(res.event, 'menu');
assert.ok(res.reply.includes('Tell me more about your business') && res.reply.includes('Chat with me like a customer'));
assert.ok(!res.reply.includes(LEAD_MENU_LABEL));
assert.equal((await store.loadSession(sender)).leadIntake.resumeMenu, undefined);
res = await send('1');
assert.equal(res.event, 'menu_section');
assert.ok(res.reply.startsWith("Your business\nHere's what I have:"), res.reply);
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

console.log('test-lead-intake: all passed');
