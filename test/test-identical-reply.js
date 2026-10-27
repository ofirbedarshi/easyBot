import { strict as assert } from 'assert';
import {
  IDENTICAL_REPLY_RETRY_NOTE,
  generateWithIdenticalRetry,
  isSameReply,
  lastOutgoingMessage,
  messagesWithRetryNote,
  normalizeReplyForCompare,
} from '../src/identicalReply.js';
import { resetBuilderChatParamCache, runBuilderTurn } from '../src/builder.js';
import { businessBotReply } from '../src/businessBot.js';
import { resetChatCompletionShapeCache } from '../src/openaiChat.js';
import { emptyProfile } from '../src/profile.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('normalizeReplyForCompare folds whitespace and case', () => {
  assert.equal(normalizeReplyForCompare('  Hello\n\nWORLD  '), 'hello world');
  assert.equal(isSameReply('Hello  World', 'hello world'), true);
  assert.equal(isSameReply('Hello', 'Hi'), false);
  assert.equal(isSameReply('', 'Hello'), false);
  assert.equal(isSameReply('Hello', ''), false);
});

test('lastOutgoingMessage is the latest non-empty assistant content', () => {
  assert.equal(lastOutgoingMessage(undefined), '');
  assert.equal(
    lastOutgoingMessage([
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'Amen' },
      { role: 'assistant', content: '  ' },
    ]),
    'first'
  );
});

test('identical reply triggers exactly one regeneration', async () => {
  const notes = [];
  const log = { warn() {} };
  const result = await generateWithIdenticalRetry({
    generate: async (note) => {
      notes.push(note);
      return note ? 'Got it — Amen it is!' : 'What is the name?';
    },
    extractText: (text) => text,
    previousOutgoing: 'What is the name?',
    log,
  });
  assert.equal(notes.length, 2);
  assert.equal(notes[0], undefined);
  assert.equal(notes[1], IDENTICAL_REPLY_RETRY_NOTE);
  assert.equal(result, 'Got it — Amen it is!');
});

test('non-identical reply does not regenerate', async () => {
  let calls = 0;
  const result = await generateWithIdenticalRetry({
    generate: async () => {
      calls += 1;
      return 'Thanks — Amen is a lovely name.';
    },
    extractText: (text) => text,
    previousOutgoing: 'What is the name of your coffee shop?',
  });
  assert.equal(calls, 1);
  assert.equal(result, 'Thanks — Amen is a lovely name.');
});

test('second identical result is sent without further retries', async () => {
  const notes = [];
  const warnings = [];
  const same = 'A coffee shop sounds lovely! What is the name of your coffee shop?';
  const result = await generateWithIdenticalRetry({
    generate: async (note) => {
      notes.push(note);
      return same;
    },
    extractText: (text) => text,
    previousOutgoing: same,
    label: 'Builder',
    log: { warn: (msg) => warnings.push(msg) },
  });
  assert.equal(notes.length, 2);
  assert.equal(result, same);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Builder identical consecutive reply/);
});

function queueClient(replies) {
  const requests = [];
  let i = 0;
  return {
    requests,
    chat: {
      completions: {
        create: async (req) => {
          requests.push(req);
          const content = replies[Math.min(i, replies.length - 1)];
          i += 1;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

function builderPayload(message) {
  return JSON.stringify({
    message,
    draft: {
      name: null,
      whatWeDo: null,
      services: [],
      hours: null,
      locationOrArea: null,
      commonQuestions: [],
      informationToCollect: null,
      unknowns: [],
      tone: null,
      priceDisclosure: null,
      openingMessage: null,
      openingMessageReset: false,
    },
    newFacts: [],
    ownerEdits: [],
    factEdits: [],
    resolvedUnknowns: [],
    configRequests: [],
    onPurpose: true,
  });
}

const PREVIOUS_ASK =
  'A coffee shop sounds like a lovely place to bring people together! ☕✨ What\'s the name of your coffee shop?';

test('Business Bot identical reply regenerates once with the retry note', async () => {
  resetChatCompletionShapeCache();
  const client = queueClient([PREVIOUS_ASK, 'Amen — what a warm name.']);
  const reply = await businessBotReply({
    profile: { ...emptyProfile(), name: 'Amen', whatWeDo: 'Coffee' },
    history: [
      { role: 'user', content: 'I have a coffee shop' },
      { role: 'assistant', content: PREVIOUS_ASK },
    ],
    question: 'Amen',
    client,
  });
  assert.equal(client.requests.length, 2);
  assert.deepEqual(client.requests[1].messages.at(-1), {
    role: 'system',
    content: IDENTICAL_REPLY_RETRY_NOTE,
  });
  assert.equal(reply, 'Amen — what a warm name.');
});

test('Business Bot non-identical reply is a single completion', async () => {
  resetChatCompletionShapeCache();
  const client = queueClient(['Amen — lovely name.']);
  const reply = await businessBotReply({
    profile: { ...emptyProfile(), name: 'Amen', whatWeDo: 'Coffee' },
    history: [
      { role: 'assistant', content: PREVIOUS_ASK },
    ],
    question: 'Amen',
    client,
  });
  assert.equal(client.requests.length, 1);
  assert.ok(
    !client.requests[0].messages.some((m) => m.content === IDENTICAL_REPLY_RETRY_NOTE)
  );
  assert.equal(reply, 'Amen — lovely name.');
});

test('Business Bot still-identical reply is sent after one retry', async () => {
  resetChatCompletionShapeCache();
  const client = queueClient([PREVIOUS_ASK, PREVIOUS_ASK, 'should not be used']);
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const reply = await businessBotReply({
      profile: { ...emptyProfile(), name: 'Amen', whatWeDo: 'Coffee' },
      history: [{ role: 'assistant', content: PREVIOUS_ASK }],
      question: 'Amen',
      client,
    });
    assert.equal(client.requests.length, 2);
    assert.equal(reply, PREVIOUS_ASK);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = prevWarn;
  }
});

test('Builder identical reply regenerates once with the retry note', async () => {
  resetBuilderChatParamCache();
  const client = queueClient([
    builderPayload(PREVIOUS_ASK),
    builderPayload('Amen — I love that name. What do you serve?'),
  ]);
  const turn = await runBuilderTurn({
    buildHistory: [{ role: 'assistant', content: PREVIOUS_ASK }],
    profile: emptyProfile(),
    userMessage: 'Amen',
    client,
    consistencyComplete: async () => ({}),
  });
  assert.equal(client.requests.length, 2);
  assert.deepEqual(messagesWithRetryNote([], IDENTICAL_REPLY_RETRY_NOTE)[0], {
    role: 'system',
    content: IDENTICAL_REPLY_RETRY_NOTE,
  });
  assert.deepEqual(client.requests[1].messages.at(-1), {
    role: 'system',
    content: IDENTICAL_REPLY_RETRY_NOTE,
  });
  assert.equal(turn.message, 'Amen — I love that name. What do you serve?');
});

test('Builder non-identical reply is a single completion', async () => {
  resetBuilderChatParamCache();
  const client = queueClient([builderPayload('Amen — I love that name. What do you serve?')]);
  const turn = await runBuilderTurn({
    buildHistory: [{ role: 'assistant', content: PREVIOUS_ASK }],
    profile: emptyProfile(),
    userMessage: 'Amen',
    client,
    consistencyComplete: async () => ({}),
  });
  assert.equal(client.requests.length, 1);
  assert.equal(turn.message, 'Amen — I love that name. What do you serve?');
});

test('Business Bot treats || vs blank-line as the same formatted reply', async () => {
  resetChatCompletionShapeCache();
  const formatted = 'A cut is 100 shekel.\n\nAnything else I can help with?';
  const marked = 'A cut is 100 shekel. || Anything else I can help with?';
  const client = queueClient([marked, 'A cut is 100 shekel. Saturday is open.']);
  const reply = await businessBotReply({
    profile: { ...emptyProfile(), name: 'Amen', whatWeDo: 'Coffee' },
    history: [{ role: 'assistant', content: formatted }],
    question: 'Saturday?',
    client,
  });
  assert.equal(client.requests.length, 2);
  assert.equal(reply, 'A cut is 100 shekel. Saturday is open.');
});

test('Builder treats || vs blank-line as the same formatted reply', async () => {
  resetBuilderChatParamCache();
  const formatted = 'A coffee shop sounds lovely ✨\n\nWhat is the name?';
  const marked = 'A coffee shop sounds lovely ✨ || What is the name?';
  const client = queueClient([
    builderPayload(marked),
    builderPayload('Amen — I love that name. What do you serve?'),
  ]);
  const turn = await runBuilderTurn({
    buildHistory: [{ role: 'assistant', content: formatted }],
    profile: emptyProfile(),
    userMessage: 'Amen',
    client,
    consistencyComplete: async () => ({}),
  });
  assert.equal(client.requests.length, 2);
  assert.equal(turn.message, 'Amen — I love that name. What do you serve?');
});

test('Builder still-identical reply is sent after one retry', async () => {
  resetBuilderChatParamCache();
  const client = queueClient([
    builderPayload(PREVIOUS_ASK),
    builderPayload(`  ${PREVIOUS_ASK.toUpperCase()}  `),
    builderPayload('unused third call'),
  ]);
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = (msg) => warnings.push(msg);
  try {
    const turn = await runBuilderTurn({
      buildHistory: [{ role: 'assistant', content: PREVIOUS_ASK }],
      profile: emptyProfile(),
      userMessage: 'Amen',
      client,
      consistencyComplete: async () => ({}),
    });
    assert.equal(client.requests.length, 2);
    assert.equal(isSameReply(turn.message, PREVIOUS_ASK), true);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = prevWarn;
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
