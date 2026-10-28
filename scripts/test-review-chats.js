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
  CHATS_PRICE_UPDATE_FAILED,
  PARSE_FALLBACK_MESSAGE,
  businessDetailsAck,
  chatsEmptyLine,
  INTAKE_MENU_LABEL,
  REVIEW,
} from '../src/copy.js';
import { emptyProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { createSenderSession, createSession, handleMessage } from '../src/session.js';
import { lastShownNav, menuActive, parseMenuItem, renderMenu } from '../src/ownerNav.js';
import { ownerPhase } from '../src/ownerPhase.js';
import {
  clarifyFromBuilderMessage,
  groupTestChats,
  REVIEW_CHATS_SYSTEM,
} from '../src/reviewChats.js';
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
      reviewChatsReply: async () => ({
        message: 'I had 1 chat. She asked the private-lesson price.',
        teaching: false,
      }),
      runBuilderTurn: async () => {
        throw new Error('Builder should not run on a chats question');
      },
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

function taughtLessonDraft(profile, price) {
  const draft = structuredClone(profile.draft);
  draft.services = [{ name: 'Private lesson', price, notes: null }];
  return draft;
}

async function seededChatsSession(deps) {
  const store = createMemoryStore();
  const sender = 'whatsapp:+15551230002';
  const profile = tested();
  await store.saveProfile(sender, profile);
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
    body: 'I do not have the price.',
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
  const session = await createSenderSession(store, sender, { deps });
  session.ownerName = 'Dana';
  return { store, sender, session, profile };
}

test('clarifyFromBuilderMessage rejects remember-claims', () => {
  assert.equal(
    clarifyFromBuilderMessage("What's the new price for the haircut?"),
    "What's the new price for the haircut?"
  );
  assert.equal(
    clarifyFromBuilderMessage("I'll remember that the haircut price is $8."),
    PARSE_FALLBACK_MESSAGE
  );
  assert.equal(clarifyFromBuilderMessage(''), PARSE_FALLBACK_MESSAGE);
  assert.ok(REVIEW_CHATS_SYSTEM.includes('Set teaching true only when'));
});

await test('teaching false does not call the Builder', async () => {
  let builderCalls = 0;
  const { store, sender, session } = await seededChatsSession({
    reviewChatsReply: async ({ question }) =>
      question
        ? { message: 'She asked how much a private lesson is.', teaching: false }
        : { message: 'I had 1 chat. I could not answer the private-lesson price.', teaching: false },
    runBuilderTurn: async () => {
      builderCalls += 1;
      throw new Error('Builder should not run when teaching is false');
    },
  });
  await handleMessage(session, '3');
  assert.equal(builderCalls, 0);
  const before = await store.loadProfile(sender);
  const follow = await handleMessage(session, 'what exactly did she ask about the price?');
  assert.equal(follow.event, 'chats_turn');
  assert.equal(ownerPhase(session), 'chats');
  assert.equal(builderCalls, 0);
  assert.ok(follow.reply.includes('She asked how much a private lesson is.'), follow.reply);
  assert.ok(!/remember|saved/i.test(follow.reply), follow.reply);
  const after = await store.loadProfile(sender);
  assert.equal(after.services[0].price, before.services[0].price);
  assert.equal(after.services[0].price, '$80');
});

await test('teach in chats mode updates the live service price', async () => {
  const builderCalls = [];
  const { store, sender, session } = await seededChatsSession({
    reviewChatsReply: async ({ question }) => {
      if (!question) {
        return { message: 'I had 1 chat. I could not answer the private-lesson price.', teaching: false };
      }
      return {
        message: "I'll remember that the private lesson is $8.",
        teaching: true,
      };
    },
    runBuilderTurn: async ({ profile: p, userMessage, buildHistory }) => {
      builderCalls.push({ userMessage, historyLen: buildHistory?.length || 0 });
      return {
        message: "I'll remember that the private lesson is $8.",
        draft: taughtLessonDraft(p, '$8'),
        onPurpose: true,
        ownerName: null,
        configRequests: [],
      };
    },
  });
  const report = await handleMessage(session, '3');
  assert.equal(report.event, 'enter_chats');
  const teach = await handleMessage(session, 'The price is 8 dollar');
  assert.equal(teach.event, 'chats_turn');
  assert.equal(ownerPhase(session), 'chats');
  assert.equal(session.reviewChats?.active, true);
  assert.ok(teach.reply.endsWith(CHATS_FOOTER), teach.reply);
  assert.ok(teach.reply.startsWith(businessDetailsAck('Dana')), teach.reply);
  assert.ok(teach.reply.includes(REVIEW.changesIntro), teach.reply);
  assert.ok(teach.reply.includes('$8'), teach.reply);
  assert.ok(!/I'll remember that the private lesson is \$8/.test(teach.reply), teach.reply);
  const saved = await store.loadProfile(sender);
  assert.equal(saved.services[0].price, '$8');
  assert.equal(saved.draft.services[0].price, '$8');
  assert.ok(session.reviewChats.learned?.length > 0);
  assert.equal(builderCalls.length, 1);
  assert.ok(builderCalls[0].historyLen > 0);
  assert.ok(session.reviewChats.snapshot.flat().some((m) => /do not have the price/.test(m.body)));
});

await test('teach with no save uses Builder question, not remember-claim', async () => {
  const { store, sender, session } = await seededChatsSession({
    reviewChatsReply: async ({ question }) => {
      if (!question) {
        return { message: 'I had 1 chat. I could not answer the private-lesson price.', teaching: false };
      }
      return {
        message: "Thanks for letting me know. I'll remember that the haircut price is $8.",
        teaching: true,
      };
    },
    runBuilderTurn: async ({ profile: p }) => ({
      message: "What's the new price for the haircut?",
      draft: structuredClone(p.draft),
      onPurpose: true,
      ownerName: null,
      configRequests: [],
    }),
  });
  await handleMessage(session, '3');
  const before = await store.loadProfile(sender);
  const clarify = await handleMessage(session, 'The price is 8 dollar');
  assert.equal(clarify.event, 'chats_turn');
  assert.equal(ownerPhase(session), 'chats');
  assert.ok(clarify.reply.startsWith("What's the new price for the haircut?"), clarify.reply);
  assert.ok(clarify.reply.endsWith(CHATS_FOOTER), clarify.reply);
  assert.ok(!/remember/i.test(clarify.reply), clarify.reply);
  assert.ok(!clarify.reply.includes(REVIEW.changesIntro));
  const after = await store.loadProfile(sender);
  assert.equal(after.services[0].price, before.services[0].price);
});

await test('pending teach: unknowns-only unclear has no save card; no-save uses fixed line', async () => {
  const builderCalls = [];
  const chatsQuestions = [];
  const { store, sender, session } = await seededChatsSession({
    reviewChatsReply: async ({ question }) => {
      chatsQuestions.push(question);
      if (!question) {
        return { message: 'I had 1 chat. I could not answer the private-lesson price.', teaching: false };
      }
      return { message: 'Chats-model paraphrase should not be shown.', teaching: true };
    },
    runBuilderTurn: async ({ profile: p, userMessage, buildHistory }) => {
      builderCalls.push({
        userMessage,
        historyLen: buildHistory?.length || 0,
        historyRoles: (buildHistory || []).map((m) => m.role),
      });
      if (userMessage === "it's cheaper now" || userMessage === '6') {
        const draft = structuredClone(p.draft);
        draft.unknowns = [
          ...(Array.isArray(draft.unknowns) ? draft.unknowns : []),
          'The current private lesson price is lower, but the new amount is unknown',
        ];
        return {
          message: "What's the new price?",
          draft,
          onPurpose: true,
          ownerName: null,
          configRequests: [],
        };
      }
      return {
        message: "I'll remember that the private lesson is $8.",
        draft: taughtLessonDraft(p, '$8'),
        onPurpose: true,
        ownerName: null,
        configRequests: [],
      };
    },
  });
  await handleMessage(session, '3');
  const teachA = await handleMessage(session, 'The price is 8 dollar');
  assert.ok(teachA.reply.startsWith(businessDetailsAck('Dana')), teachA.reply);
  const afterA = await store.loadProfile(sender);
  assert.equal(afterA.services[0].price, '$8');

  const unclear = await handleMessage(session, "it's cheaper now");
  assert.equal(unclear.event, 'chats_turn');
  assert.ok(unclear.reply.startsWith("What's the new price?"), unclear.reply);
  assert.ok(!unclear.reply.includes(REVIEW.changesIntro), unclear.reply);
  assert.ok(!unclear.reply.includes(businessDetailsAck('Dana')), unclear.reply);
  const afterUnclear = await store.loadProfile(sender);
  assert.equal(afterUnclear.services[0].price, '$8');
  assert.deepEqual(afterUnclear.unknowns || [], afterA.unknowns || []);
  assert.equal(session.reviewChats.awaitingTeachAnswer, true);

  const chatsBeforeSix = chatsQuestions.length;
  const teachSix = await handleMessage(session, '6');
  assert.equal(chatsQuestions.length, chatsBeforeSix, 'pending teach must skip the chats classifier');
  assert.equal(builderCalls.at(-1).userMessage, '6');
  assert.equal(builderCalls.at(-1).historyLen, 1);
  assert.deepEqual(builderCalls.at(-1).historyRoles, ['assistant']);
  assert.equal(teachSix.reply, `${CHATS_PRICE_UPDATE_FAILED}\n\n${CHATS_FOOTER}`);
  assert.ok(!teachSix.reply.includes(REVIEW.changesIntro), teachSix.reply);
  const afterSix = await store.loadProfile(sender);
  assert.equal(afterSix.services[0].price, '$8');
  assert.deepEqual(afterSix.unknowns || [], afterA.unknowns || []);
  assert.equal(session.reviewChats.awaitingTeachAnswer, false);
  assert.equal(ownerPhase(session), 'chats');

  const stopped = await handleMessage(session, 'stop');
  assert.equal(stopped.event, 'enter_build');
  assert.equal(session.reviewChats, null);
  const afterStop = await store.loadProfile(sender);
  assert.equal(afterStop.services[0].price, '$8');
});

await test('pending teach: Builder save still applies with last-assistant history', async () => {
  const builderCalls = [];
  const chatsQuestions = [];
  const { store, sender, session } = await seededChatsSession({
    reviewChatsReply: async ({ question }) => {
      chatsQuestions.push(question);
      if (!question) {
        return { message: 'I had 1 chat.', teaching: false };
      }
      return { message: 'Chats paraphrase.', teaching: true };
    },
    runBuilderTurn: async ({ profile: p, userMessage, buildHistory }) => {
      builderCalls.push({
        userMessage,
        historyLen: buildHistory?.length || 0,
        historyRoles: (buildHistory || []).map((m) => m.role),
      });
      if (userMessage === "it's cheaper now") {
        return {
          message: "What's the new price?",
          draft: structuredClone(p.draft),
          onPurpose: true,
          ownerName: null,
          configRequests: [],
        };
      }
      if (userMessage === '6') {
        return {
          message: 'Saved.',
          draft: taughtLessonDraft(p, '6'),
          onPurpose: true,
          ownerName: null,
          configRequests: [],
        };
      }
      return {
        message: 'Saved.',
        draft: taughtLessonDraft(p, '$8'),
        onPurpose: true,
        ownerName: null,
        configRequests: [],
      };
    },
  });
  await handleMessage(session, '3');
  await handleMessage(session, 'The price is 8 dollar');
  await handleMessage(session, "it's cheaper now");
  assert.equal(session.reviewChats.awaitingTeachAnswer, true);
  const chatsBeforeSix = chatsQuestions.length;
  const teachSix = await handleMessage(session, '6');
  assert.equal(chatsQuestions.length, chatsBeforeSix);
  assert.equal(builderCalls.at(-1).userMessage, '6');
  assert.equal(builderCalls.at(-1).historyLen, 1);
  assert.deepEqual(builderCalls.at(-1).historyRoles, ['assistant']);
  assert.ok(teachSix.reply.startsWith(businessDetailsAck('Dana')), teachSix.reply);
  assert.ok(teachSix.reply.includes(REVIEW.changesIntro), teachSix.reply);
  const after = await store.loadProfile(sender);
  assert.equal(after.services[0].price, '6');
  assert.equal(session.reviewChats.awaitingTeachAnswer, false);
});

await test('teach with no usable Builder question uses parse fallback', async () => {
  const { store, sender, session } = await seededChatsSession({
    reviewChatsReply: async ({ question }) =>
      question
        ? { message: "I'll remember that.", teaching: true }
        : { message: 'I had 1 chat.', teaching: false },
    runBuilderTurn: async ({ profile: p }) => ({
      message: "Thanks, I'll remember that the haircut price is $8.",
      draft: structuredClone(p.draft),
      onPurpose: true,
      ownerName: null,
      configRequests: [],
    }),
  });
  await handleMessage(session, '3');
  const before = await store.loadProfile(sender);
  const out = await handleMessage(session, 'The price is 8 dollar');
  assert.ok(out.reply.startsWith(PARSE_FALLBACK_MESSAGE), out.reply);
  assert.ok(out.reply.endsWith(CHATS_FOOTER), out.reply);
  assert.ok(!/remember/i.test(out.reply), out.reply);
  assert.equal(ownerPhase(session), 'chats');
  const after = await store.loadProfile(sender);
  assert.equal(after.services[0].price, before.services[0].price);
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
