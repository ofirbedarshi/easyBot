/**
 * One handleMessage walk of the owner journey (architecture audit step 6).
 * Stubbed Builder / Business Bot, no network. Asserts every outgoing reply
 * exactly. Does not send /reset (developer-only).
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
import { applyBuilderModelOutput, applyReviewGate, openingMessage } from '../src/builder.js';
import {
  BUSINESS_DETAILS_ACK,
  businessDetailsQuestion,
  topicByKey,
} from '../src/builderTopics.js';
import { composeReply } from '../src/composeReply.js';
import { LEAD_BRIDGE, LEAD_THANKS_YES } from '../src/copy.js';
import {
  createSession,
  enterTestBanner,
  exitTestBanner,
  handleMessage,
} from '../src/session.js';
import {
  lastShownNav,
  renderChangeMenu,
  renderSection,
  renderSetupComplete,
} from '../src/ownerNav.js';
import { ownerPhase } from '../src/ownerPhase.js';

const PROFILE = testProfilePath('owner-journey');
const FAQ = topicByKey('commonQuestions');
const INTAKE = topicByKey('informationToCollect');

const NAME = 'Ofir garage';
const WHAT = 'Garage';
const HOURS = 'Mon–Fri 8–18';
const SERVICE = { name: 'Oil change', price: '200 ILS', notes: null };
const SERVICE_EDIT = { name: 'Oil change', price: '250 ILS', notes: null };
const NEW_SERVICE = { name: 'Brake pads', price: '350 ILS', notes: null };
const FAQ_ITEM = {
  question: 'Do you work on trucks?',
  answer: 'Yes, light trucks too.',
};
const FAQ_EDIT = {
  question: 'Do you work on trucks?',
  answer: 'Yes, all truck sizes.',
};
const CUSTOMER_Q = 'How much is an oil change?';
const CUSTOMER_A = 'An oil change is 250 ILS.';
const CUSTOMER_A2 = 'Still 250 ILS.';

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function modelTurn(delta = {}, overrides = {}) {
  return {
    message: `${NAME} is your garage ✨`,
    draft: delta,
    onPurpose: true,
    ownerEdits: [],
    ...overrides,
  };
}

function expectedMenu(leadOption) {
  return renderChangeMenu({ leadOption });
}

function resolveExpect(value, ctx) {
  if (typeof value === 'function') return value(ctx);
  return value;
}

async function playJourney(steps) {
  clean();
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
        const merged = applyBuilderModelOutput(parsed, profile.draft, { mode: 'delta' });
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

  for (const step of steps) {
    const label = step.name;
    if (step.model) builderQ.push(step.model);
    if (step.customer != null) customerQ.push(step.customer);
    const before = fs.existsSync(PROFILE) ? loadProfile(PROFILE) : emptyProfile();
    const out = await handleMessage(session, step.in);
    const profile = fs.existsSync(PROFILE) ? loadProfile(PROFILE) : emptyProfile();
    const ctx = { out, session, profile, before, reply: out.reply };
    const expect = step.expect || {};

    assert.equal(out.ok, true, `${label}: ok`);
    if (expect.event) {
      assert.equal(out.event, expect.event, `${label}: event got ${out.event}`);
    }
    if (expect.mode) assert.equal(session.mode, expect.mode, `${label}: mode`);
    if (expect.phase) {
      assert.equal(
        ownerPhase(session, profile),
        expect.phase,
        `${label}: phase got ${ownerPhase(session, profile)}`
      );
    }

    const reply = resolveExpect(expect.reply, ctx);
    if (reply !== undefined) {
      assert.equal(out.reply, reply, `${label}: reply\n${out.reply}`);
    }
    const replies = resolveExpect(expect.replies, ctx);
    if (replies !== undefined) {
      assert.deepEqual(out.replies, replies, `${label}: replies`);
    }
    if (expect.nav !== undefined) {
      assert.equal(lastShownNav(session.buildHistory), expect.nav, `${label}: nav`);
    }
    if (expect.approvedAt === null) {
      assert.equal(profile.approvedAt, null, `${label}: approvedAt should be empty`);
    } else if (expect.approvedAt === true) {
      assert.ok(profile.approvedAt, `${label}: approvedAt should be set`);
    }
    if (expect.live) {
      for (const [key, value] of Object.entries(expect.live)) {
        assert.deepEqual(profile[key], value, `${label}: live.${key}`);
      }
    }
    if (expect.draft) {
      for (const [key, value] of Object.entries(expect.draft)) {
        assert.deepEqual(profile.draft?.[key], value, `${label}: draft.${key}`);
      }
    }
  }

  assert.equal(builderQ.length, 0, `unused Builder stubs: ${builderQ.length}`);
  assert.equal(customerQ.length, 0, `unused Business Bot stubs: ${customerQ.length}`);
  return { session };
}

function saveCard(extra = {}) {
  return {
    event: 'build_turn',
    mode: 'BUILD',
    phase: 'ready',
    reply: ({ before, profile }) =>
      composeReply({
        kind: 'saved_changes',
        modelText: 'Noted ✨',
        prior: before,
        profile,
      }).reply,
    approvedAt: true,
    nav: 'review',
    ...extra,
  };
}

const identityDraft = { name: NAME };
const nameWhatDraft = { name: NAME, whatWeDo: WHAT };
const hoursDraft = { hours: HOURS };
const goalDraft = {
  ownerGoal: 'answer_and_collect',
  ownerGoalRequested: 'answer questions and take customer details',
};

try {
await playJourney([
  {
    name: 'wake discards the first message',
    in: 'hello, we are a garage',
    expect: {
      event: 'opening',
      mode: 'BUILD',
      phase: 'setup',
      reply: openingMessage().message,
      approvedAt: null,
      nav: null,
      live: { name: null },
    },
  },
  {
    name: 'identity: name only → fallback question',
    in: NAME,
    model: modelTurn(identityDraft, { message: 'Got the name ✨' }),
    expect: {
      event: 'build_turn',
      phase: 'setup',
      reply: composeReply({
        kind: 'ask_identity',
        modelText: 'Got the name ✨',
      }).reply,
      approvedAt: null,
      nav: null,
      live: { name: NAME, whatWeDo: null },
    },
  },
  {
    name: 'identity: what you do → tell-more (partial details still missing)',
    in: `it is a ${WHAT.toLowerCase()}`,
    model: modelTurn(nameWhatDraft, { message: 'Ofir garage is your garage ✨' }),
    expect: {
      event: 'build_turn',
      phase: 'setup',
      reply: `${BUSINESS_DETAILS_ACK}\n\n${businessDetailsQuestion({
        ...nameWhatDraft,
        services: [],
        hours: null,
        locationOrArea: null,
      })}`,
      approvedAt: null,
      nav: null,
      draft: { askedTopics: ['businessDetails'] },
    },
  },
  {
    name: 'tell-more partial (hours only) → goal',
    in: `we are open ${HOURS}`,
    model: modelTurn(hoursDraft, { message: 'Noted the hours ✨' }),
    expect: {
      event: 'build_turn',
      phase: 'setup',
      reply: composeReply({
        kind: 'ask_goal',
        modelText: 'Noted the hours ✨',
      }).reply,
      approvedAt: null,
      nav: null,
      live: { hours: HOURS },
    },
  },
  {
    name: 'goal answer → FAQ',
    in: 'answer questions and take customer details',
    model: modelTurn(goalDraft, { message: 'Answering and collecting ✨' }),
    expect: {
      event: 'build_turn',
      phase: 'wrapup',
      reply: `${FAQ.ack}\n\n${FAQ.question}`,
      approvedAt: null,
      nav: null,
      draft: { askedTopics: ['businessDetails', 'commonQuestions'] },
    },
  },
  {
    name: 'skip FAQ → intake',
    in: 'skip',
    model: modelTurn({}, { message: 'No questions yet ✨', topicResponse: 'skipped' }),
    expect: {
      event: 'build_turn',
      phase: 'wrapup',
      reply: `No questions yet ✨\n\n${INTAKE.question}`,
      approvedAt: null,
      nav: null,
      draft: {
        askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
      },
    },
  },
  {
    name: 'intake still null → ask again',
    in: 'not sure yet',
    model: modelTurn({}, { message: 'I can wait ✨' }),
    expect: {
      event: 'build_turn',
      phase: 'wrapup',
      reply: `I can wait ✨\n\n${INTAKE.question}`,
      approvedAt: null,
      nav: null,
      live: { informationToCollect: null },
    },
  },
  {
    name: 'intake none → setup-complete card',
    in: 'none',
    model: modelTurn({ informationToCollect: [] }, { message: 'All set ✨' }),
    expect: {
      event: 'build_turn',
      phase: 'ready',
      reply: ({ profile }) => renderSetupComplete(profile),
      approvedAt: true,
      nav: 'review',
      live: { informationToCollect: [] },
    },
  },
  {
    name: 'keep teaching → editing menu',
    in: 'keep teaching me',
    expect: {
      event: 'menu',
      mode: 'BUILD',
      phase: 'ready',
      reply: expectedMenu(true),
      nav: 'menu',
    },
  },
  {
    name: '2 → business section',
    in: '2',
    expect: {
      event: 'menu_section',
      reply: ({ profile }) => renderSection(1, profile),
      nav: 'section:1',
    },
  },
  {
    name: '*menu* from business section',
    in: '*menu*',
    expect: {
      event: 'menu',
      reply: expectedMenu(true),
      nav: 'menu',
    },
  },
  {
    name: '3 → Q&A section',
    in: '3',
    expect: {
      event: 'menu_section',
      reply: ({ profile }) => renderSection(2, profile),
      nav: 'section:2',
    },
  },
  {
    name: 'menu from Q&A section',
    in: 'menu',
    expect: {
      event: 'menu',
      reply: expectedMenu(true),
      nav: 'menu',
    },
  },
  {
    name: '4 → How I talk section',
    in: '4',
    expect: {
      event: 'menu_section',
      reply: ({ profile }) => renderSection(3, profile),
      nav: 'section:3',
    },
  },
  {
    name: '*menu* from How I talk',
    in: '*menu*',
    expect: {
      event: 'menu',
      reply: expectedMenu(true),
      nav: 'menu',
    },
  },
  {
    name: 'add Oil change',
    in: 'we also do oil changes for 200 ILS',
    model: modelTurn({ services: [SERVICE] }, { message: 'Noted ✨' }),
    expect: saveCard({
      live: { services: [SERVICE] },
      draft: { services: [SERVICE] },
    }),
  },
  {
    name: 'change Oil change price',
    in: 'oil change is now 250 ILS',
    model: modelTurn(
      { services: [SERVICE_EDIT] },
      {
        message: 'Noted ✨',
        ownerEdits: [{ field: 'services', item: 'Oil change', action: 'change' }],
      }
    ),
    expect: saveCard({
      live: { services: [SERVICE_EDIT] },
      draft: { services: [SERVICE_EDIT] },
    }),
  },
  {
    name: 'add Brake pads',
    in: 'also brake pads for 350 ILS',
    model: modelTurn({ services: [NEW_SERVICE] }, { message: 'Noted ✨' }),
    expect: saveCard({
      live: { services: [SERVICE_EDIT, NEW_SERVICE] },
      draft: { services: [SERVICE_EDIT, NEW_SERVICE] },
    }),
  },
  {
    name: 'remove Brake pads',
    in: 'stop offering brake pads',
    model: modelTurn(
      { services: [] },
      {
        message: 'Noted ✨',
        ownerEdits: [{ field: 'services', item: 'Brake pads', action: 'remove' }],
      }
    ),
    expect: saveCard({
      live: { services: [SERVICE_EDIT] },
      draft: { services: [SERVICE_EDIT] },
    }),
  },
  {
    name: 'add FAQ',
    in: 'customers ask if we work on trucks. yes, light trucks too',
    model: modelTurn({ commonQuestions: [FAQ_ITEM] }, { message: 'Noted ✨' }),
    expect: saveCard({
      live: { commonQuestions: [FAQ_ITEM] },
      draft: { commonQuestions: [FAQ_ITEM] },
    }),
  },
  {
    name: 'change FAQ answer',
    in: 'we work on all truck sizes',
    model: modelTurn(
      { commonQuestions: [FAQ_EDIT] },
      {
        message: 'Noted ✨',
        ownerEdits: [{ field: 'commonQuestions', item: FAQ_ITEM.question, action: 'change' }],
      }
    ),
    expect: saveCard({
      live: { commonQuestions: [FAQ_EDIT] },
      draft: { commonQuestions: [FAQ_EDIT] },
    }),
  },
  {
    name: 'remove FAQ',
    in: 'forget the truck question',
    model: modelTurn(
      { commonQuestions: [] },
      {
        message: 'Noted ✨',
        ownerEdits: [{ field: 'commonQuestions', item: FAQ_EDIT.question, action: 'remove' }],
      }
    ),
    expect: saveCard({
      live: { commonQuestions: [] },
      draft: { commonQuestions: [] },
    }),
  },
  {
    name: 'add intake name and phone',
    in: 'ask customers for name and phone',
    model: modelTurn({ informationToCollect: ['name', 'phone'] }, { message: 'Noted ✨' }),
    expect: saveCard({
      live: { informationToCollect: ['name', 'phone'] },
      draft: { informationToCollect: ['name', 'phone'] },
    }),
  },
  {
    name: 'change intake: also car model',
    in: 'also ask for the car model',
    model: modelTurn({ informationToCollect: ['name', 'phone', 'car model'] }, { message: 'Noted ✨' }),
    expect: saveCard({
      live: { informationToCollect: ['name', 'phone', 'car model'] },
      draft: { informationToCollect: ['name', 'phone', 'car model'] },
    }),
  },
  {
    name: 'remove intake phone',
    in: 'stop asking for phone',
    model: modelTurn(
      { informationToCollect: ['name', 'car model'] },
      {
        message: 'Noted ✨',
        ownerEdits: [{ field: 'informationToCollect', item: 'phone', action: 'remove' }],
      }
    ),
    expect: saveCard({
      live: { informationToCollect: ['name', 'car model'] },
      draft: { informationToCollect: ['name', 'car model'] },
    }),
  },
  {
    name: '*menu* after edits',
    in: '*menu*',
    expect: {
      event: 'menu',
      reply: expectedMenu(true),
      nav: 'menu',
    },
  },
  {
    name: '5 from menu → TEST',
    in: '5',
    expect: {
      event: 'enter_test',
      mode: 'TEST',
      phase: 'test',
      reply: enterTestBanner(NAME),
      replies: ({ profile }) => [enterTestBanner(NAME), customerOpeningText(profile)],
    },
  },
  {
    name: 'customer turn',
    in: CUSTOMER_Q,
    customer: CUSTOMER_A,
    expect: {
      event: 'test_turn',
      mode: 'TEST',
      phase: 'test',
      reply: CUSTOMER_A,
    },
  },
  {
    name: '*stop* → ready menu',
    in: '*stop*',
    expect: {
      event: 'enter_build',
      mode: 'BUILD',
      phase: 'ready',
      reply: exitTestBanner(),
      replies: [exitTestBanner(), expectedMenu(true)],
      nav: 'menu',
    },
  },
  {
    name: '1 from menu → lead start',
    in: '1',
    expect: {
      event: 'lead_question',
      phase: 'lead',
      reply: composeReply({ kind: 'lead_start' }).reply,
    },
  },
  {
    name: 'lead invalid input re-asks consent',
    in: 'xyz',
    expect: {
      event: 'lead_question',
      phase: 'lead',
      reply: composeReply({
        kind: 'lead_invalid',
        parts: { step: 'contactConsent', multi: false },
      }).reply,
    },
  },
  {
    name: 'lead consent yes → channels',
    in: '1',
    expect: {
      event: 'lead_question',
      phase: 'lead',
      reply: composeReply({
        kind: 'lead_question',
        parts: { step: 'channels', intro: LEAD_BRIDGE },
      }).reply,
    },
  },
  {
    name: 'lead channels → actions',
    in: '1',
    expect: {
      event: 'lead_question',
      phase: 'lead',
      reply: composeReply({ kind: 'lead_question', parts: { step: 'actions' } }).reply,
    },
  },
  {
    name: 'lead actions → daily inquiries',
    in: '1',
    expect: {
      event: 'lead_question',
      phase: 'lead',
      reply: composeReply({ kind: 'lead_question', parts: { step: 'dailyInquiries' } }).reply,
    },
  },
  {
    name: 'lead daily → chat tools',
    in: '1',
    expect: {
      event: 'lead_question',
      phase: 'lead',
      reply: composeReply({ kind: 'lead_question', parts: { step: 'chatTools' } }).reply,
    },
  },
  {
    name: 'lead complete → thanks, no menu',
    in: '1',
    expect: {
      event: 'lead_saved',
      phase: 'lead_resume',
      reply: LEAD_THANKS_YES,
    },
  },
  {
    name: 'next BUILD after lead → menu without lead item',
    in: 'ok',
    expect: {
      event: 'menu',
      mode: 'BUILD',
      phase: 'ready',
      reply: expectedMenu(false),
      nav: 'menu',
    },
  },
  {
    name: 'restart: 4 from no-lead menu → TEST',
    in: '4',
    expect: {
      event: 'enter_test',
      mode: 'TEST',
      phase: 'test',
      reply: enterTestBanner(NAME),
      replies: ({ profile }) => [enterTestBanner(NAME), customerOpeningText(profile)],
    },
  },
  {
    name: 'restart customer turn',
    in: CUSTOMER_Q,
    customer: CUSTOMER_A2,
    expect: {
      event: 'test_turn',
      mode: 'TEST',
      phase: 'test',
      reply: CUSTOMER_A2,
    },
  },
]);
  console.log('PASS owner-journey: wake → setup → wrapup → ready → test → lead → restart');

  const faqAskedDraft = {
    name: NAME,
    whatWeDo: WHAT,
    ownerGoal: 'answer_questions',
    commonQuestions: [],
    informationToCollect: null,
    askedTopics: ['businessDetails', 'commonQuestions'],
  };
  const faqQModel = "I mean questions like 'What kinds of furniture do you make?'";
  const faqQuestionInstead = applyReviewGate(
    { ...emptyProfile(), ...faqAskedDraft, draft: faqAskedDraft },
    { message: faqQModel, draft: faqAskedDraft, onPurpose: true, topicResponse: 'unclear' },
    'Like what?',
    { justAsked: FAQ }
  );
  assert.equal(faqQuestionInstead.message, `${faqQModel}\n\n${FAQ.question}`);
  assert.ok(!faqQuestionInstead.message.includes(FAQ.ack));
  assert.ok(!faqQuestionInstead.message.includes(INTAKE.ack));
  assert.ok(!/noted/i.test(faqQuestionInstead.message));
  console.log('PASS owner-journey: confused FAQ stays with model lead');

  const faqSkip = applyReviewGate(
    { ...emptyProfile(), ...faqAskedDraft, draft: faqAskedDraft },
    { message: 'No questions yet ✨', draft: faqAskedDraft, onPurpose: true, topicResponse: 'skipped' },
    'skip',
    { justAsked: FAQ }
  );
  assert.equal(faqSkip.message, `No questions yet ✨\n\n${INTAKE.question}`);
  console.log('PASS owner-journey: explicit FAQ skip still advances');

  const detailsAskedDraft = {
    name: NAME,
    whatWeDo: WHAT,
    ownerGoal: null,
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    askedTopics: ['businessDetails'],
  };
  const detailsConfused = applyReviewGate(
    { ...emptyProfile(), ...detailsAskedDraft, draft: detailsAskedDraft },
    {
      message: 'Hours, prices, or where you work — whatever you want me to know.',
      draft: detailsAskedDraft,
      onPurpose: true,
      topicResponse: 'unclear',
    },
    'What should I write here?',
    { justAsked: topicByKey('businessDetails') }
  );
  assert.ok(detailsConfused.message.includes(businessDetailsQuestion(detailsAskedDraft)));
  assert.ok(detailsConfused.message.startsWith('Hours, prices, or where you work'));
  assert.ok(!detailsConfused.message.includes(BUSINESS_DETAILS_ACK));
  console.log('PASS owner-journey: confused tell-more stays with model lead');

  const detailsSkip = applyReviewGate(
    { ...emptyProfile(), ...detailsAskedDraft, draft: detailsAskedDraft },
    {
      message: `${NAME} is your garage ✨`,
      draft: detailsAskedDraft,
      onPurpose: true,
      topicResponse: 'skipped',
    },
    'skip',
    { justAsked: topicByKey('businessDetails') }
  );
  assert.ok(detailsSkip.message.includes('Now tell me, how can I help you the most?'));
  assert.ok(!detailsSkip.message.includes('so I can answer your customers well'));
  console.log('PASS owner-journey: explicit tell-more skip still advances');
} catch (err) {
  console.error(`FAIL owner-journey: ${err.message}`);
  process.exit(1);
}
