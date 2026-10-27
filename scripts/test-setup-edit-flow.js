/**
 * Post-approval edit + menu safety net (architecture audit §5 missing cases).
 *
 * Starts after the 🎉 setup-complete card. Drives the real handleMessage
 * entry point with a stubbed Builder/Business Bot (no network). The stub
 * runs applyBuilderModelOutput so list merge / ownerEdits
 * are the production path — later composer or agenda
 * refactors should keep these tables green.
 *
 * Test-only. Does not change production code, prompts, or copy.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  customerOpeningText,
  emptyProfile,
  loadProfile,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import {
  applyBuilderModelOutput,
  OWNER_GOAL_QUESTION,
} from '../src/builder.js';
import {
  BUSINESS_DETAILS_ACK,
  BUSINESS_DETAILS_MARKER,
  topicByKey,
} from '../src/builderTopics.js';
import {
  createSession,
  enterTestBanner,
  exitTestBanner,
  handleMessage,
} from '../src/session.js';
import {
  lastShownNav,
  renderChangeMenu,
  renderSavedChanges,
  renderSection,
  renderSetupComplete,
} from '../src/ownerNav.js';
import {
  LEAD_BRIDGE,
  LEAD_INTRO,
  LEAD_THANKS_YES,
} from '../src/leadIntake.js';

const PROFILE = testProfilePath('setup-edit-flow');
const FAQ = topicByKey('commonQuestions');
const INTAKE = topicByKey('informationToCollect');

const NAME = 'Ofir garage';
const WHAT = 'Garage';
const SERVICE = { name: 'Oil change', price: '200 ILS', notes: null };
const NEW_SERVICE = { name: 'Brake pads', price: '350 ILS', notes: null };
const SERVICE_PRICE_EDIT = { name: 'Oil change', price: '250 ILS', notes: null };
const HOURS = 'Mon–Fri 8–18';
const AREA = 'Haifa';
const FAQ_ITEM = {
  question: 'Do you work on trucks?',
  answer: 'Yes, light trucks too.',
};
const NEW_FAQ = {
  question: 'Do you sell parts?',
  answer: 'Yes, filters and pads.',
};
const FAQ_EDIT = {
  question: 'Do you work on trucks?',
  answer: 'Yes, all truck sizes.',
};
const INTAKE_ITEMS = ['name', 'phone'];
const INTAKE_ADDED = ['name', 'phone', 'car model'];
const CUSTOMER_Q = 'How much is an oil change?';
const CUSTOMER_A = 'An oil change is 200 ILS.';
const STYLE = 'professional';
const OPENING = 'Welcome to Ofir garage — how can I help?';
const APPROVED_AT = '2026-01-01T00:00:00.000Z';
const ASKED = ['businessDetails', 'commonQuestions', 'informationToCollect'];

const SETUP_COMPLETE_HEAD = "🎉 I'm all set! This is what I know about your business:";
const CHANGED_ACK = "Here's what changed:";
const MENU_HEAD = 'What should we do next?';
const SECTION_ASK = 'What do you want to change?';
const LEGACY_CARD = "Here's your bot";
const MENU_HINT = 'Type *menu* to go back to the main menu.';

const SECTION_INTROS = {
  1: '🏪 This is what I know about your business:',
  2: '❓ These are the questions I know how to answer:',
  3: '💬 This is how I talk to your customers right now:',
};

const ACKS = [
  BUSINESS_DETAILS_ACK,
  FAQ.ack,
  INTAKE.ack,
  CHANGED_ACK,
  SETUP_COMPLETE_HEAD,
];

const SCRIPT_QUESTIONS = [
  { id: 'tell-more', needle: BUSINESS_DETAILS_MARKER },
  { id: 'goal', needle: OWNER_GOAL_QUESTION },
  { id: 'faq', needle: FAQ.question },
  { id: 'intake', needle: INTAKE.question },
];

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function draft(overrides = {}) {
  return {
    name: NAME,
    whatWeDo: WHAT,
    ownerGoal: 'answer_and_collect',
    ownerGoalRequested: 'answer questions and take customer details',
    services: [SERVICE],
    hours: HOURS,
    locationOrArea: AREA,
    commonQuestions: [FAQ_ITEM],
    informationToCollect: INTAKE_ITEMS,
    unknowns: [],
    otherFacts: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    askedTopics: ASKED,
    ...overrides,
  };
}

function approvedProfile(overrides = {}) {
  const f = draft(overrides);
  const { askedTopics, ...live } = f;
  return {
    ...emptyProfile(),
    ...live,
    approvedAt: APPROVED_AT,
    draft: { ...f },
  };
}

function modelTurn(delta = {}, overrides = {}) {
  return {
    message: `${NAME} is your garage ✨`,
    draft: delta,
    readyForReview: false,
    wantsReview: false,
    asksQuestion: false,
    askingTopic: null,
    onPurpose: true,
    ownerEdits: [],
    ...overrides,
  };
}

function countNeedle(text, needle) {
  if (!needle) return 0;
  const src = String(text || '');
  let n = 0;
  let from = 0;
  while (from <= src.length) {
    const at = src.indexOf(needle, from);
    if (at === -1) return n;
    n += 1;
    from = at + needle.length;
  }
  return n;
}

function looksLikeJson(text) {
  const s = String(text || '');
  if (/"readyForReview"|"asksQuestion"|"wantsReview"|"ownerEdits"|"onPurpose"/.test(s)) {
    return 'schema json';
  }
  if (/```json/i.test(s)) return 'json fence';
  if (/\{[^{}]*"[a-zA-Z]+"\s*:/.test(s)) return 'object json';
  return null;
}

/** One required-topic / goal question per reply; the same ack only once; no || / JSON. */
function assertReplyShape(reply, label) {
  const text = String(reply || '');
  const present = SCRIPT_QUESTIONS.filter((q) => text.includes(q.needle)).map((q) => q.id);
  assert.ok(
    present.length <= 1,
    `${label}: two interview questions in one reply (${present.join(' + ')}):\n${text}`
  );
  for (const ack of ACKS) {
    assert.ok(
      countNeedle(text, ack) <= 1,
      `${label}: ack ${JSON.stringify(ack)} appeared twice:\n${text}`
    );
  }
  assert.ok(!text.includes('||'), `${label}: raw || leaked:\n${text}`);
  const jsonKind = looksLikeJson(text);
  assert.equal(jsonKind, null, `${label}: raw ${jsonKind} leaked:\n${text}`);
}

function expectedMenu(leadOption = true) {
  return renderChangeMenu({ leadOption });
}

function uniqueNames(list, label) {
  const names = list.map((s) => s?.name).filter(Boolean);
  assert.equal(new Set(names).size, names.length, `${label}: duplicate services ${JSON.stringify(names)}`);
}

const results = [];

async function test(name, fn, { knownFailing = false, reason = '' } = {}) {
  try {
    await fn();
    if (knownFailing) {
      results.push({
        name,
        pass: false,
        error: `marked known-failing (${reason}) but passed`,
      });
      console.log(`FAIL ${name}: marked known-failing but passed`);
    } else {
      results.push({ name, pass: true });
      console.log(`PASS ${name}`);
    }
  } catch (err) {
    if (knownFailing) {
      results.push({ name, pass: true, knownFailing: true, error: err.message });
      console.log(`KNOWN-FAIL ${name}: ${reason} — ${err.message}`);
    } else {
      results.push({ name, pass: false, error: err.message });
      console.log(`FAIL ${name}: ${err.message}`);
    }
  }
}

/**
 * Drive one table through handleMessage from an already-approved profile
 * (history seeded with the 🎉 card, lastShownNav = review).
 *
 * `model` is a Builder JSON object. The stub runs applyBuilderModelOutput
 * (delta merge) so omitted list items and ownerEdits use the production path.
 */
async function playApprovedFlow(steps, { history, profile: seed } = {}) {
  clean();
  saveProfile(seed || approvedProfile(), PROFILE);
  const builderQ = [];
  const customerQ = [];
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async ({ profile, userMessage }) => {
        if (!builderQ.length) {
          throw new Error(`unexpected Builder turn for ${JSON.stringify(userMessage)}`);
        }
        const parsed = builderQ.shift();
        const currentDraft = profile.draft;
        const merged = applyBuilderModelOutput(parsed, currentDraft, {
          mode: 'delta',
          live: profile,
        });
        return { source: 'stub-builder', ...parsed, draft: merged };
      },
      businessBotReply: async ({ question }) => {
        if (!customerQ.length) {
          throw new Error(`unexpected Business Bot turn for ${JSON.stringify(question)}`);
        }
        return customerQ.shift();
      },
    },
  });

  if (history) {
    session.buildHistory.push(...history);
  } else {
    const profile = loadProfile(PROFILE);
    session.buildHistory.push(
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: "Hi, I'm Adam" },
      { role: 'user', content: 'setup dump' },
      { role: 'assistant', content: renderSetupComplete(profile), nav: 'review' }
    );
  }

  for (const step of steps) {
    const label = step.name;
    if (step.model) builderQ.push(step.model);
    if (step.customer != null) customerQ.push(step.customer);
    const before = loadProfile(PROFILE);
    const out = await handleMessage(session, step.in);
    const profile = fs.existsSync(PROFILE) ? loadProfile(PROFILE) : emptyProfile();
    const ctx = { out, session, profile, before, reply: out.reply };
    const expect = step.expect || {};

    assert.equal(out.ok, true, `${label}: ok`);
    if (expect.event) {
      assert.equal(out.event, expect.event, `${label}: event got ${out.event} reply=${JSON.stringify(out.reply)}`);
    }
    if (expect.mode) assert.equal(session.mode, expect.mode, `${label}: mode`);

    const reply = resolveExpect(expect.reply, ctx);
    if (reply !== undefined) {
      assert.equal(out.reply, reply, `${label}: reply`);
    }
    const replies = resolveExpect(expect.replies, ctx);
    if (replies !== undefined) {
      assert.deepEqual(out.replies, replies, `${label}: replies`);
    }
    if (expect.startsWith) {
      assert.ok(
        String(out.reply).startsWith(expect.startsWith),
        `${label}: expected start ${JSON.stringify(expect.startsWith)}\n${out.reply}`
      );
    }
    for (const needle of expect.includes || []) {
      assert.ok(String(out.reply).includes(needle), `${label}: missing ${JSON.stringify(needle)}\n${out.reply}`);
    }
    for (const needle of expect.excludes || []) {
      assert.ok(!String(out.reply).includes(needle), `${label}: unexpected ${JSON.stringify(needle)}\n${out.reply}`);
    }
    if (expect.nav !== undefined) {
      assert.equal(lastShownNav(session.buildHistory), expect.nav, `${label}: nav`);
    }
    if (expect.approvedAt === null) {
      assert.equal(profile.approvedAt, null, `${label}: approvedAt should be empty`);
    } else if (expect.approvedAt === true) {
      assert.ok(profile.approvedAt, `${label}: approvedAt should be set`);
    } else if (expect.approvedAt !== undefined) {
      assert.equal(profile.approvedAt, expect.approvedAt, `${label}: approvedAt`);
    }
    if (expect.live) {
      for (const [key, value] of Object.entries(expect.live)) {
        assert.deepEqual(
          profile[key],
          value,
          `${label}: live.${key} got ${JSON.stringify(profile[key])}`
        );
      }
    }
    if (expect.draft) {
      for (const [key, value] of Object.entries(expect.draft)) {
        assert.deepEqual(profile.draft?.[key], value, `${label}: draft.${key}`);
      }
    }
    if (expect.uniqueServices) {
      uniqueNames(profile.services, `${label} live`);
      uniqueNames(profile.draft?.services, `${label} draft`);
    }

    assertReplyShape(out.reply, label);
    if (Array.isArray(out.replies)) {
      for (const [i, part] of out.replies.entries()) assertReplyShape(part, `${label} replies[${i}]`);
    }
  }

  assert.equal(builderQ.length, 0, `unused Builder stubs: ${builderQ.length}`);
  assert.equal(customerQ.length, 0, `unused Business Bot stubs: ${customerQ.length}`);
  return { session };
}

function resolveExpect(value, ctx) {
  if (typeof value === 'function') return value(ctx);
  return value;
}

function keepTeaching() {
  return {
    name: 'keep teaching → editing menu',
    in: 'keep teaching me',
    expect: {
      event: 'menu',
      mode: 'BUILD',
      reply: expectedMenu(true),
      approvedAt: APPROVED_AT,
      nav: 'menu',
      includes: [MENU_HEAD],
      excludes: [LEGACY_CARD],
    },
  };
}

function saveCardExpect(extra = {}) {
  return {
    event: 'build_turn',
    mode: 'BUILD',
    reply: ({ before, profile }) => renderSavedChanges(before, profile),
    startsWith: CHANGED_ACK,
    approvedAt: APPROVED_AT,
    nav: 'review',
    uniqueServices: true,
    excludes: [LEGACY_CARD, 'Ready for review.'],
    ...extra,
  };
}

await test('add / change / remove a service: one save card, live updated, no duplicates', async () => {
  await playApprovedFlow([
    {
      name: 'add Brake pads → Here’s what changed + save card',
      in: 'also do brake pads for 350 ILS',
      model: modelTurn(
        { services: [NEW_SERVICE] },
        { message: 'Ready for review.', readyForReview: true }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, '*Services & prices:*', MENU_HEAD, 'Brake pads — 350 ILS', 'Oil change — 200 ILS'],
        }),
        live: { services: [SERVICE, NEW_SERVICE] },
        draft: { services: [SERVICE, NEW_SERVICE] },
      },
    },
    {
      name: 'change Oil change price → single services line, no duplicate',
      in: 'oil change is now 250 ILS',
      model: modelTurn(
        { services: [SERVICE_PRICE_EDIT] },
        {
          message: 'Ready for review.',
          readyForReview: true,
          ownerEdits: [{ field: 'services', item: 'Oil change', action: 'change' }],
        }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, '*Services & prices:*', MENU_HEAD, 'Oil change — 250 ILS'],
        }),
        live: { services: [SERVICE_PRICE_EDIT, NEW_SERVICE] },
        draft: { services: [SERVICE_PRICE_EDIT, NEW_SERVICE] },
      },
    },
    {
      name: 'remove Brake pads → live list without it',
      in: 'stop offering brake pads',
      model: modelTurn(
        { services: [] },
        {
          message: 'Ready for review.',
          readyForReview: true,
          ownerEdits: [{ field: 'services', item: 'Brake pads', action: 'remove' }],
        }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, '*Services & prices:*', MENU_HEAD, 'Oil change — 250 ILS'],
          excludes: [LEGACY_CARD, 'Ready for review.', 'Brake pads'],
        }),
        live: { services: [SERVICE_PRICE_EDIT] },
        draft: { services: [SERVICE_PRICE_EDIT] },
      },
    },
    keepTeaching(),
  ]);
});

await test('add a Q&A, then edit it', async () => {
  await playApprovedFlow([
    {
      name: 'add Q&A → save card',
      in: 'customers also ask if we sell parts. yes, filters and pads',
      model: modelTurn(
        { commonQuestions: [NEW_FAQ] },
        { message: 'Ready for review.', readyForReview: true }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, MENU_HEAD, '*Q&A:* 2 answers'],
        }),
        live: { commonQuestions: [FAQ_ITEM, NEW_FAQ] },
        draft: { commonQuestions: [FAQ_ITEM, NEW_FAQ] },
      },
    },
    {
      name: 'edit existing Q&A answer → one row, no duplicate question',
      in: 'we work on all truck sizes',
      model: modelTurn(
        { commonQuestions: [FAQ_EDIT] },
        {
          message: 'Ready for review.',
          readyForReview: true,
          ownerEdits: [{ field: 'commonQuestions', item: FAQ_ITEM.question, action: 'change' }],
        }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, MENU_HEAD, '*Q&A:* 2 answers'],
        }),
        live: { commonQuestions: [FAQ_EDIT, NEW_FAQ] },
        draft: { commonQuestions: [FAQ_EDIT, NEW_FAQ] },
      },
    },
  ]);
  const profile = loadProfile(PROFILE);
  const questions = (profile.commonQuestions || []).map((q) => q.question);
  assert.equal(new Set(questions).size, questions.length, `duplicate FAQ questions: ${questions}`);
  assert.equal(questions.filter((q) => q === FAQ_ITEM.question).length, 1);
});

await test('change How I talk (Style, Opening message) and Price policy', async () => {
  await playApprovedFlow([
    {
      name: 'Style → save card with How I talk',
      in: 'talk in a professional style',
      model: modelTurn(
        { tone: STYLE },
        { message: 'Ready for review.', readyForReview: true }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, MENU_HEAD, `*How I talk:* ${STYLE}`],
        }),
        live: { tone: STYLE },
        draft: { tone: STYLE },
      },
    },
    {
      name: 'Opening message → save card',
      in: `opening should be: ${OPENING}`,
      model: modelTurn(
        { openingMessage: OPENING },
        { message: 'Ready for review.', readyForReview: true }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, MENU_HEAD, '*How I talk:*'],
        }),
        live: { openingMessage: OPENING, tone: STYLE },
        draft: { openingMessage: OPENING, tone: STYLE },
      },
    },
    {
      name: 'Price policy → save card',
      in: 'only share prices when the customer asks',
      model: modelTurn(
        { priceDisclosure: 'on_request' },
        { message: 'Ready for review.', readyForReview: true }
      ),
      expect: {
        ...saveCardExpect({
          includes: [
            CHANGED_ACK,
            MENU_HEAD,
            '*Price policy:* I share prices only when a customer asks',
          ],
        }),
        live: { priceDisclosure: 'on_request' },
        draft: { priceDisclosure: 'on_request' },
      },
    },
    keepTeaching(),
  ]);
});

await test('add an informationToCollect item', async () => {
  await playApprovedFlow([
    {
      name: 'add car model to intake → live list grows',
      in: 'also ask for the car model',
      model: modelTurn(
        { informationToCollect: INTAKE_ADDED },
        { message: 'Ready for review.', readyForReview: true }
      ),
      expect: {
        ...saveCardExpect({
          includes: [CHANGED_ACK, MENU_HEAD, "*I'll ask customers for:* name, phone, car model"],
        }),
        live: { informationToCollect: INTAKE_ADDED },
        draft: { informationToCollect: INTAKE_ADDED },
      },
    },
  ]);
});

await test('remove one informationToCollect item (ownerEdits remove)', async () => {
  await playApprovedFlow([
    {
      name: 'drop phone from intake → should be name only',
      in: 'stop asking for phone',
      model: modelTurn(
        { informationToCollect: ['name'] },
        {
          message: 'Ready for review.',
          ownerEdits: [{ field: 'informationToCollect', item: 'phone', action: 'remove' }],
        }
      ),
      expect: {
        ...saveCardExpect({
          reply: undefined,
          includes: [CHANGED_ACK, MENU_HEAD, "*I'll ask customers for:* name"],
          excludes: [LEGACY_CARD],
        }),
        live: { informationToCollect: ['name'] },
        draft: { informationToCollect: ['name'] },
      },
    },
  ]);
});

await test('no-change summary turn keeps otherFacts and shows the menu', async () => {
  const fact = 'We only work on cars';
  await playApprovedFlow(
    [
      {
        name: 'show me the updated summary → menu, otherFacts kept',
        in: 'show me the updated summary',
        model: modelTurn({}, { message: 'Here is the latest.', newFacts: [], factEdits: [] }),
        expect: {
          event: 'build_turn',
          approvedAt: APPROVED_AT,
          nav: 'menu',
          includes: ['Here is the latest.', '1. 🚀 Get me working for your business'],
          excludes: [CHANGED_ACK],
          live: { otherFacts: [fact] },
          draft: { otherFacts: [fact] },
        },
      },
    ],
    { profile: approvedProfile({ otherFacts: [fact] }) }
  );
});

await test('each owner-editable field change produces a save card', async () => {
  const fact = 'We only work on cars';
  const unknown = 'Whether we do trucks';
  const cases = [
    {
      name: 'name',
      seed: {},
      in: 'rename to Ofir Motors',
      model: modelTurn({ name: 'Ofir Motors' }),
      includes: ['*Name:*'],
    },
    {
      name: 'whatWeDo',
      seed: {},
      in: 'we are a full service garage',
      model: modelTurn({ whatWeDo: 'Full service garage' }),
      includes: ['*What you do:*'],
    },
    {
      name: 'hours',
      seed: {},
      in: 'open 9 to 5',
      model: modelTurn({ hours: 'Mon–Fri 9–5' }),
      includes: ['*Hours:*'],
    },
    {
      name: 'locationOrArea',
      seed: {},
      in: 'we are in Tel Aviv',
      model: modelTurn({ locationOrArea: 'Tel Aviv' }),
      includes: ['*Location:*'],
    },
    {
      name: 'ownerGoal',
      seed: {},
      in: 'just answer questions',
      model: modelTurn({ ownerGoal: 'answer_questions' }),
      includes: ['*My goal:*'],
    },
    {
      name: 'tone',
      seed: {},
      in: 'talk professionally',
      model: modelTurn({ tone: 'professional' }),
      includes: ['*How I talk:*'],
    },
    {
      name: 'priceDisclosure',
      seed: {},
      in: 'only share prices when asked',
      model: modelTurn({ priceDisclosure: 'on_request' }),
      includes: ['*Price policy:*'],
    },
    {
      name: 'openingMessage',
      seed: {},
      in: 'use this opening',
      model: modelTurn({ openingMessage: OPENING }),
      includes: ['*How I talk:*'],
    },
    {
      name: 'services',
      seed: {},
      in: 'oil change is now 250',
      model: modelTurn({ services: [SERVICE_PRICE_EDIT] }),
      includes: ['*Services & prices:*'],
    },
    {
      name: 'commonQuestions',
      seed: {},
      in: 'also teach this FAQ',
      model: modelTurn({ commonQuestions: [NEW_FAQ] }),
      includes: ['*Q&A:*'],
    },
    {
      name: 'unanswered FAQ',
      seed: {},
      in: 'customers ask about towing',
      model: modelTurn({ commonQuestions: [{ question: 'Do you tow?', answer: '' }] }),
      includes: ['*Q&A:*'],
    },
    {
      name: 'informationToCollect add',
      seed: {},
      in: 'also ask for the car model',
      model: modelTurn({ informationToCollect: INTAKE_ADDED }),
      includes: ["*I'll ask customers for:*"],
    },
    {
      name: 'unknowns add',
      seed: {},
      in: 'not sure about trucks yet',
      model: modelTurn({ unknowns: [unknown] }),
      includes: ['*Not decided:*'],
    },
    {
      name: 'unknowns remove',
      seed: { unknowns: [unknown] },
      in: 'we do trucks',
      model: modelTurn({}, { resolvedUnknowns: [0] }),
      includes: ['*Not decided:*'],
    },
    {
      name: 'otherFacts add',
      seed: {},
      in: 'we only work on cars',
      model: modelTurn({}, { newFacts: [fact] }),
      includes: ['*Other facts:*'],
    },
    {
      name: 'otherFacts remove',
      seed: { otherFacts: [fact] },
      in: 'forget that car-only note',
      model: modelTurn({}, { factEdits: [{ index: 0, text: null }] }),
      includes: ['*Other facts:*'],
    },
  ];

  for (const c of cases) {
    await playApprovedFlow(
      [
        {
          name: `${c.name} → save card`,
          in: c.in,
          model: { ...c.model, message: 'Ready for review.' },
          expect: {
            ...saveCardExpect({
              reply: undefined,
              includes: [CHANGED_ACK, ...c.includes],
            }),
          },
        },
      ],
      { profile: approvedProfile(c.seed) }
    );
  }
});

await test('*menu* word and each section card, then back to the menu', async () => {
  const profile = approvedProfile();
  await playApprovedFlow([
    {
      name: '*menu* after the 🎉 card → editing menu',
      in: '*menu*',
      expect: {
        event: 'menu',
        mode: 'BUILD',
        reply: expectedMenu(true),
        approvedAt: APPROVED_AT,
        nav: 'menu',
        includes: [
          MENU_HEAD,
          '1. 🚀 Get me working for your business',
          '2. 🏪 Tell me more about your business',
          '3. ❓ Teach me more questions and answers',
          '4. 💬 Tell me how to talk to your customers',
          '5. 🤖 Chat with me like a customer',
        ],
        excludes: [LEGACY_CARD],
      },
    },
    {
      name: '2 → Business info section card',
      in: '2',
      expect: {
        event: 'menu_section',
        reply: renderSection(1, profile),
        nav: 'section:1',
        startsWith: SECTION_INTROS[1],
        includes: [
          '*Name:*',
          '*What you do:*',
          '*Services & prices:*',
          '*Hours:*',
          '*Location:*',
          '*Price policy:*',
          SECTION_ASK,
          MENU_HINT,
        ],
        excludes: [LEGACY_CARD],
      },
    },
    {
      name: '*menu* from Business info → menu header',
      in: '*menu*',
      expect: {
        event: 'menu',
        reply: expectedMenu(true),
        nav: 'menu',
        includes: [MENU_HEAD],
      },
    },
    {
      name: '3 → Q&A section card',
      in: '3',
      expect: {
        event: 'menu_section',
        reply: renderSection(2, profile),
        nav: 'section:2',
        startsWith: SECTION_INTROS[2],
        includes: [`*${FAQ_ITEM.question}*`, FAQ_ITEM.answer, SECTION_ASK, MENU_HINT],
        excludes: [LEGACY_CARD],
      },
    },
    {
      name: 'menu word from Q&A → menu',
      in: 'menu',
      expect: {
        event: 'menu',
        reply: expectedMenu(true),
        nav: 'menu',
        includes: [MENU_HEAD],
      },
    },
    {
      name: '4 → How I talk section card',
      in: '4',
      expect: {
        event: 'menu_section',
        reply: renderSection(3, profile),
        nav: 'section:3',
        startsWith: SECTION_INTROS[3],
        includes: ['*Style:*', '*Opening message:*', SECTION_ASK, MENU_HINT],
        excludes: [LEGACY_CARD, 'Price policy'],
      },
    },
    {
      name: 'back to menu from How I talk',
      in: '*menu*',
      expect: {
        event: 'menu',
        reply: expectedMenu(true),
        nav: 'menu',
        includes: [MENU_HEAD],
      },
    },
  ]);
});

await test('a number with no active card is not a menu pick', async () => {
  await playApprovedFlow(
    [
      {
        name: 'bare 2 with no menu/review nav → Builder, not Business info',
        in: '2',
        model: modelTurn(
          {},
          {
            message: 'Two lifts on site ✨',
            asksQuestion: false,
            readyForReview: false,
          }
        ),
        expect: {
          event: 'build_turn',
          mode: 'BUILD',
          approvedAt: APPROVED_AT,
          excludes: [SECTION_INTROS[1], SECTION_ASK, LEGACY_CARD],
        },
      },
    ],
    {
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Got it, thanks!' },
      ],
    }
  );
});

// After ready, no-change turns attach the menu. A bare 1 is a chrome pick
// (lead), not Try my bot from a stale review card.
await test(
  'stale review card after several Builder turns does not capture bare 1',
  async () => {
    await playApprovedFlow([
      {
        name: 'builder question 1 attaches menu',
        in: 'how many bays do we list?',
        model: modelTurn({}, { message: 'How many bays should I mention?' }),
        expect: { event: 'build_turn', approvedAt: APPROVED_AT, nav: 'menu' },
      },
      {
        name: 'builder question 2 keeps menu',
        in: 'two',
        model: modelTurn({}, { message: 'And which one is the main bay?' }),
        expect: { event: 'build_turn', approvedAt: APPROVED_AT, nav: 'menu' },
      },
      {
        name: 'builder question 3 keeps menu',
        in: 'the front one',
        model: modelTurn({}, { message: 'Anything else about the bays?' }),
        expect: { event: 'build_turn', approvedAt: APPROVED_AT, nav: 'menu' },
      },
      {
        name: 'bare 1 after those turns is the lead item, not Try my bot',
        in: '1',
        expect: {
          event: 'lead_question',
          mode: 'BUILD',
          approvedAt: APPROVED_AT,
          excludes: ['*Test mode is on*'],
        },
      },
    ]);
  }
);

// A later reply without nav clears the 🎉 card. A bare "1" is Builder text,
// not Try my bot.
await test(
  'stale review after no-nav acks does not capture bare 1 (lastShownNav)',
  async () => {
    const seeded = approvedProfile();
    await playApprovedFlow(
      [
        {
          name: 'bare 1 after no-nav acks is not Try my bot',
          in: '1',
          model: modelTurn({}, { message: 'One bay is enough ✨', asksQuestion: false }),
          expect: {
            event: 'build_turn',
            mode: 'BUILD',
            approvedAt: APPROVED_AT,
            nav: 'menu',
            excludes: ['*Test mode is on*'],
          },
        },
      ],
      {
        history: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: renderSetupComplete(seeded), nav: 'review' },
          { role: 'user', content: 'still a garage' },
          { role: 'assistant', content: 'Still Ofir garage ✨' },
          { role: 'user', content: 'same as before' },
          { role: 'assistant', content: 'Noted ✨' },
          { role: 'user', content: 'nothing new' },
          { role: 'assistant', content: 'All good ✨' },
        ],
      }
    );
  }
);

await test('no-change Builder turn after approval shows the menu, not a legacy card', async () => {
  await playApprovedFlow([
    {
      name: 'ok after 🎉 card, model restates, no draft change → model text plus menu',
      in: 'ok',
      model: modelTurn({}, { message: 'Here is your bot again.' }),
      expect: {
        event: 'build_turn',
        mode: 'BUILD',
        approvedAt: APPROVED_AT,
        nav: 'menu',
        includes: ['Here is your bot again.', '1. 🚀 Get me working for your business'],
        excludes: [LEGACY_CARD, 'Business info:', 'How I talk: default'],
      },
    },
  ]);
});

await test('Try my bot from the menu, then stop, then menu header', async () => {
  await playApprovedFlow([
    keepTeaching(),
    {
      name: '5 from menu → TEST',
      in: '5',
      expect: {
        event: 'enter_test',
        mode: 'TEST',
        reply: enterTestBanner(NAME),
        replies: ({ profile }) => [enterTestBanner(NAME), customerOpeningText(profile)],
        approvedAt: APPROVED_AT,
      },
    },
    {
      name: 'customer reply (stubbed Business Bot)',
      in: CUSTOMER_Q,
      customer: CUSTOMER_A,
      expect: {
        event: 'test_turn',
        mode: 'TEST',
        reply: CUSTOMER_A,
        approvedAt: APPROVED_AT,
      },
    },
    {
      name: 'stop → exit banner + menu header',
      in: 'stop',
      expect: {
        event: 'enter_build',
        mode: 'BUILD',
        reply: exitTestBanner(),
        replies: [exitTestBanner(), expectedMenu(true)],
        approvedAt: APPROVED_AT,
        nav: 'menu',
        excludes: [LEGACY_CARD],
      },
    },
  ]);
});

await test('lead form from the menu, then menu header', async () => {
  await playApprovedFlow([
    keepTeaching(),
    {
      name: '1 from menu → lead intro + consent',
      in: '1',
      expect: {
        event: 'lead_question',
        mode: 'BUILD',
        reply: [
          LEAD_INTRO,
          '',
          'Can we contact you on this number to follow up and help you get started? 📞',
          '1. ✅ Yes, sure',
          '2. ❌ No, thanks',
        ].join('\n'),
        approvedAt: APPROVED_AT,
        includes: [LEAD_INTRO],
      },
    },
    {
      name: 'consent yes → channels',
      in: '1',
      expect: {
        event: 'lead_question',
        startsWith: LEAD_BRIDGE,
        includes: ['Where would you like me to work?'],
        approvedAt: APPROVED_AT,
      },
    },
    {
      name: 'channels WhatsApp → actions',
      in: '1',
      expect: {
        event: 'lead_question',
        includes: ['What would you like me to do beyond answering questions?'],
        approvedAt: APPROVED_AT,
      },
    },
    {
      name: 'actions book → daily inquiries',
      in: '1',
      expect: {
        event: 'lead_question',
        includes: ['About how many customer inquiries do you get per day?'],
        approvedAt: APPROVED_AT,
      },
    },
    {
      name: 'daily → chat tools',
      in: '1',
      expect: {
        event: 'lead_question',
        includes: ['Do you already use a tool to manage your customer chats?'],
        approvedAt: APPROVED_AT,
      },
    },
    {
      name: 'chat tools no → thanks (no menu yet)',
      in: '1',
      expect: {
        event: 'lead_saved',
        reply: LEAD_THANKS_YES,
        approvedAt: APPROVED_AT,
        excludes: [MENU_HEAD, LEGACY_CARD],
      },
    },
    {
      name: 'next BUILD turn after lead → menu header, no lead item',
      in: 'ok',
      expect: {
        event: 'menu',
        mode: 'BUILD',
        reply: expectedMenu(false),
        approvedAt: APPROVED_AT,
        nav: 'menu',
        includes: [MENU_HEAD, '1. 🏪 Tell me more about your business'],
        excludes: [LEGACY_CARD, '🚀 Get me working for your business'],
      },
    },
  ]);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
