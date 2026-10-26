/**
 * Deterministic Business Bot checks: OpenAI request shape, bounded history,
 * TEST-mode conversation memory through the store, and approval going live
 * at once (fake OpenAI client / stubbed replies; no network).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  BUSINESS_BOT_CONTEXT_MESSAGES,
  BUSINESS_BOT_STORED_MESSAGES,
  FIRST_TURN_SYSTEM,
  buildBusinessBotMessages,
  businessBotReply,
} from '../src/businessBot.js';
import { resetChatCompletionShapeCache } from '../src/openaiChat.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import {
  customerOpeningText,
  emptyProfile,
  withKnownProfileKeys,
} from '../src/profile.js';
import {
  createSenderSession,
  handleMessage,
  persistSenderSession,
} from '../src/session.js';
import { createMemoryStore } from '../src/store/memoryStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function approvedProfile(overrides = {}) {
  const facts = {
    name: 'Studio Yoga',
    whatWeDo: 'Private yoga lessons',
    ownerGoal: 'answer_questions',
    services: [{ name: 'Private lesson', price: '200 ILS / 60 min', notes: null }],
    hours: 'Sun–Thu 8–18',
    locationOrArea: 'Tel Aviv',
    commonQuestions: [],
    informationToCollect: [],
    unknowns: [],
    tone: 'warm',
  };
  return {
    ...emptyProfile(),
    ...facts,
    approvedAt: '2026-01-01T00:00:00.000Z',
    draft: { ...facts },
    ...overrides,
  };
}

function turns(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: 'user', content: `q${i}` }, { role: 'assistant', content: `a${i}` });
  }
  return out;
}

function fakeClient(reply = 'Hello from the bot') {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        create: async (req) => {
          requests.push(req);
          return { choices: [{ message: { content: ` ${reply} ` } }] };
        },
      },
    },
  };
}

async function testRequestShape() {
  resetChatCompletionShapeCache();
  const profile = approvedProfile();
  const history = turns(2);
  const prevModel = process.env.OPENAI_MODEL;

  delete process.env.OPENAI_MODEL;
  const client = fakeClient();
  const reply = await businessBotReply({ profile, history, question: 'Price?', client });
  assert.equal(reply, 'Hello from the bot');
  const [req] = client.requests;
  assert.equal(req.model, 'gpt-4o-mini');
  assert.equal(req.temperature, 0);
  assert.deepEqual(req.messages[0], {
    role: 'system',
    content: buildCustomerSystemPrompt(profile),
  });
  assert.deepEqual(req.messages.slice(1, -1), history);
  assert.deepEqual(req.messages.at(-1), { role: 'user', content: 'Price?' });
  assert.ok(
    !req.messages.some((m) => m.content === FIRST_TURN_SYSTEM),
    'later turns do not get the first-turn system line'
  );

  process.env.OPENAI_MODEL = 'gpt-test-model';
  const client2 = fakeClient();
  await businessBotReply({ profile, history: [], question: 'Hi', client: client2 });
  assert.equal(client2.requests[0].model, 'gpt-test-model');
  assert.equal(client2.requests[0].temperature, 0);

  if (prevModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = prevModel;
  console.log('PASS request_shape_model_temperature_prompt');
}

function fakeClientRejectTempThenOk() {
  const requests = [];
  return {
    requests,
    chat: {
      completions: {
        create: async (req) => {
          requests.push(req);
          if (req.temperature != null) {
            const err = new Error("Unsupported value: 'temperature' is not supported with this model.");
            err.status = 400;
            throw err;
          }
          if (req.reasoning_effort === 'none') {
            const err = new Error("Unsupported value: 'reasoning_effort' does not support 'none'.");
            err.status = 400;
            throw err;
          }
          return { choices: [{ message: { content: 'reasoned' } }] };
        },
      },
    },
  };
}

async function testReasoningModelFallback() {
  resetChatCompletionShapeCache();
  const prevModel = process.env.OPENAI_MODEL;
  process.env.OPENAI_MODEL = 'gpt-reason-test';
  const client = fakeClientRejectTempThenOk();
  const reply = await businessBotReply({
    profile: approvedProfile(),
    history: [],
    question: 'Hi',
    client,
  });
  assert.equal(
    reply,
    `${customerOpeningText(approvedProfile())}\n\nreasoned`
  );
  assert.equal(client.requests[0].temperature, 0);
  const ok = [...client.requests].reverse().find((r) => r.temperature == null);
  assert.ok(ok, 'retries without temperature');
  assert.equal(ok.reasoning_effort, 'minimal');
  assert.ok(ok.max_completion_tokens > 0);
  await businessBotReply({
    profile: approvedProfile(),
    history: [],
    question: 'Again',
    client,
  });
  const last = client.requests.at(-1);
  assert.equal(last.temperature, undefined);
  assert.equal(last.reasoning_effort, 'minimal');
  if (prevModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = prevModel;
  resetChatCompletionShapeCache();
  console.log('PASS reasoning_model_omits_temperature_uses_lowest_effort');
}

async function testFirstTurnOpeningPrefixed() {
  const profile = approvedProfile({
    name: 'BurgerBarber',
    openingMessage: null,
    assistantName: null,
  });
  const client = fakeClient("A men's haircut is 100 shekel.");
  const reply = await businessBotReply({
    profile,
    history: [],
    question: 'Heyy',
    client,
  });
  const open = customerOpeningText(profile);
  assert.ok(reply.startsWith(`${open}\n\n`), reply);
  assert.ok(reply.includes("A men's haircut is 100 shekel."));
  assert.ok(
    client.requests[0].messages.some(
      (m) => m.role === 'system' && m.content === FIRST_TURN_SYSTEM
    )
  );

  const later = fakeClient('Glad you like it — want to leave your name and phone?');
  const reply2 = await businessBotReply({
    profile,
    history: [
      { role: 'user', content: 'Heyy' },
      { role: 'assistant', content: reply },
    ],
    question: 'Cool',
    client: later,
  });
  assert.equal(reply2, 'Glad you like it — want to leave your name and phone?');
  assert.ok(!reply2.startsWith(open));
  assert.ok(
    !later.requests[0].messages.some((m) => m.content === FIRST_TURN_SYSTEM)
  );

  const custom = 'Welcome to the chair!';
  const customProfile = approvedProfile({
    name: 'BurgerBarber',
    openingMessage: custom,
  });
  const customReply = await businessBotReply({
    profile: customProfile,
    history: [],
    question: 'Hi',
    client: fakeClient('How can I help?'),
  });
  assert.equal(customReply, `${custom}\n\nHow can I help?`);
  console.log('PASS first_turn_opening_prefixed');
}

async function testTestModeFirstMessageGetsOpening() {
  const store = createMemoryStore();
  const sender = 'whatsapp:+15550009';
  const profile = approvedProfile({
    name: 'BurgerBarber',
    openingMessage: null,
  });
  await store.saveProfile(sender, profile);
  const session = await createSenderSession(store, sender, {
    deps: {
      businessBotReply: (args) =>
        businessBotReply({ ...args, client: fakeClient('A cut is 100 shekel.') }),
    },
  });
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  assert.equal((await handleMessage(session, '/test')).event, 'enter_test');
  const first = await handleMessage(session, 'How much it cost?');
  const open = customerOpeningText(profile);
  assert.ok(first.reply.startsWith(`${open}\n\n`), first.reply);
  assert.ok(first.reply.includes('A cut is 100 shekel.'));
  const second = await handleMessage(session, 'Cool');
  assert.equal(second.reply, 'A cut is 100 shekel.');
  console.log('PASS test_mode_first_message_gets_opening');
}

function testHistoryBounded() {
  const history = [...turns(15), { role: 'system', content: 'ignored' }];
  const messages = buildBusinessBotMessages({
    profile: approvedProfile(),
    history,
    question: 'Last?',
  });
  const sent = messages.slice(1, -1);
  assert.equal(sent.length, BUSINESS_BOT_CONTEXT_MESSAGES);
  assert.ok(sent.every((m) => m.role === 'user' || m.role === 'assistant'));
  assert.deepEqual(sent.at(-1), { role: 'assistant', content: 'a14' });
  assert.deepEqual(sent[0], { role: 'user', content: 'q5' });
  console.log('PASS history_bounded_and_ordered');
}

/** TEST conversation memory survives a session reload from the store. */
async function testMemoryPersistsThroughStore() {
  const store = createMemoryStore();
  const sender = 'whatsapp:+15550001';
  await store.saveProfile(sender, approvedProfile());
  const seen = [];
  const deps = {
    businessBotReply: async ({ history, question }) => {
      seen.push(history.map((m) => m.content));
      return `answer to ${question}`;
    },
  };

  let session = await createSenderSession(store, sender, { deps });
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  assert.equal((await handleMessage(session, '/test')).event, 'enter_test');
  const r1 = await handleMessage(session, 'first');
  assert.equal(r1.reply, 'answer to first');
  assert.equal(r1.source, 'real-llm');
  await persistSenderSession(session);

  session = await createSenderSession(store, sender, { deps });
  assert.equal(session.mode, 'TEST');
  await handleMessage(session, 'second');
  assert.deepEqual(seen.at(-1), ['first', 'answer to first']);
  await persistSenderSession(session);

  const saved = await store.loadSession(sender);
  assert.deepEqual(
    saved.testHistory.map((m) => m.content),
    ['first', 'answer to first', 'second', 'answer to second']
  );

  assert.equal((await handleMessage(session, '/test')).event, 'enter_test');
  assert.deepEqual(session.testHistory, [], '/test starts a fresh conversation');
  console.log('PASS memory_persists_through_store');
}

async function testStoredHistoryCapped() {
  const store = createMemoryStore();
  const sender = 'whatsapp:+15550002';
  await store.saveProfile(sender, approvedProfile());
  const session = await createSenderSession(store, sender, {
    deps: { businessBotReply: async ({ question }) => `re ${question}` },
  });
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  await handleMessage(session, '/test');
  for (let i = 0; i < 30; i += 1) await handleMessage(session, `m${i}`);
  assert.equal(session.testHistory.length, BUSINESS_BOT_STORED_MESSAGES);
  assert.deepEqual(session.testHistory.at(-1), { role: 'assistant', content: 're m29' });
  console.log('PASS stored_history_capped');
}

async function testErrorTurnNotStored() {
  const store = createMemoryStore();
  const sender = 'whatsapp:+15550003';
  await store.saveProfile(sender, approvedProfile());
  const session = await createSenderSession(store, sender, {
    deps: {
      businessBotReply: async () => {
        throw new Error('401 Incorrect API key provided: sk-secret');
      },
    },
  });
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  await handleMessage(session, '/test');
  const origError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  let r;
  try {
    r = await handleMessage(session, 'hello?');
  } finally {
    console.error = origError;
  }
  assert.equal(r.ok, true);
  assert.equal(r.source, 'error');
  assert.equal(
    r.reply,
    "Sorry, your bot couldn't answer right now. Please try again in a moment."
  );
  assert.ok(!r.reply.includes('sk-secret'));
  assert.ok(!logged.join('\n').includes('sk-secret'));
  assert.deepEqual(session.testHistory, []);
  console.log('PASS error_turn_not_stored');
}

/** An edit is live on that turn; Try my bot uses the new facts. */
async function testApprovalIsLiveImmediately() {
  const store = createMemoryStore();
  const sender = 'whatsapp:+15550004';
  const live = approvedProfile();
  const pending = { ...live.draft, hours: 'Sun–Fri 8–14' };
  await store.saveProfile(sender, live);
  const prompts = [];
  const session = await createSenderSession(store, sender, {
    deps: {
      runBuilderTurn: async () => ({
        source: 'stub-builder',
        message: 'Updated the hours.',
        draft: pending,
        readyForReview: true,
        approved: false,
      }),
      businessBotReply: async ({ profile }) => {
        prompts.push(buildCustomerSystemPrompt(profile));
        return 'ok';
      },
    },
  });
  session.buildHistory.push({ role: 'user', content: 'I run a yoga studio' });
  await handleMessage(session, 'Change hours to Sun–Fri 8–14');
  assert.equal((await store.loadProfile(sender)).hours, 'Sun–Fri 8–14');
  const tryIt = await handleMessage(session, 'chat with me like a customer');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  await handleMessage(session, 'When are you open?');
  assert.match(prompts.at(-1), /Sun–Fri 8–14/);
  console.log('PASS edit_is_live_immediately');
}

/** The cleanup migration's key list must match emptyProfile(). */
function testMigrationKeysMatchProfile() {
  const sql = fs.readFileSync(
    path.join(
      __dirname,
      '..',
      'supabase',
      'migrations',
      '20261025170000_easybot_profile_known_keys.sql'
    ),
    'utf8'
  );
  const arrays = [...sql.matchAll(/array\[([\s\S]*?)\]/g)].map((m) =>
    [...m[1].matchAll(/'([^']+)'/g)].map((k) => k[1])
  );
  const expected = Object.keys(emptyProfile()).sort();
  assert.equal(arrays.length, 2);
  for (const keys of arrays) assert.deepEqual([...keys].sort(), expected);

  const loaded = withKnownProfileKeys({ name: 'X', retiredField: true });
  assert.equal(loaded.name, 'X');
  assert.equal(Object.hasOwn(loaded, 'retiredField'), false);
  console.log('PASS migration_keys_match_profile');
}

async function main() {
  await testRequestShape();
  await testReasoningModelFallback();
  await testFirstTurnOpeningPrefixed();
  await testTestModeFirstMessageGetsOpening();
  testHistoryBounded();
  await testMemoryPersistsThroughStore();
  await testStoredHistoryCapped();
  await testErrorTurnNotStored();
  await testApprovalIsLiveImmediately();
  testMigrationKeysMatchProfile();
  console.log('\nAll Business Bot tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
