/**
 * Lead questionnaire ("Get this bot for my business"): parsing, state machine,
 * session hooks, and memory-store lead record. No API calls.
 */
import assert from 'assert';
import { emptyProfile } from '../src/profile.js';
import {
  LEAD_MENU_LABEL,
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
assert.ok(reply.startsWith('Where would you like the bot to work?'));
let r = stepLeadIntake(state, 'yes please');
assert.equal(r.state.step, 'channels');
assert.ok(r.reply.includes('1. 💬 WhatsApp'));
r = stepLeadIntake(r.state, '1, 5');
assert.equal(r.state.step, 'channelsOther');
assert.equal(
  r.reply,
  "Tell me briefly where you'd like the bot to work, for example Telegram or your Google Business page."
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
assert.equal(r.state.step, 'system');
r = stepLeadIntake(r.state, '2');
assert.equal(r.state.step, 'systemName');
r = stepLeadIntake(r.state, 'A booking app');
assert.equal(r.done, true);
assert.deepEqual(r.state.answers, {
  channels: ['WhatsApp', 'Other (tell us where)'],
  channelsOther: 'Telegram',
  actions: ['Collect details from interested customers', 'Hand conversations over to a human agent'],
  dailyInquiries: '20-50',
  system: 'Yes',
  systemName: 'A booking app',
});

// Menu: item 1 only when requested
assert.ok(!renderMenu().includes(LEAD_MENU_LABEL));
assert.ok(
  renderMenu({ leadOption: true }).startsWith(`1. 🚀 ${LEAD_MENU_LABEL}\n2. 🏪 Edit business info\n`)
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
assert.equal((await send('1')).event, 'lead_question');
let res = await send('menu');
assert.equal(res.event, 'lead_cancelled');
assert.ok(res.reply.includes(`1. 🚀 ${LEAD_MENU_LABEL}`));
assert.equal(Object.keys(store._dump().leads).length, 0);

// Cancel with /end
await send('1');
await send('1');
res = await send('/end');
assert.equal(res.event, 'enter_build');
assert.ok(res.reply.includes(`1. 🚀 ${LEAD_MENU_LABEL}`));
assert.equal((await store.loadSession(sender)).leadIntake, null);
assert.equal(Object.keys(store._dump().leads).length, 0);

// Full run
await send('1');
await send('1 4');
res = await send('5');
assert.equal(
  res.reply,
  "Tell me briefly what else you'd like the bot to do for you, for example send appointment reminders."
);
await send('Track orders');
res = await send('lots');
assert.ok(res.reply.startsWith('Please reply with the number of your choice.'));
await send('5');
res = await send('1');
assert.equal(res.event, 'lead_saved');
assert.ok(res.reply.startsWith("Thanks! We'll get back to you soon."));
assert.ok(res.reply.includes('1. 🏪 Edit business info\n') && res.reply.includes('4. 🤖 Try my bot'));
assert.ok(!res.reply.includes(LEAD_MENU_LABEL));

const lead = store._dump().leads[sender];
assert.equal(lead.senderId, sender);
assert.equal(lead.businessName, 'Test Studio');
assert.ok(lead.createdAt);
assert.deepEqual(lead.answers, {
  channels: ['WhatsApp', 'My business website'],
  actions: ['Other (tell us more)'],
  actionsOther: 'Track orders',
  dailyInquiries: 'Not sure',
  system: 'No',
});

// Builder state untouched
const sess = await store.loadSession(sender);
assert.equal(sess.buildHistory.filter((m) => m.role === 'user').length, 0);
assert.equal(JSON.stringify(await store.loadProfile(sender)), profileBefore);

// One-time: after submission the lead item is hidden and 1 is the first edit item
res = await send('1');
assert.equal(res.event, 'menu_section');
assert.ok(res.reply.startsWith('Business info\nCurrent:'), res.reply);
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
