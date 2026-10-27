/**
 * First-setup flow safety net (architecture audit §8 step 6).
 *
 * Pins current owner-visible behavior through the real handleMessage
 * entry point with a stubbed Builder and Business Bot (no network).
 * Agenda is identity → tell-me-more → complete (ready_first menu).
 *
 * Each flow is a data-driven table: owner input, stubbed model output, and
 * expected reply / key state (approvedAt, askedTopics, mode).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  customerOpeningText,
  emptyProfile,
  loadProfile,
  testProfilePath,
} from '../src/profile.js';
import { openingMessage } from '../src/builder.js';
import { composeReply } from '../src/composeReply.js';
import { IDENTITY_FALLBACK_QUESTION } from '../src/setupAgenda.js';
import {
  BUSINESS_DETAILS_ACK,
  BUSINESS_DETAILS_MARKER,
  businessDetailsQuestion,
} from '../src/builderTopics.js';
import {
  OWNER_NAME_QUESTION,
  READY_OPENER,
  businessDetailsAck,
  ownerMeetAck,
  readyOpener,
  returnedIntro,
} from '../src/copy.js';
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
} from '../src/ownerNav.js';

const PROFILE = testProfilePath('setup-flow');

const OWNER = 'Ofir';
const NAME = 'Ofir garage';
const WHAT = 'Garage';
const SERVICE = { name: 'Oil change', price: '200 ILS', notes: null };
const HOURS = 'Mon–Fri 8–18';
const HOURS_EDIT = 'Sun–Thu 9–17';
const AREA = 'Haifa';
const CUSTOMER_Q = 'How much is an oil change?';
const CUSTOMER_A = 'An oil change is 200 ILS.';

const CHANGED_ACK = "Here's what changed:";
const LEGACY_CARD = "Here's your bot";

const ACKS = [BUSINESS_DETAILS_ACK, CHANGED_ACK, READY_OPENER];

const SCRIPT_QUESTIONS = [{ id: 'tell-more', needle: BUSINESS_DETAILS_MARKER }];

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function draft(overrides = {}) {
  return {
    name: NAME,
    whatWeDo: WHAT,
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    otherFacts: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    ...overrides,
  };
}

function fullFacts(overrides = {}) {
  return draft({
    services: [SERVICE],
    hours: HOURS,
    locationOrArea: AREA,
    ...overrides,
  });
}

function modelTurn(nextDraft, overrides = {}) {
  return {
    message: `${NAME} is your garage ✨`,
    draft: nextDraft,
    readyForReview: false,
    wantsReview: false,
    asksQuestion: false,
    askingTopic: null,
    onPurpose: true,
    ...overrides,
  };
}

function askedTopicsOf(profile) {
  const listed = profile?.draft?.askedTopics;
  return Array.isArray(listed) ? listed : [];
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

/** One tell-me-more question per reply; the same ack only once. */
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
}

function expectedTellMore(forDraft = draft(), ownerName = OWNER) {
  return `${businessDetailsAck(ownerName)}\n\n${businessDetailsQuestion(forDraft)}`;
}

function expectedReadyFirst(leadOption = false, ownerName = OWNER) {
  return composeReply({
    kind: 'ready_first',
    menuOpts: { leadOption },
    ownerName,
  }).reply;
}

function expectedMenu(leadOption = false, ownerName = OWNER) {
  return renderChangeMenu({ leadOption }, ownerName);
}

function expectedBackMenu(leadOption = false, ownerName = OWNER) {
  return composeReply({
    kind: 'test_exit',
    menuOpts: { leadOption },
    ownerName,
    parts: { ready: true },
  }).replies[1];
}

function opening() {
  return openingMessage().message;
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
 * Drive one table through handleMessage. A step with `model` queues one
 * Builder stub; `customer` queues one Business Bot stub. Navigation / wake /
 * stop / test-entry steps omit both.
 */
async function playFlow(steps) {
  clean();
  const builderQ = [];
  const customerQ = [];
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async ({ userMessage }) => {
        if (!builderQ.length) {
          throw new Error(`unexpected Builder turn for ${JSON.stringify(userMessage)}`);
        }
        return { source: 'stub-builder', ...builderQ.shift() };
      },
      businessBotReply: async ({ question }) => {
        if (!customerQ.length) {
          throw new Error(`unexpected Business Bot turn for ${JSON.stringify(question)}`);
        }
        return customerQ.shift();
      },
    },
  });

  const seen = [];
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
    if (expect.event) assert.equal(out.event, expect.event, `${label}: event`);
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
    if (expect.askedTopics) {
      assert.deepEqual(askedTopicsOf(profile), expect.askedTopics, `${label}: askedTopics`);
    }
    if (expect.approvedAt === null) {
      assert.equal(profile.approvedAt, null, `${label}: approvedAt should be empty`);
    } else if (expect.approvedAt === true) {
      assert.ok(profile.approvedAt, `${label}: approvedAt should be set`);
    }
    if (expect.liveName !== undefined) {
      assert.equal(profile.name, expect.liveName, `${label}: live name`);
    }

    assertReplyShape(out.reply, label);
    if (Array.isArray(out.replies)) {
      for (const [i, part] of out.replies.entries()) assertReplyShape(part, `${label} replies[${i}]`);
    }

    seen.push({ name: label, event: out.event, mode: session.mode });
  }

  assert.equal(builderQ.length, 0, `unused Builder stubs: ${builderQ.length}`);
  assert.equal(customerQ.length, 0, `unused Business Bot stubs: ${customerQ.length}`);
  return { session, seen };
}

function resolveExpect(value, ctx) {
  if (typeof value === 'function') return value(ctx);
  return value;
}

function wake(text = 'hello') {
  return {
    name: 'wake discards owner text',
    in: text,
    expect: {
      event: 'opening',
      mode: 'BUILD',
      reply: opening(),
      approvedAt: null,
      askedTopics: [],
      liveName: null,
    },
  };
}

function sayName(name = OWNER) {
  return {
    name: 'owner name → Nice to meet you + identity',
    in: name,
    model: modelTurn(
      {
        name: null,
        whatWeDo: null,
        services: [],
        hours: null,
        locationOrArea: null,
        commonQuestions: [],
        informationToCollect: null,
        unknowns: [],
        otherFacts: [],
        tone: null,
        priceDisclosure: null,
        openingMessage: null,
      },
      { message: 'Hi!', ownerName: name }
    ),
    expect: {
      event: 'build_turn',
      mode: 'BUILD',
      reply: `${ownerMeetAck(name)}\n\n${IDENTITY_FALLBACK_QUESTION}`,
      approvedAt: null,
      askedTopics: [],
      liveName: null,
    },
  };
}

function nameWhatTellMore() {
  return {
    name: 'name+what → Nice thanks tell-more with the two-line copy',
    in: `${NAME}, a ${WHAT.toLowerCase()}`,
    model: modelTurn(draft(), {
      message: "Ofir Garage is your garage ✨ What's next?",
      asksQuestion: true,
    }),
    expect: {
      event: 'build_turn',
      mode: 'BUILD',
      reply: expectedTellMore(draft()),
      askedTopics: ['businessDetails'],
      approvedAt: null,
      includes: [
        `Tell me a bit more about ${NAME} (services and prices, opening hours, location, or anything else you'd like me to know).`,
        'Or say "skip" for now.',
      ],
      excludes: ["What's next?", '🛠️', 'For example:'],
    },
  };
}

function tellMoreThenReady(nextDraft = fullFacts(), inbound = 'Oil change 200 ILS, Mon–Fri 8–18, Haifa') {
  return {
    name: 'tell-more answer → ready_first menu without lead',
    in: inbound,
    model: modelTurn(nextDraft, {
      message: 'Noted the hours, services, and location ✨',
    }),
    expect: {
      event: 'build_turn',
      reply: expectedReadyFirst(false),
      askedTopics: ['businessDetails'],
      approvedAt: true,
      nav: 'menu',
      startsWith: readyOpener(OWNER),
      includes: ['2. 🏪 Tell me more about your business', '4. 📝 Choose details to collect from customers'],
      excludes: [LEGACY_CARD, '🚀 Get me working for your business', BUSINESS_DETAILS_MARKER],
    },
  };
}

function skipTellMoreThenReady() {
  return {
    name: 'skip tell-more → ready_first menu without lead',
    in: 'skip',
    model: modelTurn(draft({ askedTopics: ['businessDetails'] }), {
      message: `${NAME} is your garage ✨`,
      readyForReview: true,
      topicResponse: 'skipped',
    }),
    expect: {
      event: 'build_turn',
      reply: expectedReadyFirst(false),
      askedTopics: ['businessDetails'],
      approvedAt: true,
      nav: 'menu',
      startsWith: readyOpener(OWNER),
      excludes: [LEGACY_CARD, BUSINESS_DETAILS_MARKER, '🚀 Get me working for your business'],
    },
  };
}

function editHours(nextDraft) {
  return {
    name: "edit hours → Here's what changed + main menu",
    in: `hours are now ${HOURS_EDIT}`,
    model: modelTurn(nextDraft, {
      message: 'Ready for review.',
      readyForReview: true,
      asksQuestion: false,
    }),
    expect: {
      event: 'build_turn',
      reply: ({ before, profile }) => renderSavedChanges(before, profile, { leadOption: false }),
      startsWith: CHANGED_ACK,
      approvedAt: true,
      nav: 'menu',
      includes: [`*Hours:* ${HOURS_EDIT}`],
      excludes: ['Ready for review.', LEGACY_CARD],
    },
  };
}

function tryMyBot() {
  return {
    name: '1 from ready menu → TEST banners',
    in: '1',
    expect: {
      event: 'enter_test',
      mode: 'TEST',
      reply: enterTestBanner(NAME),
      replies: ({ profile }) => [enterTestBanner(NAME), customerOpeningText(profile)],
      approvedAt: true,
    },
  };
}

function customerReply() {
  return {
    name: 'customer reply (stubbed Business Bot)',
    in: CUSTOMER_Q,
    customer: CUSTOMER_A,
    expect: {
      event: 'test_turn',
      mode: 'TEST',
      reply: CUSTOMER_A,
      approvedAt: true,
    },
  };
}

function stopToMenu() {
  return {
    name: 'stop → exit banner + menu with lead',
    in: 'stop',
    expect: {
      event: 'enter_build',
      mode: 'BUILD',
      reply: exitTestBanner(),
      replies: [exitTestBanner(), expectedBackMenu(true)],
      approvedAt: true,
      nav: 'menu',
      excludes: [LEGACY_CARD],
    },
  };
}

await test('happy path: wake → tell-more → hours → ready_first → edit → TEST → stop', async () => {
  await playFlow([
    wake('hello'),
    sayName(),
    nameWhatTellMore(),
    tellMoreThenReady(),
    editHours(fullFacts({ hours: HOURS_EDIT, askedTopics: ['businessDetails'] })),
    tryMyBot(),
    customerReply(),
    stopToMenu(),
  ]);
});

await test('everything in the first interview message skips tell-more', async () => {
  await playFlow([
    wake(),
    {
      name: 'full dump → ready_first, no tell-more',
      in: 'Ofir garage, a garage. Oil change 200 ILS, Mon–Fri 8–18 in Haifa.',
      model: modelTurn(fullFacts(), {
        message: 'Got it, thanks!',
        readyForReview: true,
        ownerName: OWNER,
      }),
      expect: {
        event: 'build_turn',
        reply: expectedReadyFirst(false),
        askedTopics: [],
        approvedAt: true,
        nav: 'menu',
        startsWith: readyOpener(OWNER),
        excludes: [BUSINESS_DETAILS_MARKER, BUSINESS_DETAILS_ACK, LEGACY_CARD],
      },
    },
  ]);
});

await test('partial tell-more answer still presents ready', async () => {
  await playFlow([
    wake(),
    sayName(),
    nameWhatTellMore(),
    {
      name: 'hours only → ready_first, do not re-ask tell-more',
      in: 'we are open weekdays 8 to 6',
      model: modelTurn(draft({ hours: HOURS, askedTopics: ['businessDetails'] }), {
        message: 'Noted the hours.',
        readyForReview: true,
      }),
      expect: {
        event: 'build_turn',
        reply: expectedReadyFirst(false),
        askedTopics: ['businessDetails'],
        approvedAt: true,
        nav: 'menu',
        startsWith: readyOpener(OWNER),
        excludes: [BUSINESS_DETAILS_MARKER, LEGACY_CARD],
      },
    },
  ]);
});

await test('skip tell-more presents ready_first', async () => {
  await playFlow([
    wake(),
    sayName(),
    nameWhatTellMore(),
    skipTellMoreThenReady(),
  ]);
});

await test('model asks its own question, no wrap-up flags, still reaches ready', async () => {
  await playFlow([
    wake(),
    {
      name: 'full dump + model question → ready_first',
      in: 'Ofir garage, a garage. Oil change 200 ILS, Mon–Fri 8–18 in Haifa.',
      model: modelTurn(fullFacts(), {
        message: 'What details should I ask customers for?',
        asksQuestion: true,
        readyForReview: false,
        wantsReview: false,
        askingTopic: null,
        ownerName: OWNER,
      }),
      expect: {
        event: 'build_turn',
        reply: expectedReadyFirst(false),
        askedTopics: [],
        approvedAt: true,
        nav: 'menu',
        startsWith: readyOpener(OWNER),
        excludes: ['What details should I ask customers for?', BUSINESS_DETAILS_MARKER],
      },
    },
  ]);
});

await test('"ok" after ready_first is the menu, not a leftover card', async () => {
  await playFlow([
    wake(),
    {
      name: 'full dump → ready_first',
      in: 'Ofir garage, a garage. Oil change 200 ILS, Mon–Fri 8–18 in Haifa.',
      model: modelTurn(fullFacts(), { message: 'Got it, thanks!', ownerName: OWNER }),
      expect: {
        reply: expectedReadyFirst(false),
        askedTopics: [],
        approvedAt: true,
        nav: 'menu',
      },
    },
    {
      name: 'ok after ready → model text plus editing menu',
      in: 'ok',
      model: modelTurn(fullFacts(), {
        message: 'Here is your bot again.',
      }),
      expect: {
        event: 'build_turn',
        mode: 'BUILD',
        approvedAt: true,
        nav: 'menu',
        includes: ['Here is your bot again.', '2. 🏪 Tell me more about your business'],
        excludes: [LEGACY_CARD, 'Business info:', 'How I talk: default', '🚀 Get me working for your business'],
      },
    },
  ]);
});

await test('no "?" during setup still advances (before name, and after tell-more)', async () => {
  await playFlow([
    wake(),
    {
      name: 'unclear first reply stays on owner name',
      in: 'what?',
      model: modelTurn(
        {
          name: null,
          whatWeDo: null,
          services: [],
          hours: null,
          locationOrArea: null,
          commonQuestions: [],
          informationToCollect: null,
        },
        {
          message: 'I meant what to call you.',
          asksQuestion: false,
          topicResponse: 'unclear',
        }
      ),
      expect: {
        event: 'build_turn',
        reply: `I meant what to call you.\n\n${OWNER_NAME_QUESTION}`,
        askedTopics: [],
        approvedAt: null,
        excludes: [BUSINESS_DETAILS_MARKER],
      },
    },
  ]);

  await playFlow([
    wake(),
    sayName(),
    {
      name: 'no-? ack after name attaches identity fallback',
      in: 'a small coffee shop with pastries',
      model: modelTurn(
        {
          name: null,
          whatWeDo: 'A small coffee shop with pastries',
          services: [],
          hours: null,
          locationOrArea: null,
          commonQuestions: [],
          informationToCollect: null,
        },
        {
          message: 'A cozy coffee shop with pastries sounds lovely ✨',
          asksQuestion: false,
        }
      ),
      expect: {
        event: 'build_turn',
        reply: `A cozy coffee shop with pastries sounds lovely ✨\n\n${IDENTITY_FALLBACK_QUESTION}`,
        askedTopics: [],
        approvedAt: null,
        excludes: [BUSINESS_DETAILS_MARKER],
      },
    },
  ]);

  await playFlow([
    wake(),
    sayName(),
    nameWhatTellMore(),
    {
      name: 'no-? ack after tell-more skip → ready_first',
      in: 'skip',
      model: modelTurn(draft({ askedTopics: ['businessDetails'] }), {
        message: `${NAME} repairs cars ✨`,
        asksQuestion: false,
        readyForReview: false,
        wantsReview: false,
        topicResponse: 'skipped',
      }),
      expect: {
        event: 'build_turn',
        reply: expectedReadyFirst(false),
        askedTopics: ['businessDetails'],
        approvedAt: true,
        nav: 'menu',
        startsWith: readyOpener(OWNER),
      },
    },
  ]);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
