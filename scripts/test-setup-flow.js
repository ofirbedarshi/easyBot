/**
 * First-setup flow safety net (architecture audit §8 step 6).
 *
 * Pins current origin/main (#47) owner-visible behavior through the real
 * handleMessage entry point with a stubbed Builder and Business Bot (no
 * network). Later refactor PRs should keep these tables green.
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
import { openingMessage, OWNER_GOAL_QUESTION } from '../src/builder.js';
import { IDENTITY_FALLBACK_QUESTION } from '../src/setupAgenda.js';
import {
  BUSINESS_DETAILS_ACK,
  BUSINESS_DETAILS_MARKER,
  businessDetailsQuestion,
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
  renderSetupComplete,
} from '../src/ownerNav.js';

const PROFILE = testProfilePath('setup-flow');
const FAQ = topicByKey('commonQuestions');
const INTAKE = topicByKey('informationToCollect');
const MODEL_INTAKE_Q = 'What details should I ask customers for?';

const NAME = 'Ofir garage';
const WHAT = 'Garage';
const SERVICE = { name: 'Oil change', price: '200 ILS', notes: null };
const HOURS = 'Mon–Fri 8–18';
const HOURS_EDIT = 'Sun–Thu 9–17';
const AREA = 'Haifa';
const FAQ_ITEM = {
  question: 'Do you work on trucks?',
  answer: 'Yes, light trucks too.',
};
const INTAKE_ITEMS = ['name', 'phone'];
const CUSTOMER_Q = 'How much is an oil change?';
const CUSTOMER_A = 'An oil change is 200 ILS.';

const SETUP_COMPLETE_HEAD = "🎉 I'm all set! This is what I know about your business:";
const CHANGED_ACK = "Here's what changed:";
const LEGACY_CARD = "Here's your bot";

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
    ownerGoal: null,
    ownerGoalRequested: null,
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

function readyFacts(overrides = {}) {
  return fullFacts({
    ownerGoal: 'answer_and_collect',
    ownerGoalRequested: 'answer questions and take customer details',
    commonQuestions: [FAQ_ITEM],
    informationToCollect: INTAKE_ITEMS,
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

/** One required-topic / goal question per reply; the same ack only once. */
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

function expectedTellMore(forDraft = draft()) {
  return `${BUSINESS_DETAILS_ACK}\n\n${businessDetailsQuestion(forDraft)}`;
}

function expectedFaq() {
  return `${FAQ.ack}\n\n${FAQ.question}`;
}

function expectedIntake() {
  return `${INTAKE.ack}\n\n${INTAKE.question}`;
}

function expectedMenu() {
  return renderChangeMenu({ leadOption: true });
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

function nameWhatTellMore() {
  return {
    name: 'name+what → Nice! tell-more with only missing bullets',
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
        '🛠️ What services do you offer, and how much do they cost?',
        '🕒 What are your opening hours?',
        '📍 Where are you located?',
      ],
      excludes: ["What's next?"],
    },
  };
}

function tellMoreAnswerThenGoal(nextDraft = fullFacts()) {
  return {
    name: 'tell-more answer → scripted goal question',
    in: 'Oil change 200 ILS, Mon–Fri 8–18, Haifa',
    model: modelTurn(nextDraft, {
      message: 'Noted the hours, services, and location ✨',
    }),
    expect: {
      event: 'build_turn',
      reply: `Noted the hours, services, and location ✨\n\n${OWNER_GOAL_QUESTION}`,
      askedTopics: ['businessDetails'],
      approvedAt: null,
      excludes: [FAQ.question, INTAKE.question, BUSINESS_DETAILS_MARKER],
    },
  };
}

function goalThenFaq(nextDraft) {
  return {
    name: 'goal answer → scripted FAQ',
    in: 'answer questions and take customer details',
    model: modelTurn(nextDraft, {
      message: 'Answering questions and collecting details will help ✨',
    }),
    expect: {
      event: 'build_turn',
      reply: expectedFaq(),
      askedTopics: ['businessDetails', 'commonQuestions'],
      approvedAt: null,
      excludes: [INTAKE.question, OWNER_GOAL_QUESTION],
    },
  };
}

function faqThenIntake(nextDraft) {
  return {
    name: 'FAQ answer → scripted intake',
    in: 'Customers ask if we work on trucks. Yes, light trucks too.',
    model: modelTurn(nextDraft, {
      message: 'Got those answers ✨',
    }),
    expect: {
      event: 'build_turn',
      reply: expectedIntake(),
      askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
      approvedAt: null,
      excludes: [FAQ.question, OWNER_GOAL_QUESTION],
    },
  };
}

function intakeThenCard(nextDraft, askedTopics) {
  return {
    name: 'intake answer → setup-complete card',
    in: 'name and phone',
    model: modelTurn(nextDraft, {
      message: `${NAME} repairs cars ✨`,
      asksQuestion: false,
    }),
    expect: {
      event: 'build_turn',
      mode: 'BUILD',
      reply: ({ profile }) => renderSetupComplete(profile),
      startsWith: SETUP_COMPLETE_HEAD,
      approvedAt: true,
      askedTopics,
      nav: 'review',
      excludes: [LEGACY_CARD, 'How I talk: default'],
    },
  };
}

function keepTeaching() {
  return {
    name: 'keep teaching → editing menu',
    in: 'keep teaching me',
    expect: {
      event: 'menu',
      mode: 'BUILD',
      reply: expectedMenu(),
      approvedAt: true,
      nav: 'menu',
      excludes: [LEGACY_CARD],
    },
  };
}

function editHours(nextDraft) {
  return {
    name: 'edit hours → single Here\'s what changed + save card',
    in: `hours are now ${HOURS_EDIT}`,
    model: modelTurn(nextDraft, {
      message: 'Ready for review.',
      readyForReview: true,
      asksQuestion: false,
    }),
    expect: {
      event: 'build_turn',
      reply: ({ before, profile }) => renderSavedChanges(before, profile),
      startsWith: CHANGED_ACK,
      approvedAt: true,
      nav: 'review',
      includes: [`*Hours:* ${HOURS_EDIT}`],
      excludes: ['Ready for review.', LEGACY_CARD],
    },
  };
}

function tryMyBot() {
  return {
    name: 'Try my bot → TEST banners',
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
    name: 'stop → exit banner + menu',
    in: 'stop',
    expect: {
      event: 'enter_build',
      mode: 'BUILD',
      reply: exitTestBanner(),
      replies: [exitTestBanner(), expectedMenu()],
      approvedAt: true,
      nav: 'menu',
      excludes: [LEGACY_CARD],
    },
  };
}

await test('happy path: wake → tell-more → goal → FAQ → intake → card → edit → TEST → stop', async () => {
  await playFlow([
    wake('hello'),
    nameWhatTellMore(),
    tellMoreAnswerThenGoal(),
    goalThenFaq(fullFacts({
      ownerGoal: 'answer_and_collect',
      ownerGoalRequested: 'answer questions and take customer details',
    })),
    faqThenIntake(fullFacts({
      ownerGoal: 'answer_and_collect',
      ownerGoalRequested: 'answer questions and take customer details',
      commonQuestions: [FAQ_ITEM],
    })),
    intakeThenCard(readyFacts(), [
      'businessDetails',
      'commonQuestions',
      'informationToCollect',
    ]),
    keepTeaching(),
    editHours(readyFacts({ hours: HOURS_EDIT })),
    tryMyBot(),
    customerReply(),
    stopToMenu(),
  ]);
});

await test('everything in the first interview message skips tell-more', async () => {
  await playFlow([
    wake(),
    {
      name: 'full dump → goal, no tell-more',
      in: 'Ofir garage, a garage. Oil change 200 ILS, Mon–Fri 8–18 in Haifa.',
      model: modelTurn(fullFacts(), {
        message: 'Got it, thanks!',
        readyForReview: true,
      }),
      expect: {
        event: 'build_turn',
        reply: `Got it, thanks!\n\n${OWNER_GOAL_QUESTION}`,
        askedTopics: [],
        approvedAt: null,
        excludes: [BUSINESS_DETAILS_MARKER, BUSINESS_DETAILS_ACK, FAQ.question],
      },
    },
  ]);
});

await test('partial tell-more answer still advances to the goal', async () => {
  await playFlow([
    wake(),
    nameWhatTellMore(),
    {
      name: 'hours only → goal, do not re-ask tell-more',
      in: 'we are open weekdays 8 to 6',
      model: modelTurn(draft({ hours: HOURS }), {
        message: 'Noted the hours.',
        readyForReview: true,
      }),
      expect: {
        event: 'build_turn',
        reply: `Noted the hours.\n\n${OWNER_GOAL_QUESTION}`,
        askedTopics: ['businessDetails'],
        approvedAt: null,
        excludes: [BUSINESS_DETAILS_MARKER, FAQ.question, INTAKE.question],
      },
    },
  ]);
});

await test('skip tell-more and skip FAQ still reach the card', async () => {
  await playFlow([
    wake(),
    nameWhatTellMore(),
    {
      name: 'skip tell-more → goal',
      in: 'skip',
      model: modelTurn(draft({ askedTopics: ['businessDetails'] }), {
        message: `${NAME} is your garage ✨`,
        readyForReview: true,
      }),
      expect: {
        event: 'build_turn',
        reply: `${NAME} is your garage ✨\n\n${OWNER_GOAL_QUESTION}`,
        askedTopics: ['businessDetails'],
        approvedAt: null,
        excludes: [FAQ.question, INTAKE.question, BUSINESS_DETAILS_MARKER],
      },
    },
    {
      name: 'goal after skip → FAQ',
      in: 'just answer questions',
      model: modelTurn(
        draft({
          ownerGoal: 'answer_questions',
          ownerGoalRequested: 'just answer questions',
        }),
        { message: 'Answering questions it is ✨' }
      ),
      expect: {
        event: 'build_turn',
        reply: expectedFaq(),
        askedTopics: ['businessDetails', 'commonQuestions'],
        approvedAt: null,
      },
    },
    {
      name: 'skip FAQ → intake (no stall)',
      in: 'skip',
      model: modelTurn(
        draft({
          ownerGoal: 'answer_questions',
          ownerGoalRequested: 'just answer questions',
        }),
        {
          message: `${NAME} is your garage ✨`,
          asksQuestion: true,
          readyForReview: false,
          wantsReview: false,
        }
      ),
      expect: {
        event: 'build_turn',
        reply: expectedIntake(),
        askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
        approvedAt: null,
        excludes: [FAQ.question],
      },
    },
    {
      name: 'intake none → setup-complete card',
      in: 'none',
      model: modelTurn(
        draft({
          ownerGoal: 'answer_questions',
          ownerGoalRequested: 'just answer questions',
          informationToCollect: [],
        }),
        { message: `${NAME} is your garage ✨`, asksQuestion: false }
      ),
      expect: {
        event: 'build_turn',
        reply: ({ profile }) => renderSetupComplete(profile),
        startsWith: SETUP_COMPLETE_HEAD,
        approvedAt: true,
        askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
        nav: 'review',
      },
    },
  ]);
});

await test('#47 dead-end: model asks its own question, no wrap-up flags, still reaches the card', async () => {
  await playFlow([
    wake(),
    {
      name: 'full dump → goal',
      in: 'Ofir garage, a garage. Oil change 200 ILS, Mon–Fri 8–18 in Haifa.',
      model: modelTurn(fullFacts(), { message: 'Got it, thanks!' }),
      expect: {
        event: 'build_turn',
        reply: `Got it, thanks!\n\n${OWNER_GOAL_QUESTION}`,
        askedTopics: [],
        approvedAt: null,
      },
    },
    {
      name: 'goal + model intake question / no wrap-up flags → FAQ',
      in: 'answer questions and take customer details',
      model: modelTurn(
        fullFacts({
          ownerGoal: 'answer_and_collect',
          ownerGoalRequested: 'answer questions and take customer details',
        }),
        {
          message: MODEL_INTAKE_Q,
          asksQuestion: true,
          readyForReview: false,
          wantsReview: false,
          askingTopic: null,
        }
      ),
      expect: {
        event: 'build_turn',
        reply: expectedFaq(),
        askedTopics: ['commonQuestions'],
        approvedAt: null,
        excludes: [MODEL_INTAKE_Q, INTAKE.question],
      },
    },
    {
      name: 'skip FAQ → intake',
      in: 'skip',
      model: modelTurn(
        fullFacts({
          ownerGoal: 'answer_and_collect',
          ownerGoalRequested: 'answer questions and take customer details',
        }),
        {
          message: MODEL_INTAKE_Q,
          asksQuestion: true,
          readyForReview: false,
          wantsReview: false,
        }
      ),
      expect: {
        event: 'build_turn',
        reply: expectedIntake(),
        askedTopics: ['commonQuestions', 'informationToCollect'],
        approvedAt: null,
        excludes: [MODEL_INTAKE_Q, FAQ.question],
      },
    },
    intakeThenCard(
      readyFacts(),
      ['commonQuestions', 'informationToCollect']
    ),
  ]);
});

await test('"ok" after the setup-complete card is the menu, not the leftover card', async () => {
  await playFlow([
    wake(),
    {
      name: 'full dump → goal',
      in: 'Ofir garage, a garage. Oil change 200 ILS, Mon–Fri 8–18 in Haifa.',
      model: modelTurn(fullFacts(), { message: 'Got it, thanks!' }),
      expect: {
        reply: `Got it, thanks!\n\n${OWNER_GOAL_QUESTION}`,
        askedTopics: [],
      },
    },
    {
      name: 'goal → FAQ',
      in: 'answer questions and take details',
      model: modelTurn(
        fullFacts({
          ownerGoal: 'answer_and_collect',
          ownerGoalRequested: 'answer questions and take details',
        })
      ),
      expect: { reply: expectedFaq(), askedTopics: ['commonQuestions'] },
    },
    {
      name: 'FAQ → intake',
      in: 'Customers ask if we work on trucks. Yes, light trucks too.',
      model: modelTurn(
        fullFacts({
          ownerGoal: 'answer_and_collect',
          ownerGoalRequested: 'answer questions and take details',
          commonQuestions: [FAQ_ITEM],
        })
      ),
      expect: {
        reply: expectedIntake(),
        askedTopics: ['commonQuestions', 'informationToCollect'],
      },
    },
    intakeThenCard(readyFacts({ ownerGoalRequested: 'answer questions and take details' }), [
      'commonQuestions',
      'informationToCollect',
    ]),
    {
      name: 'ok after card → model text plus editing menu',
      in: 'ok',
      model: modelTurn(readyFacts({ ownerGoalRequested: 'answer questions and take details' }), {
        message: 'Here is your bot again.',
      }),
      expect: {
        event: 'build_turn',
        mode: 'BUILD',
        approvedAt: true,
        nav: 'menu',
        includes: ['Here is your bot again.', '1. 🚀 Get me working for your business'],
        excludes: [LEGACY_CARD, 'Business info:', 'How I talk: default'],
      },
    },
  ]);
});

await test('no "?" during setup still advances (before name, and after the goal)', async () => {
  await playFlow([
    wake(),
    {
      name: 'no-? ack before name attaches identity fallback, not FAQ',
      in: 'a small coffee shop with pastries',
      model: modelTurn(
        {
          name: null,
          whatWeDo: 'A small coffee shop with pastries',
          ownerGoal: null,
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
        excludes: [FAQ.question, INTAKE.question, OWNER_GOAL_QUESTION, BUSINESS_DETAILS_MARKER],
      },
    },
  ]);

  await playFlow([
    wake(),
    {
      name: 'full dump → goal',
      in: 'Ofir garage, a garage. Oil change 200 ILS, Mon–Fri 8–18 in Haifa.',
      model: modelTurn(fullFacts(), { message: 'Got it, thanks!' }),
      expect: { reply: `Got it, thanks!\n\n${OWNER_GOAL_QUESTION}` },
    },
    {
      name: 'no-? ack after goal → FAQ (no stall)',
      in: 'answer questions and take customer details',
      model: modelTurn(
        fullFacts({
          ownerGoal: 'answer_and_collect',
          ownerGoalRequested: 'answer questions and take customer details',
        }),
        {
          message: `${NAME} repairs cars ✨`,
          asksQuestion: false,
          readyForReview: false,
          wantsReview: false,
        }
      ),
      expect: {
        event: 'build_turn',
        reply: expectedFaq(),
        askedTopics: ['commonQuestions'],
        approvedAt: null,
        excludes: [INTAKE.question],
      },
    },
    {
      name: 'no-? ack after FAQ → intake',
      in: 'skip',
      model: modelTurn(
        fullFacts({
          ownerGoal: 'answer_and_collect',
          ownerGoalRequested: 'answer questions and take customer details',
        }),
        {
          message: `${NAME} repairs cars ✨`,
          asksQuestion: false,
          readyForReview: false,
          wantsReview: false,
        }
      ),
      expect: {
        reply: expectedIntake(),
        askedTopics: ['commonQuestions', 'informationToCollect'],
        approvedAt: null,
      },
    },
    {
      name: 'no-? ack after intake settled → card',
      in: 'none',
      model: modelTurn(
        fullFacts({
          ownerGoal: 'answer_and_collect',
          ownerGoalRequested: 'answer questions and take customer details',
          informationToCollect: [],
        }),
        {
          message: `${NAME} repairs cars ✨`,
          asksQuestion: false,
          readyForReview: false,
          wantsReview: false,
        }
      ),
      expect: {
        reply: ({ profile }) => renderSetupComplete(profile),
        startsWith: SETUP_COMPLETE_HEAD,
        approvedAt: true,
        nav: 'review',
      },
    },
  ]);
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
