/**
 * Deterministic review-chats: gating, empty-window + menu, footer,
 * name fallback, grouping window, and mode exit. No OpenAI.
 */
import assert from 'assert';
import fs from 'fs';
import { composeReply, menuItems } from '../src/composeReply.js';
import {
  CHATS_FOOTER,
  CHATS_MENU_LABEL,
  chatsEmptyLine,
  INTAKE_MENU_LABEL,
} from '../src/copy.js';
import { emptyProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { createSenderSession, createSession, handleMessage } from '../src/session.js';
import { lastShownNav, menuActive, parseMenuItem, renderMenu } from '../src/ownerNav.js';
import { ownerPhase } from '../src/ownerPhase.js';
import { groupTestChats } from '../src/reviewChats.js';
import { createMemoryStore } from '../src/store/memoryStore.js';

const PROFILE = testProfilePath('review-chats');
const TELL_MORE = '🏪 Tell me more about your business';

function clean() {
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function approved(overrides = {}) {
  const draft = {
    name: 'Studio Yoga',
    whatWeDo: 'Private yoga lessons',
    services: [{ name: 'Private lesson', price: '$80', notes: null }],
    hours: 'Sun–Thu 8–20',
    locationOrArea: 'Tel Aviv',
    commonQuestions: [],
    informationToCollect: ['name', 'phone'],
    unknowns: [],
    otherFacts: [],
    tone: 'warm',
    openingMessage: null,
    askedTopics: ['commonQuestions', 'informationToCollect'],
  };
  return {
    ...emptyProfile(),
    ...draft,
    approvedAt: '2026-01-01T00:00:00.000Z',
    draft,
    ...overrides,
  };
}

function tested(overrides = {}) {
  return approved({ firstTestedAt: '2026-01-02T00:00:00.000Z', ...overrides });
}

function afterTestMenu() {
  return { leadOption: true, chatsOption: true };
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

test('gating: chats item only after firstTestedAt', () => {
  assert.ok(!menuItems({ leadOption: false, chatsOption: false }).includes('chats'));
  assert.ok(menuItems({ leadOption: false, chatsOption: true }).includes('chats'));
  assert.deepEqual(menuItems({ leadOption: true, chatsOption: true })[2], 'chats');
  assert.equal(parseMenuItem('3', afterTestMenu()), 'chats');
  const rendered = renderMenu(afterTestMenu());
  assert.ok(rendered.includes(`3. 📋 ${CHATS_MENU_LABEL}`));
  assert.ok(!renderMenu({ leadOption: false }).includes(CHATS_MENU_LABEL));
});

test('grouping: last 3 hours only; command rows split chats', () => {
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  const windowMs = 3 * 60 * 60 * 1000;
  const old = new Date(now - 4 * 60 * 60 * 1000).toISOString();
  const mid = new Date(now - 30 * 60 * 1000).toISOString();
  const later = new Date(now - 10 * 60 * 1000).toISOString();
  const chats = groupTestChats(
    [
      { id: 1, mode: 'test', direction: 'inbound', body: 'Moon yoga?', created_at: old },
      { id: 2, mode: 'test', direction: 'outbound', body: 'No idea.', created_at: old },
      { id: 3, mode: 'command', direction: 'inbound', body: '/test', created_at: mid },
      { id: 4, mode: 'test', direction: 'inbound', body: 'How much is a cut?', created_at: mid },
      { id: 5, mode: 'test', direction: 'outbound', body: 'A cut is $45.', created_at: mid },
      { id: 6, mode: 'command', direction: 'inbound', body: 'stop', created_at: mid },
      { id: 7, mode: 'command', direction: 'inbound', body: '/test', created_at: later },
      { id: 8, mode: 'test', direction: 'inbound', body: 'Keratin treatments?', created_at: later },
      { id: 9, mode: 'test', direction: 'outbound', body: "I don't have that.", created_at: later },
    ],
    now,
    windowMs
  );
  assert.equal(chats.length, 2, JSON.stringify(chats));
  assert.equal(chats[0][0].body, 'How much is a cut?');
  assert.equal(chats[1][0].body, 'Keratin treatments?');
  assert.ok(!chats.flat().some((m) => /Moon yoga/.test(m.body)));
});

await test('empty window: exact line + menu, not in chats mode, try enters TEST', async () => {
  clean();
  saveProfile(tested(), PROFILE);
  const session = createSession({ profilePath: PROFILE });
  session.ownerName = 'Dana';
  session.buildHistory.push({
    role: 'assistant',
    content: renderMenu(afterTestMenu()),
    nav: 'menu',
  });
  const empty = await handleMessage(session, '3');
  assert.equal(empty.event, 'chats_empty');
  assert.equal(session.reviewChats, null);
  assert.equal(ownerPhase(session, tested()), 'ready');
  assert.equal(lastShownNav(session.buildHistory), 'menu');
  assert.equal(menuActive(session.buildHistory), true);
  const expected = composeReply({
    kind: 'chats_empty',
    menuOpts: afterTestMenu(),
    ownerName: 'Dana',
  }).reply;
  assert.equal(empty.reply, expected);
  assert.ok(empty.reply.startsWith(chatsEmptyLine('Dana')));
  assert.ok(empty.reply.includes('2. 🤖 Chat with me like a customer'));
  assert.ok(!empty.reply.includes(CHATS_FOOTER));
  const tryIt = await handleMessage(session, '2');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
});

await test('empty window name fallback', async () => {
  clean();
  saveProfile(tested(), PROFILE);
  const session = createSession({ profilePath: PROFILE });
  session.buildHistory.push({
    role: 'assistant',
    content: renderMenu(afterTestMenu()),
    nav: 'menu',
  });
  const empty = await handleMessage(session, '3');
  assert.ok(empty.reply.startsWith(chatsEmptyLine()));
  assert.ok(!empty.reply.startsWith(chatsEmptyLine('Dana')));
  assert.equal(empty.reply, composeReply({ kind: 'chats_empty', menuOpts: afterTestMenu() }).reply);
});

await test('report footer and menu exit from chats mode', async () => {
  const store = createMemoryStore();
  const sender = 'whatsapp:+15551230001';
  await store.saveProfile(sender, tested());
  const now = new Date().toISOString();
  await store.appendMessage({
    senderId: sender,
    direction: 'inbound',
    body: 'How much is a private lesson?',
    mode: 'test',
    createdAt: now,
  });
  await store.appendMessage({
    senderId: sender,
    direction: 'outbound',
    body: 'A private lesson is $80.',
    mode: 'test',
    createdAt: now,
  });
  await store.saveSession(sender, {
    mode: 'BUILD',
    buildHistory: [{ role: 'assistant', content: renderMenu(afterTestMenu()), nav: 'menu' }],
    testHistory: [],
    testSessionId: 't',
    ownerName: 'Dana',
  });
  const session = await createSenderSession(store, sender, {
    deps: {
      reviewChatsReply: async () => 'I had 1 chat. She asked the private-lesson price.',
    },
  });
  session.ownerName = 'Dana';
  const report = await handleMessage(session, '3');
  assert.equal(report.event, 'enter_chats');
  assert.equal(ownerPhase(session), 'chats');
  assert.ok(report.reply.endsWith(CHATS_FOOTER), report.reply);
  assert.ok(report.reply.includes('I had 1 chat.'));
  assert.equal(session.reviewChats?.active, true);

  const follow = await handleMessage(session, 'what exactly did she ask about the price?');
  assert.equal(follow.event, 'chats_turn');
  assert.ok(follow.reply.endsWith(CHATS_FOOTER));
  assert.equal(ownerPhase(session), 'chats');

  const tryWord = await handleMessage(session, 'try');
  assert.equal(tryWord.event, 'chats_turn');
  assert.notEqual(session.mode, 'TEST');

  const back = await handleMessage(session, 'menu');
  assert.equal(back.event, 'menu');
  assert.equal(session.reviewChats, null);
  assert.equal(ownerPhase(session, tested()), 'ready');
  assert.equal(menuActive(session.buildHistory), true);
  assert.ok(back.reply.includes(`1. 🚀`));
  assert.ok(back.reply.includes(TELL_MORE));
  assert.ok(back.reply.includes(INTAKE_MENU_LABEL));
});

await test('hidden before first TEST: 3 is not chats', async () => {
  clean();
  saveProfile(approved(), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      reviewChatsReply: async () => {
        throw new Error('review chats should not run');
      },
    },
  });
  session.buildHistory.push({
    role: 'assistant',
    content: renderMenu({ leadOption: false, chatsOption: false }),
    nav: 'menu',
  });
  const out = await handleMessage(session, '3');
  assert.equal(out.event, 'menu_section');
  assert.notEqual(out.event, 'enter_chats');
  assert.notEqual(out.event, 'chats_empty');
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
