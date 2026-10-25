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
  buildBusinessBotMessages,
  businessBotReply,
} from '../src/businessBot.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import { emptyProfile, withKnownProfileKeys } from '../src/profile.js';
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

  process.env.OPENAI_MODEL = 'gpt-test-model';
  const client2 = fakeClient();
  await businessBotReply({ profile, history: [], question: 'Hi', client: client2 });
  assert.equal(client2.requests[0].model, 'gpt-test-model');
  assert.equal(client2.requests[0].temperature, 0);

  if (prevModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = prevModel;
  console.log('PASS request_shape_model_temperature_prompt');
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
  assert.match(r.reply, /^Business Bot error:/);
  assert.ok(!r.reply.includes('sk-secret'));
  assert.ok(!logged.join('\n').includes('sk-secret'));
  assert.deepEqual(session.testHistory, []);
  console.log('PASS error_turn_not_stored');
}

/** Approval makes the Business Bot use the new facts immediately. */
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
  const tryIt = await handleMessage(session, 'Try my bot');
  assert.equal(tryIt.event, 'approved_enter_test');
  assert.equal(session.mode, 'TEST');
  await handleMessage(session, 'When are you open?');
  assert.match(prompts.at(-1), /Sun–Fri 8–14/);
  console.log('PASS approval_is_live_immediately');
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
