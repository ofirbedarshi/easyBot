/**
 * Pre-built demo profiles: first-wake bind, TEST chrome, stop, correction.
 * Deterministic. No network.
 */
import assert from 'assert';
import { applyBuilderModelOutput } from '../src/applyExtraction.js';
import {
  DEMO_INTRO,
  OPENING_MESSAGE,
  returnedIntro,
} from '../src/copy.js';
import {
  DEMO_CODE_ALPHABET,
  DEMO_CODE_RE,
  extractDemoProfile,
  fallbackWaLink,
  generateDemoCode,
  normalizeBusinessPhone,
  parseDemoCode,
  reviewedDemoRecord,
} from '../src/demoProfiles.js';
import { customerOpeningText, emptyProfile } from '../src/profile.js';
import {
  createSenderSession,
  enterTestBanner,
  handleMessage,
  persistSenderSession,
} from '../src/session.js';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { renderMenu } from '../src/ownerNav.js';

const PHONE = '+15125550100';
const SENDER = `whatsapp:${PHONE}`;
const OTHER = 'whatsapp:+15125550999';
const CODE = 'ABCD2345';
const APPROVED_AT = '2026-10-28T00:00:00.000Z';

function demoProfile(overrides = {}) {
  return {
    name: 'Harbor Cuts',
    whatWeDo: 'Barbershop',
    services: [{ name: 'Haircut', price: '$30', notes: null }],
    hours: 'Mon–Fri 9–17',
    locationOrArea: 'Austin',
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    otherFacts: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    approvedAt: APPROVED_AT,
    firstTestedAt: null,
    draft: {
      name: 'Harbor Cuts',
      whatWeDo: 'Barbershop',
      services: [{ name: 'Haircut', price: '$30', notes: null }],
      hours: 'Mon–Fri 9–17',
      locationOrArea: 'Austin',
      askedTopics: ['businessDetails'],
    },
    ...overrides,
  };
}

function demoRow(overrides = {}) {
  return {
    business_label: 'Harbor Cuts',
    business_phone: PHONE,
    code: CODE,
    profile: demoProfile(),
    source_url: 'https://harborcuts.example',
    reviewed_at: APPROVED_AT,
    expires_at: '2027-01-01T00:00:00.000Z',
    claimed_by: null,
    claimed_at: null,
    ...overrides,
  };
}

function stubDeps({ hours } = {}) {
  const customerQ = [];
  return {
    deps: {
      runBuilderTurn: async ({ profile, userMessage }) => {
        const parsed = {
          message: 'Got it, hours updated ✨',
          draft: { hours: hours || 'Tue–Sat 10–18' },
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
      businessBotReply: async ({ question }) => {
        if (!customerQ.length) {
          throw new Error(`unexpected Business Bot turn for ${JSON.stringify(question)}`);
        }
        return customerQ.shift();
      },
    },
    customerQ,
  };
}

async function firstTurn(store, senderId, text, deps) {
  const session = await createSenderSession(store, senderId, { deps });
  const result = await handleMessage(session, text);
  await persistSenderSession(session);
  return { session, result };
}

function assertDemoEnter(result, profile) {
  assert.equal(result.ok, true);
  assert.equal(result.event, 'enter_test');
  assert.equal(result.replies[0], DEMO_INTRO);
  assert.equal(result.replies[1], enterTestBanner(profile.name));
  assert.equal(result.replies[2], customerOpeningText(profile));
  assert.equal(result.reply.startsWith(DEMO_INTRO), true);
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

console.log('=== pre-built demo profiles (deterministic) ===\n');

{
  assert.equal(normalizeBusinessPhone('+1 (512) 555-0100'), '+15125550100');
  assert.equal(normalizeBusinessPhone('whatsapp:+15125550100'), '+15125550100');
  assert.equal(normalizeBusinessPhone('15125550100'), '+15125550100');
  assert.equal(normalizeBusinessPhone('050-123-4567'), null);
  assert.equal(parseDemoCode('Hi Adam code-ABCD2345'), 'ABCD2345');
  assert.equal(parseDemoCode('hi adam code-abcd2345'), 'ABCD2345');
  assert.equal(parseDemoCode('Hi Adam, code-ABCD2345'), null);
  assert.equal(parseDemoCode('please use code-ABCD2345'), null);
  assert.match('Hi Adam code-ABCD2345', DEMO_CODE_RE);
  const code = generateDemoCode();
  assert.equal(code.length >= 8, true);
  assert.match(code, /^[A-Z0-9]{8,}$/);
  for (const ch of code) assert.equal(DEMO_CODE_ALPHABET.includes(ch), true);
  assert.equal(
    fallbackWaLink('ABCD2345'),
    'https://wa.me/17623205871?text=Hi%20Adam%20code-ABCD2345'
  );
  ok('helpers: phone, code regex, unambiguous code, wa.me link');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const { session, result } = await firstTurn(store, SENDER, 'hello there', stubDeps().deps);
  assertDemoEnter(result, demoProfile());
  assert.equal(session.mode, 'TEST');
  assert.equal(session.ownerName, null);
  const saved = await store.loadProfile(SENDER);
  assert.equal(saved.name, 'Harbor Cuts');
  assert.equal(saved.approvedAt, APPROVED_AT);
  const dump = store._dump();
  const demo = Object.values(dump.demos)[0];
  assert.equal(demo.claimed_by, SENDER);
  assert.ok(demo.claimed_at);
  ok('phone-match binds and enters TEST');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow({ business_phone: '+15125550900' }));
  const { session, result } = await firstTurn(
    store,
    OTHER,
    `Hi Adam code-${CODE}`,
    stubDeps().deps
  );
  assertDemoEnter(result, demoProfile());
  assert.equal(session.mode, 'TEST');
  const dump = store._dump();
  assert.equal(Object.values(dump.demos)[0].claimed_by, OTHER);
  ok('code-match binds');
}

{
  const store = createMemoryStore();
  await store.insertDemo(
    demoRow({ expires_at: '2020-01-01T00:00:00.000Z', code: 'EXPIRED1' })
  );
  const { result } = await firstTurn(store, SENDER, 'hello', stubDeps().deps);
  assert.equal(result.event, 'opening');
  assert.equal(result.reply, OPENING_MESSAGE);
  const { result: coded } = await firstTurn(
    store,
    OTHER,
    'Hi Adam code-EXPIRED1',
    stubDeps().deps
  );
  assert.equal(coded.event, 'opening');
  ok('expired is ignored');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow({ claimed_by: 'whatsapp:+19999999999', claimed_at: APPROVED_AT }));
  const { result } = await firstTurn(store, SENDER, 'hello', stubDeps().deps);
  assert.equal(result.event, 'opening');
  const { result: coded } = await firstTurn(
    store,
    OTHER,
    `Hi Adam code-${CODE}`,
    stubDeps().deps
  );
  assert.equal(coded.event, 'opening');
  ok('already claimed is ignored');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow({ reviewed_at: null, code: 'UNREVIEW1' }));
  const { result } = await firstTurn(store, SENDER, 'hello', stubDeps().deps);
  assert.equal(result.event, 'opening');
  const { result: coded } = await firstTurn(
    store,
    OTHER,
    'Hi Adam code-UNREVIEW1',
    stubDeps().deps
  );
  assert.equal(coded.event, 'opening');
  ok('unreviewed is ignored');
}

{
  const store = createMemoryStore();
  const session1 = await createSenderSession(store, SENDER, { deps: stubDeps().deps });
  const open = await handleMessage(session1, 'hi');
  await persistSenderSession(session1);
  assert.equal(open.event, 'opening');
  await store.insertDemo(demoRow());
  const session2 = await createSenderSession(store, SENDER, { deps: stubDeps().deps });
  assert.equal(session2.demoBindEligible, false);
  const again = await handleMessage(session2, 'hi');
  await persistSenderSession(session2);
  assert.notEqual(again.event, 'enter_test');
  assert.equal(session2.mode, 'BUILD');
  const profile = await store.loadProfile(SENDER);
  assert.equal(profile.name, null);
  assert.equal(profile.approvedAt, null);
  ok('existing sender is never rebound');
}

{
  const store = createMemoryStore();
  const { result } = await firstTurn(
    store,
    SENDER,
    'Hi Adam code-NOTREAL1',
    stubDeps().deps
  );
  assert.equal(result.event, 'opening');
  assert.equal(result.reply, OPENING_MESSAGE);
  ok('invalid code gives the normal opening');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const { deps, customerQ } = stubDeps();
  const { session, result } = await firstTurn(store, SENDER, 'hello', deps);
  assertDemoEnter(result, demoProfile());
  customerQ.push('A haircut is $30.');
  const second = await handleMessage(session, 'How much is a haircut?');
  await persistSenderSession(session);
  assert.equal(second.event, 'test_turn');
  assert.equal(second.reply, 'A haircut is $30.');
  assert.equal(session.mode, 'TEST');
  const profile = await store.loadProfile(SENDER);
  assert.equal(profile.name, 'Harbor Cuts');
  assert.equal(profile.hours, 'Mon–Fri 9–17');
  ok('second message from a bound sender behaves normally');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const { session } = await firstTurn(store, SENDER, 'hello', stubDeps().deps);
  const stopped = await handleMessage(session, 'stop');
  await persistSenderSession(session);
  assert.equal(stopped.event, 'enter_build');
  assert.equal(session.mode, 'BUILD');
  assert.match(stopped.reply, /Test mode is off/);
  const menu = `${returnedIntro(null)}\n\n${renderMenu({ leadOption: true, chatsOption: true })}`;
  assert.equal(stopped.replies[1], menu);
  const profile = await store.loadProfile(SENDER);
  assert.equal(profile.name, 'Harbor Cuts');
  assert.equal(profile.hours, 'Mon–Fri 9–17');
  assert.equal(profile.approvedAt, APPROVED_AT);
  ok('stop leaves TEST to the builder with the demo profile intact');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const newHours = 'Tue–Sat 10–18';
  const { session } = await firstTurn(store, SENDER, 'hello', stubDeps({ hours: newHours }).deps);
  const stopped = await handleMessage(session, 'stop');
  assert.equal(stopped.event, 'enter_build');
  const corrected = await handleMessage(session, 'We are actually open Tuesday to Saturday 10 to 18.');
  await persistSenderSession(session);
  assert.equal(corrected.ok, true);
  assert.equal(corrected.event, 'build_turn');
  const profile = await store.loadProfile(SENDER);
  assert.equal(profile.name, 'Harbor Cuts');
  assert.equal(profile.hours, newHours);
  assert.equal(profile.whatWeDo, 'Barbershop');
  assert.equal(session.mode, 'BUILD');
  ok('stop then a correction updates the demo profile');
}

{
  const store = createMemoryStore();
  await store.ensureSender(SENDER);
  await store.insertDemo(demoRow());
  await store.enqueueInbound({
    messageSid: 'SM-demo-1',
    senderId: SENDER,
    body: 'hi from the shop',
  });
  const session = await createSenderSession(store, SENDER, { deps: stubDeps().deps });
  assert.equal(session.demoBindEligible, false);
  const result = await handleMessage(session, 'hi from the shop');
  await persistSenderSession(session);
  assertDemoEnter(result, demoProfile());
  ok('first inbound after enqueue still binds (production path)');
}

{
  const turn = {
    onPurpose: true,
    draft: {
      name: 'Site Salon',
      whatWeDo: 'Hair salon',
      services: [{ name: "Women's cut", price: '$45', notes: null }],
      hours: 'Tue–Sat 9–6',
      locationOrArea: 'Columbus',
      askedTopics: ['businessDetails'],
    },
    newFacts: [],
  };
  const { profile, summary } = await extractDemoProfile({
    siteText: 'Site Salon is a hair salon in Columbus. Women\'s cut $45. Tue–Sat 9–6.',
    sourceUrl: 'https://sitesalon.example',
    runBuilderTurn: async () => turn,
  });
  assert.equal(profile.name, 'Site Salon');
  assert.match(summary, /Site Salon/);
  const record = reviewedDemoRecord({
    businessLabel: 'Site Salon',
    businessPhone: '+16145550132',
    sourceUrl: 'https://sitesalon.example',
    profile,
    code: 'SITECODE1',
  });
  assert.equal(record.business_phone, '+16145550132');
  assert.ok(record.reviewed_at);
  assert.ok(record.profile.approvedAt);
  const store = createMemoryStore();
  const saved = await store.insertDemo(record);
  assert.equal(saved.code, 'SITECODE1');
  ok('extractDemoProfile + reviewed save (stubbed Builder)');
}

{
  assert.throws(() =>
    reviewedDemoRecord({
      businessLabel: 'X',
      businessPhone: PHONE,
      profile: emptyProfile(),
    })
  );
  ok('refuses to save a profile that cannot enter TEST');
}

console.log(`\n${passed} passed`);
