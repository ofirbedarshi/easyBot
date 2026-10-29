/**
 * Shared client profiles: first-wake bind by exact bot-XXXXXXXX.
 * Lead talks only to the Business Bot. Deterministic. No network.
 */
import assert from 'assert';
import { applyBuilderModelOutput } from '../src/applyExtraction.js';
import { OPENING_MESSAGE } from '../src/copy.js';
import {
  CLIENT_CODE_RE,
  clientRecord,
  clientWaLink,
  formatClientCode,
  generateClientCode,
  parseClientCode,
} from '../src/clients.js';
import { DEMO_CODE_RE, parseDemoCode } from '../src/demoProfiles.js';
import { customerOpeningText, emptyProfile } from '../src/profile.js';
import {
  createSenderSession,
  handleMessage,
  persistSenderSession,
} from '../src/session.js';
import { createMemoryStore } from '../src/store/memoryStore.js';
import {
  createClient,
  parseArgs as parseCreateClientArgs,
  resolveCreateClientInput,
} from './create-client.js';
import { modeFromHandleResult, modeFromSessionPreview } from '../src/conversationLog.js';

const SENDER = 'whatsapp:+15125550111';
const OTHER = 'whatsapp:+15125550112';
const CODE = 'MAPLE2K9';

function clientProfile(overrides = {}) {
  return {
    name: 'Maple Dog Walks',
    whatWeDo: 'Dog walking',
    services: [{ name: 'Weekday walk', price: '$25', notes: null }],
    hours: 'Mon–Fri 7–18',
    locationOrArea: 'Austin',
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    otherFacts: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    approvedAt: '2026-10-29T00:00:00.000Z',
    firstTestedAt: null,
    draft: {
      name: 'Maple Dog Walks',
      whatWeDo: 'Dog walking',
      services: [{ name: 'Weekday walk', price: '$25', notes: null }],
      hours: 'Mon–Fri 7–18',
      locationOrArea: 'Austin',
      askedTopics: ['businessDetails'],
    },
    ...overrides,
  };
}

function clientRow(overrides = {}) {
  return clientRecord({
    name: 'Sam',
    businessName: 'Maple Dog Walks',
    contactChannel: 'instagram',
    status: 'lead',
    profile: clientProfile(),
    notes: 'fake fixture',
    code: CODE,
    ...overrides,
  });
}

function stubDeps({ allowBuilder = false } = {}) {
  const customerQ = [];
  const seen = [];
  return {
    deps: {
      runBuilderTurn: async ({ profile, userMessage }) => {
        if (!allowBuilder) {
          throw new Error('Builder must not run on a client-bound number');
        }
        const parsed = {
          message: 'Got it.',
          draft: {},
          onPurpose: true,
          ownerEdits: [],
          newFacts: [],
        };
        const merged = applyBuilderModelOutput(parsed, profile.draft, {
          mode: 'delta',
          live: profile,
        });
        return { source: 'stub-builder', ...parsed, draft: merged, userMessage };
      },
      businessBotReply: async ({ profile, question }) => {
        seen.push({ name: profile?.name, question });
        if (!customerQ.length) {
          throw new Error(`unexpected Business Bot turn for ${JSON.stringify(question)}`);
        }
        return customerQ.shift();
      },
    },
    customerQ,
    seen,
  };
}

async function firstTurn(store, senderId, text, deps) {
  const session = await createSenderSession(store, senderId, { deps });
  const result = await handleMessage(session, text);
  await persistSenderSession(session);
  return { session, result };
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('=== client Business Bot flow (deterministic) ===\n');

{
  assert.equal(parseClientCode('bot-MAPLE2K9'), 'MAPLE2K9');
  assert.equal(parseClientCode('BOT-maple2k9'), 'MAPLE2K9');
  assert.equal(parseClientCode(' bot-MAPLE2K9 '), 'MAPLE2K9');
  assert.equal(parseClientCode('please bot-MAPLE2K9'), null);
  assert.equal(parseClientCode('bot-MAPLE2K9 please'), null);
  assert.equal(parseClientCode('bot MAPLE2K9'), null);
  assert.equal(parseClientCode('bot-MAPLE2K'), null);
  assert.equal(parseClientCode('bot-MAPLE2K99'), null);
  assert.equal(parseClientCode('Hi Adam code-MAPLE2K9'), null);
  assert.equal(parseDemoCode('bot-MAPLE2K9'), null);
  assert.match('bot-MAPLE2K9', CLIENT_CODE_RE);
  assert.doesNotMatch('bot-MAPLE2K9', DEMO_CODE_RE);
  assert.doesNotMatch('Hi Adam code-MAPLE2K9', CLIENT_CODE_RE);
  const code = generateClientCode();
  assert.equal(code.length, 8);
  assert.equal(
    clientWaLink('MAPLE2K9'),
    'https://wa.me/17623205871?text=bot-MAPLE2K9'
  );
  assert.equal(formatClientCode('maple2k9'), 'bot-MAPLE2K9');
  ok('helpers: exact bot-XXXXXXXX regex, distinct from flow 2, wa.me link');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  const { session, result } = await firstTurn(
    store,
    SENDER,
    `bot-${CODE}`,
    stubDeps().deps
  );
  assert.equal(result.ok, true);
  assert.equal(result.event, 'client_opening');
  assert.equal(result.reply, customerOpeningText(clientProfile()));
  assert.equal(session.clientId, (await store.findClientByCode(CODE)).id);
  assert.equal(session.mode, 'BUILD');
  assert.equal(session.demoOrigin, false);
  const senderProfile = await store.loadProfile(SENDER);
  assert.equal(senderProfile.name, null);
  assert.equal(senderProfile.approvedAt, null);
  const reloaded = await createSenderSession(store, SENDER, { deps: stubDeps().deps });
  assert.equal(reloaded.clientId, session.clientId);
  assert.equal(modeFromHandleResult(result, session), 'test');
  assert.equal(modeFromSessionPreview(reloaded), 'test');
  ok('new number binds and gets the customer opening');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  const { deps, customerQ, seen } = stubDeps();
  const { session } = await firstTurn(store, SENDER, `bot-${CODE}`, deps);
  customerQ.push('A weekday walk is $25.');
  const turn = await handleMessage(session, 'How much is a weekday walk?');
  await persistSenderSession(session);
  assert.equal(turn.event, 'client_turn');
  assert.equal(turn.reply, 'A weekday walk is $25.');
  assert.deepEqual(seen, [{ name: 'Maple Dog Walks', question: 'How much is a weekday walk?' }]);
  assert.equal(session.mode, 'BUILD');
  const senderProfile = await store.loadProfile(SENDER);
  assert.equal(senderProfile.name, null);
  ok('later messages use the client profile on the Business Bot');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  const { deps, customerQ, seen } = stubDeps();
  const { session } = await firstTurn(store, SENDER, `bot-${CODE}`, deps);
  customerQ.push('I can help with walks.');
  customerQ.push('I can help with walks.');
  customerQ.push('I can help with walks.');
  for (const text of ['/test', 'stop', '/reset']) {
    const turn = await handleMessage(session, text);
    assert.equal(turn.event, 'client_turn');
    assert.equal(turn.reply, 'I can help with walks.');
  }
  assert.deepEqual(
    seen.map((s) => s.question),
    ['/test', 'stop', '/reset']
  );
  assert.ok(session.clientId);
  assert.equal(session.mode, 'BUILD');
  ok('/test, stop, and /reset stay on the Business Bot');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  const { result } = await firstTurn(store, SENDER, 'bot-NOTREAL1', stubDeps().deps);
  assert.equal(result.event, 'opening');
  assert.equal(result.reply, OPENING_MESSAGE);
  const saved = await createSenderSession(store, SENDER);
  assert.equal(saved.clientId, null);
  ok('unknown code falls through to Adam opening');
}

{
  const store = createMemoryStore();
  const session1 = await createSenderSession(store, SENDER, {
    deps: stubDeps({ allowBuilder: true }).deps,
  });
  const open = await handleMessage(session1, 'hi');
  await persistSenderSession(session1);
  assert.equal(open.event, 'opening');
  await store.insertClient(clientRow());
  const session2 = await createSenderSession(store, SENDER, {
    deps: stubDeps({ allowBuilder: true }).deps,
  });
  const again = await handleMessage(session2, `bot-${CODE}`);
  await persistSenderSession(session2);
  assert.equal(again.event, 'build_turn');
  assert.equal(session2.clientId, null);
  ok('existing sender is never bound');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  const first = await firstTurn(store, SENDER, `bot-${CODE}`, stubDeps().deps);
  const second = await firstTurn(store, OTHER, `bot-${CODE}`, stubDeps().deps);
  assert.equal(first.result.event, 'client_opening');
  assert.equal(second.result.event, 'client_opening');
  assert.equal(first.session.clientId, second.session.clientId);
  ok('one code binds many leads');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  const { result } = await firstTurn(store, SENDER, 'hello there', stubDeps().deps);
  assert.equal(result.event, 'opening');
  assert.equal(result.reply, OPENING_MESSAGE);
  ok('plain first message still opens Adam');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  await store.insertDemo({
    business_label: 'Harbor Cuts',
    business_phone: '+15125550900',
    code: 'ABCD2345',
    profile: {
      ...emptyProfile(),
      name: 'Harbor Cuts',
      whatWeDo: 'Barbershop',
      services: [{ name: 'Haircut', price: '$30', notes: null }],
      approvedAt: '2026-10-28T00:00:00.000Z',
    },
    owner_name: null,
    source_url: 'https://harborcuts.example',
    reviewed_at: '2026-10-28T00:00:00.000Z',
    expires_at: '2027-01-01T00:00:00.000Z',
  });
  const { session, result } = await firstTurn(
    store,
    OTHER,
    'Hi Adam code-ABCD2345',
    stubDeps().deps
  );
  assert.equal(result.event, 'demo_opening');
  assert.equal(session.demoOrigin, true);
  assert.equal(session.clientId, null);
  ok('flow 2 Hi Adam code-XXXX is unchanged');
}

{
  const store = createMemoryStore();
  await store.insertClient(clientRow());
  await store.ensureSender(SENDER);
  await store.enqueueInbound({
    messageSid: 'SM-client-1',
    senderId: SENDER,
    body: `bot-${CODE}`,
  });
  const session = await createSenderSession(store, SENDER, { deps: stubDeps().deps });
  const result = await handleMessage(session, `bot-${CODE}`);
  await persistSenderSession(session);
  assert.equal(result.event, 'client_opening');
  assert.ok(session.clientId);
  ok('first inbound after enqueue still binds (production path)');
}

{
  const args = parseCreateClientArgs([
    '--business-name',
    'Maple Dog Walks',
    '--name',
    'Sam',
    '--channel',
    'instagram',
    '--status',
    'trial',
    '--what-we-do',
    'Dog walking',
    '--notes',
    'fake fixture',
    '--dry-run',
  ]);
  const input = resolveCreateClientInput(args);
  assert.equal(input.businessName, 'Maple Dog Walks');
  assert.equal(input.profile.name, 'Maple Dog Walks');
  assert.equal(input.profile.whatWeDo, 'Dog walking');
  assert.equal(input.status, 'trial');
  const store = createMemoryStore();
  const savedRun = await createClient(
    parseCreateClientArgs([
      '--business-name',
      'Maple Dog Walks',
      '--what-we-do',
      'Dog walking',
      '--yes',
    ]),
    { store, confirmSave: async () => true }
  );
  assert.equal(savedRun.saved.business_name, 'Maple Dog Walks');
  assert.equal(savedRun.saved.status, 'lead');
  assert.match(savedRun.saved.code, /^[A-Z0-9]{8}$/);
  const found = await store.findClientByCode(savedRun.saved.code);
  assert.ok(found);
  ok('create-client script saves a row and prints a reusable code');
}

{
  assert.throws(
    () => clientRecord({ businessName: 'X', status: 'vip', code: CODE, profile: emptyProfile() }),
    /status/
  );
  ok('client status is constrained');
}

console.log(`\n${passed} passed`);
