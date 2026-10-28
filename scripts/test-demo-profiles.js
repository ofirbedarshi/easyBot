/**
 * Pre-built demo profiles: first-wake bind, opening, pick 1, TEST, stop.
 * Deterministic. No network.
 */
import assert from 'assert';
import { applyBuilderModelOutput } from '../src/applyExtraction.js';
import {
  DEMO_START_OPTION,
  OPENING_MESSAGE,
  RESET_REPLY,
  returnedIntro,
} from '../src/copy.js';
import {
  createDemo,
  extractionTextFromProspect,
  loadProspectById,
  parseArgs as parseCreateDemoArgs,
  PHONE_MISSING_WARNING,
  resolveCreateDemoInput,
  resolveOptionalPhone,
  siteTextFromSourcePages,
  SOURCE_PAGES_MAX_CHARS,
} from './create-demo.js';
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
import path from 'path';
import { fileURLToPath } from 'url';

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
    owner_name: null,
    source_url: 'https://harborcuts.example',
    reviewed_at: APPROVED_AT,
    expires_at: '2027-01-01T00:00:00.000Z',
    claimed_by: null,
    claimed_at: null,
    ...overrides,
  };
}

function expectedOpening(ownerName, business = 'Harbor Cuts') {
  const body = ownerName
    ? `Hi ${ownerName}, I'm Adam 👋\nI'm going to be the one talking with ${business}'s customers. I already learned about ${business} online.\nWant to try me out like one of your customers would? 🎉`
    : `Hi, I'm Adam 👋\nI'm going to be the one talking with ${business}'s customers. I already learned about ${business} online.\nWant to try me out like one of your customers would? 🎉`;
  return `${body}\n\n${DEMO_START_OPTION}`;
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

function assertDemoOpening(result, ownerName = null, business = 'Harbor Cuts') {
  assert.equal(result.ok, true);
  assert.equal(result.event, 'demo_opening');
  assert.equal(result.reply, expectedOpening(ownerName, business));
}

function assertDemoEnterTest(result, profile) {
  assert.equal(result.ok, true);
  assert.equal(result.event, 'enter_test');
  assert.deepEqual(result.replies, [
    enterTestBanner(profile.name),
    customerOpeningText(profile),
  ]);
  assert.equal(result.reply, enterTestBanner(profile.name));
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
  assertDemoOpening(result);
  assert.equal(session.mode, 'BUILD');
  assert.equal(session.ownerName, null);
  assert.equal(session.demoOrigin, true);
  const saved = await store.loadProfile(SENDER);
  assert.equal(saved.name, 'Harbor Cuts');
  assert.equal(saved.approvedAt, APPROVED_AT);
  assert.equal(saved.firstTestedAt, null);
  const dump = store._dump();
  const demo = Object.values(dump.demos)[0];
  assert.equal(demo.claimed_by, SENDER);
  assert.ok(demo.claimed_at);
  const reloaded = await createSenderSession(store, SENDER, { deps: stubDeps().deps });
  assert.equal(reloaded.demoOrigin, true);
  assert.equal(reloaded.ownerName, null);
  ok('phone-match binds and shows the opening');
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
  assertDemoOpening(result);
  assert.equal(session.mode, 'BUILD');
  assert.equal(session.demoOrigin, true);
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
  assert.notEqual(again.event, 'demo_opening');
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
  assertDemoOpening(result);
  const started = await handleMessage(session, '1');
  assertDemoEnterTest(started, demoProfile());
  customerQ.push('A haircut is $30.');
  const second = await handleMessage(session, 'How much is a haircut?');
  await persistSenderSession(session);
  assert.equal(second.event, 'test_turn');
  assert.equal(second.reply, 'A haircut is $30.');
  assert.equal(session.mode, 'TEST');
  const profile = await store.loadProfile(SENDER);
  assert.equal(profile.name, 'Harbor Cuts');
  assert.equal(profile.hours, 'Mon–Fri 9–17');
  ok('1 enters TEST; a customer turn then behaves normally');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const { session } = await firstTurn(store, SENDER, 'hello', stubDeps().deps);
  const other = await handleMessage(session, 'stop');
  assertDemoOpening(other);
  const alsoTest = await handleMessage(session, '/test');
  assertDemoOpening(alsoTest);
  const two = await handleMessage(session, '2');
  assertDemoOpening(two);
  assert.equal(session.mode, 'BUILD');
  const started = await handleMessage(session, '1');
  assertDemoEnterTest(started, demoProfile());
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
  assert.ok(profile.firstTestedAt);
  assert.equal(session.demoOrigin, true);
  ok('other replies re-show opening; 1 then stop leaves TEST with the demo profile');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const newHours = 'Tue–Sat 10–18';
  const { session } = await firstTurn(store, SENDER, 'hello', stubDeps({ hours: newHours }).deps);
  await handleMessage(session, '1');
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
  assertDemoOpening(result);
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
    ownerName: 'Maya',
  });
  assert.equal(record.business_phone, '+16145550132');
  assert.equal(record.owner_name, 'Maya');
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
  assert.throws(
    () =>
      reviewedDemoRecord({
        businessLabel: 'X',
        businessPhone: PHONE,
        profile: {
          ...emptyProfile(),
          whatWeDo: 'Cafe',
        },
      }),
    /business name/
  );
  ok('refuses to save a profile that cannot enter TEST');
}

{
  const noPhone = reviewedDemoRecord({
    businessLabel: 'Site Salon',
    businessPhone: null,
    sourceUrl: 'https://sitesalon.example',
    profile: demoProfile({ name: 'Site Salon', whatWeDo: 'Hair salon' }),
    code: 'NOPHONE1',
  });
  assert.equal(noPhone.business_phone, null);
  const hidden = reviewedDemoRecord({
    businessLabel: 'Site Salon',
    businessPhone: 'https://wa.me/shortlink',
    sourceUrl: 'https://sitesalon.example',
    profile: demoProfile({ name: 'Site Salon', whatWeDo: 'Hair salon' }),
    code: 'NOPHONE2',
  });
  assert.equal(hidden.business_phone, null);
  const store = createMemoryStore();
  await store.insertDemo(noPhone);
  await store.insertDemo(hidden);
  ok('null / invalid phone saves as code-only');
}

{
  const args = parseCreateDemoArgs([
    '--prospect',
    'test/fixtures/demo-prospect.fake.json',
    '--id',
    'fake-harbor',
    '--dry-run',
  ]);
  assert.equal(args.prospect, 'test/fixtures/demo-prospect.fake.json');
  assert.equal(args.id, 'fake-harbor');
  assert.equal(args.dryRun, true);
  assert.equal(args.yes, false);
  const flags = parseCreateDemoArgs([
    '--label',
    'X',
    '--source',
    'https://x.example',
    '--text',
    'x.txt',
    '--yes',
  ]);
  assert.equal(flags.yes, true);
  assert.equal(flags.phone, undefined);
  const named = parseCreateDemoArgs(['--label', 'X', '--owner-name', 'Dana']);
  assert.equal(named.ownerName, 'Dana');
  ok('create-demo parseArgs: --prospect/--id/--dry-run and optional --phone');
}

{
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../test/fixtures/demo-prospect.fake.json'
  );
  const withPhone = loadProspectById(fixture, 'fake-harbor');
  assert.equal(withPhone.businessLabel, 'Fake Harbor Cuts');
  assert.equal(withPhone.ownerName, 'Test Owner');
  assert.equal(withPhone.businessPhone, '+15125550100');
  assert.equal(withPhone.sourceUrl, 'https://fake-harbor.example/contact');
  assert.match(withPhone.siteText, /^https:\/\/fake-harbor\.example\/\nFake Harbor Cuts/);
  assert.match(withPhone.siteText, /https:\/\/fake-harbor\.example\/prices\nMen's cut \$25/);
  const noPhone = loadProspectById(fixture, 'fake-no-phone');
  assert.equal(noPhone.ownerName, null);
  assert.equal(noPhone.businessPhone, null);
  assert.match(noPhone.phoneWarning, /code link only/);
  assert.equal(noPhone.sourceUrl, 'https://fake-cafe.example');
  assert.match(noPhone.siteText, /Category:\ncafe/);
  assert.match(noPhone.siteText, /Prices:\nLatte \$4/);
  assert.equal(noPhone.siteText.includes('https://'), false);
  assert.throws(() => loadProspectById(fixture, 'does-not-exist'));
  ok('prospect fixture maps name/phone/source/{url,text} pages');
}

{
  const { phone, warning } = resolveOptionalPhone('https://wa.me/AbC');
  assert.equal(phone, null);
  assert.match(warning, /short links are not resolved/);
  assert.equal(resolveOptionalPhone('').phone, null);
  assert.equal(resolveOptionalPhone('').warning, PHONE_MISSING_WARNING);
  assert.equal(resolveOptionalPhone('+1 (512) 555-0100').phone, '+15125550100');
  const long = 'x'.repeat(SOURCE_PAGES_MAX_CHARS + 50);
  assert.equal(
    siteTextFromSourcePages([{ url: 'https://ex.example', text: long }]).length,
    SOURCE_PAGES_MAX_CHARS
  );
  assert.equal(
    siteTextFromSourcePages([
      { url: 'https://a.example', text: 'Page one.' },
      { url: 'https://b.example', text: 'Page two.' },
    ]),
    'https://a.example\nPage one.\n\nhttps://b.example\nPage two.'
  );
  assert.equal(siteTextFromSourcePages([]), '');
  const fallback = extractionTextFromProspect({
    source_pages: [],
    category: 'salon',
    city: 'Leeds',
    services: 'Cut',
    prices: 'Cut £20',
    hours: 'Tue–Sat',
    notes: 'Walk-ins',
  });
  assert.match(fallback, /City:\nLeeds/);
  assert.match(fallback, /Prices:\nCut £20/);
  ok('optional phone warning and source_pages {url,text} cap + 0-page fallback');
}

{
  const fixtureRel = 'test/fixtures/demo-prospect.fake.json';
  const mixed = {
    prospect: fixtureRel,
    id: 'fake-harbor',
    label: 'Nope',
    source: 'https://x.example',
    text: 'x.txt',
  };
  assert.throws(() => resolveCreateDemoInput(mixed));
  const fromFlags = resolveCreateDemoInput(
    {
      label: 'Flag Shop',
      source: 'https://flag.example',
      text: 'paste.txt',
    },
    {
      cwd: '/tmp',
      readFile: (p) => {
        assert.equal(p, path.join('/tmp', 'paste.txt'));
        return 'Flag Shop is a test store. Widgets $1.';
      },
    }
  );
  assert.equal(fromFlags.businessLabel, 'Flag Shop');
  assert.equal(fromFlags.businessPhone, null);
  assert.equal(fromFlags.phoneWarning, PHONE_MISSING_WARNING);
  ok('resolveCreateDemoInput: flags without phone, reject mixed modes');
}

{
  const fixture = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../test/fixtures/demo-prospect.fake.json'
  );
  const store = createMemoryStore();
  let inserted = 0;
  const origInsert = store.insertDemo.bind(store);
  store.insertDemo = async (...args) => {
    inserted += 1;
    return origInsert(...args);
  };
  const turn = {
    onPurpose: true,
    draft: {
      name: 'Fake Harbor Cuts',
      whatWeDo: 'Barbershop',
      services: [{ name: 'Haircut', price: '$30', notes: null }],
    },
    newFacts: [],
  };
  const dry = await createDemo(
    { prospect: fixture, id: 'fake-harbor', dryRun: true, yes: true },
    {
      store,
      runBuilderTurn: async () => turn,
      confirmSave: async () => true,
    }
  );
  assert.equal(dry.dryRun, true);
  assert.equal(dry.saved, null);
  assert.equal(inserted, 0);
  assert.equal(dry.input.businessPhone, '+15125550100');
  assert.equal(dry.input.ownerName, 'Test Owner');

  const savedRun = await createDemo(
    { prospect: fixture, id: 'fake-no-phone', yes: true },
    {
      store,
      runBuilderTurn: async () => ({
        ...turn,
        draft: { ...turn.draft, name: 'Fake Hidden Number Cafe', whatWeDo: 'Cafe' },
      }),
      confirmSave: async () => true,
    }
  );
  assert.equal(savedRun.dryRun, false);
  assert.equal(savedRun.saved.business_phone, null);
  assert.equal(savedRun.saved.prospect_id, 'fake-no-phone');
  assert.equal(savedRun.saved.owner_name, null);
  assert.equal(inserted, 1);
  ok('createDemo --dry-run writes nothing; prospect without E.164 is code-only');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow({ owner_name: 'Dana' }));
  const { session, result } = await firstTurn(store, SENDER, 'hi', stubDeps().deps);
  assertDemoOpening(result, 'Dana');
  assert.equal(session.ownerName, 'Dana');
  assert.equal(session.demoOrigin, true);
  const started = await handleMessage(session, '1.');
  assertDemoEnterTest(started, demoProfile());
  const stopped = await handleMessage(session, 'stop');
  const menu = `${returnedIntro('Dana')}\n\n${renderMenu({ leadOption: true, chatsOption: true })}`;
  assert.equal(stopped.replies[1], menu);
  ok('owner name on claim, 1. enters TEST, stop menu includes chats');
}

{
  const store = createMemoryStore();
  await store.insertDemo(demoRow());
  const { session } = await firstTurn(store, SENDER, 'hi', stubDeps().deps);
  const reset = await handleMessage(session, '/reset');
  await persistSenderSession(session);
  assert.equal(reset.reply, RESET_REPLY);
  assert.equal(session.demoOrigin, true);
  assert.equal(session.ownerName, null);
  const again = await handleMessage(session, 'hello');
  assert.equal(again.event, 'opening');
  assert.equal(again.reply, OPENING_MESSAGE);
  assert.equal(session.mode, 'BUILD');
  ok('/reset keeps demo_origin and goes to flow 1');
}

{
  const store = createMemoryStore();
  const { result } = await firstTurn(store, SENDER, 'hello', stubDeps().deps);
  assert.equal(result.event, 'opening');
  assert.equal(result.reply, OPENING_MESSAGE);
  ok('flow 1 opening is unchanged when no demo exists');
}

console.log(`\n${passed} passed`);
