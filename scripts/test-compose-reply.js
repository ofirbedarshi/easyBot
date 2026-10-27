/**
 * Exact-equality goldens for every composeReply kind.
 * Expected strings are built from copy.js + the documented join rules,
 * not by calling composeReply twice.
 */
import assert from 'assert';
import { composeReply, reviewAck, withSingleQuestion } from '../src/composeReply.js';
import {
  BOT_ERROR_REPLY,
  BUILDER_ERROR_PREFIX,
  BUSINESS_DETAILS_ACK,
  FAQ_ACK,
  FAQ_QUESTION,
  GENERIC_ERROR_REPLY,
  IDENTITY_FALLBACK_QUESTION,
  INTAKE_ACK,
  INTAKE_QUESTION,
  LEAD_ALREADY_SENT,
  LEAD_BRIDGE,
  LEAD_INTRO,
  LEAD_INVALID,
  LEAD_INVALID_MULTI,
  LEAD_MENU_LABEL,
  LEAD_STEPS,
  LEAD_THANKS_NO,
  LEAD_THANKS_YES,
  NAV,
  OFF_PURPOSE_OWNER_REPLY,
  OPENING_MESSAGE,
  OWNER_GOAL_QUESTION,
  PARSE_FALLBACK_MESSAGE,
  RESET_REPLY,
  REVIEW,
  SETUP_COMPLETE_INTRO,
  TEST_REFUSE,
  defaultCustomerOpeningText,
  enterTestBannerText,
  exitTestBannerText,
} from '../src/copy.js';
import { topicByKey, topicQuestion } from '../src/builderTopics.js';
import {
  defaultCustomerOpening,
  customerOpeningText,
  PRICE_POLICY_OWNER_LABELS,
} from '../src/profile.js';
import {
  renderChangeMenu,
  renderMenu,
  renderReview,
  renderReviewOptions,
  renderReturnToEditing,
  renderSavedChanges,
  renderSection,
  renderSetupComplete,
  renderSetupContinue,
} from '../src/ownerNav.js';

const NAME = 'Studio Yoga';

const salon = {
  name: NAME,
  whatWeDo: 'Private yoga lessons',
  services: [{ name: 'Private lesson', price: '$80 / 60 min', notes: null }],
  hours: 'Sun–Thu 8–20',
  locationOrArea: 'Tel Aviv',
  priceDisclosure: 'relevant',
  ownerGoal: 'answer_questions',
  informationToCollect: ['name', 'phone'],
  commonQuestions: [{ question: 'Do you have parking?', answer: 'Yes, on the street.' }],
  unknowns: [],
  otherFacts: [],
  tone: 'warm',
  openingMessage: null,
  approvedAt: '2026-01-01T00:00:00.000Z',
};

const empty = {
  name: null,
  whatWeDo: null,
  services: [],
  hours: null,
  locationOrArea: null,
  priceDisclosure: null,
  ownerGoal: null,
  informationToCollect: null,
  commonQuestions: [],
};

const menuLead = { leadOption: true };
const menuNoLead = { leadOption: false };

function menuText(opts) {
  const items = [...(opts.leadOption ? ['lead'] : []), 1, 2, 3, 'try'];
  const label = (item) =>
    item === 'lead' ? `🚀 ${LEAD_MENU_LABEL}` : item === 'try' ? NAV.menu[3] : NAV.menu[item - 1];
  return [...items.map((item, i) => `${i + 1}. ${label(item)}`), '', NAV.menuFooter].join('\n');
}

function reviewOptions() {
  return [
    REVIEW.optionsPrompt,
    ...REVIEW.options.map((label, i) => `${i + 1}. ${label}`),
    '',
    REVIEW.optionsFooter,
  ].join('\n');
}

function leadQuestion(id) {
  const q = LEAD_STEPS[id];
  return [q.text, ...q.options.map((label, i) => `${i + 1}. ${label}`)].join('\n');
}

function field(label, value) {
  return `*${label}:* ${value}`;
}

const results = [];

function test(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

test('opening', () => {
  const out = composeReply({ kind: 'opening' });
  assert.equal(out.reply, OPENING_MESSAGE);
  assert.equal(out.reply.split('\n\n').length, 5);
  assert.equal(out.nav, null);
});

test('ask_identity', () => {
  const model = 'A cozy coffee shop with pastries sounds lovely ✨';
  const out = composeReply({ kind: 'ask_identity', modelText: model });
  assert.equal(out.reply, `${model}\n\n${IDENTITY_FALLBACK_QUESTION}`);
  assert.equal(out.asksQuestion, true);
});

test('ask_topic tell-me-more', () => {
  const draft = { name: NAME, whatWeDo: 'Yoga', services: [], hours: null, locationOrArea: null };
  const topic = topicByKey('businessDetails');
  const out = composeReply({
    kind: 'ask_topic',
    modelText: 'ignored because ack is set',
    parts: { topic, ack: BUSINESS_DETAILS_ACK, draft },
  });
  assert.equal(out.reply, `${BUSINESS_DETAILS_ACK}\n\n${topicQuestion(topic, draft)}`);
  assert.equal(out.asksQuestion, true);
});

test('ask_topic faq and intake', () => {
  const faq = topicByKey('commonQuestions');
  const intake = topicByKey('informationToCollect');
  assert.equal(
    composeReply({
      kind: 'ask_topic',
      parts: { topic: faq, ack: FAQ_ACK, draft: {} },
    }).reply,
    `${FAQ_ACK}\n\n${FAQ_QUESTION}`
  );
  assert.equal(
    composeReply({
      kind: 'ask_topic',
      parts: { topic: intake, ack: INTAKE_ACK, draft: {} },
    }).reply,
    `${INTAKE_ACK}\n\n${INTAKE_QUESTION}`
  );
});

test('ask_goal', () => {
  const model = 'Got it, thanks!';
  const out = composeReply({ kind: 'ask_goal', modelText: model });
  assert.equal(out.reply, `${model}\n\n${OWNER_GOAL_QUESTION}`);
  assert.equal(out.asksQuestion, true);
});

test('setup_complete', () => {
  const expected = [
    SETUP_COMPLETE_INTRO,
    '',
    field(NAV.fields.name, NAME),
    field(NAV.fields.whatYouDo, salon.whatWeDo),
    `*${NAV.fields.services}:*`,
    'Private lesson — $80 / 60 min',
    field(NAV.fields.hours, salon.hours),
    field(NAV.fields.location, salon.locationOrArea),
    field(NAV.fields.pricePolicy, PRICE_POLICY_OWNER_LABELS.relevant),
    '',
    reviewOptions(),
  ].join('\n');
  const out = composeReply({ kind: 'setup_complete', profile: salon });
  assert.equal(out.reply, expected);
  assert.equal(out.reply, renderSetupComplete(salon));
  assert.equal(out.nav, 'review');
});

test('saved_changes card only and with ack', () => {
  const prior = { ...salon, hours: 'old hours' };
  const card = renderSavedChanges(prior, salon);
  assert.equal(
    composeReply({ kind: 'saved_changes', prior, profile: salon }).reply,
    card
  );
  const ack = 'Hours updated ✨';
  assert.equal(
    composeReply({
      kind: 'saved_changes',
      modelText: ack,
      prior,
      profile: salon,
    }).reply,
    `${ack}\n\n${card}`
  );
  assert.match(card, /^Here's what changed:\n\*Hours:\* Sun–Thu 8–20\n\n/);
});

test('saved_changes shows emptied otherFacts and unknowns with existing none label', () => {
  const prior = {
    ...salon,
    otherFacts: ['We only work on cars'],
    unknowns: ['Whether we do trucks'],
  };
  const next = { ...salon, otherFacts: [], unknowns: [] };
  const card = composeReply({ kind: 'saved_changes', prior, profile: next }).reply;
  assert.match(card, /\*Other facts:\* none/);
  assert.match(card, /\*Not decided:\* none/);
});

test('change_menu and menu', () => {
  assert.equal(
    composeReply({ kind: 'change_menu', menuOpts: menuLead }).reply,
    `${REVIEW.changeAsk}\n\n${menuText(menuLead)}`
  );
  assert.equal(
    composeReply({ kind: 'change_menu', menuOpts: menuLead }).reply,
    renderChangeMenu(menuLead)
  );
  assert.equal(composeReply({ kind: 'menu', menuOpts: menuNoLead }).reply, menuText(menuNoLead));
  assert.equal(composeReply({ kind: 'menu', menuOpts: menuNoLead }).reply, renderMenu(menuNoLead));
  assert.ok(menuText(menuLead).startsWith(`1. 🚀 ${LEAD_MENU_LABEL}\n`));
});

test('model_plus_menu and model_only', () => {
  const model = 'What else should I know?';
  assert.equal(
    composeReply({ kind: 'model_plus_menu', modelText: model, menuOpts: menuNoLead }).reply,
    `${model}\n\n${menuText(menuNoLead)}`
  );
  assert.equal(composeReply({ kind: 'model_only', modelText: model }).reply, model);
});

test('off_purpose reset test_refuse parse_fallback errors', () => {
  assert.equal(composeReply({ kind: 'off_purpose' }).reply, OFF_PURPOSE_OWNER_REPLY);
  assert.equal(composeReply({ kind: 'reset' }).reply, RESET_REPLY);
  assert.equal(composeReply({ kind: 'test_refuse' }).reply, TEST_REFUSE);
  assert.equal(composeReply({ kind: 'parse_fallback' }).reply, PARSE_FALLBACK_MESSAGE);
  assert.equal(composeReply({ kind: 'error_business' }).reply, BOT_ERROR_REPLY);
  assert.equal(
    composeReply({ kind: 'error_builder', parts: { errorMessage: 'boom' } }).reply,
    `${BUILDER_ERROR_PREFIX}boom`
  );
  assert.equal(composeReply({ kind: 'error_generic' }).reply, GENERIC_ERROR_REPLY);
});

test('test_enter and banners', () => {
  const banner = enterTestBannerText(NAME);
  const opening = customerOpeningText(salon);
  const out = composeReply({ kind: 'test_enter', profile: salon });
  assert.equal(out.reply, banner);
  assert.deepEqual(out.replies, [banner, opening]);
  assert.equal(opening, defaultCustomerOpening(salon));
  assert.equal(opening, defaultCustomerOpeningText(NAME));
});

test('test_exit and stop_build', () => {
  const banner = exitTestBannerText();
  const readyExit = composeReply({
    kind: 'test_exit',
    menuOpts: menuLead,
    parts: { ready: true },
  });
  assert.equal(readyExit.reply, banner);
  assert.deepEqual(readyExit.replies, [banner, `${REVIEW.changeAsk}\n\n${menuText(menuLead)}`]);

  const setupExit = composeReply({ kind: 'test_exit', parts: { ready: false } });
  assert.deepEqual(setupExit.replies, [banner, NAV.setupContinue]);

  assert.equal(
    composeReply({ kind: 'stop_build', menuOpts: menuLead, parts: { ready: true } }).reply,
    `${NAV.returned}\n\n${menuText(menuLead)}`
  );
  assert.equal(
    composeReply({ kind: 'stop_build', parts: { ready: false } }).reply,
    NAV.setupContinue
  );
  assert.equal(renderReturnToEditing(menuLead), `${NAV.returned}\n\n${menuText(menuLead)}`);
  assert.equal(renderSetupContinue(), NAV.setupContinue);
});

test('section', () => {
  const expected = [
    NAV.sectionIntros[0],
    '',
    field(NAV.fields.name, NAME),
    field(NAV.fields.whatYouDo, salon.whatWeDo),
    `*${NAV.fields.services}:*`,
    'Private lesson — $80 / 60 min',
    field(NAV.fields.hours, salon.hours),
    field(NAV.fields.location, salon.locationOrArea),
    field(NAV.fields.pricePolicy, PRICE_POLICY_OWNER_LABELS.relevant),
    '',
    NAV.ask,
    NAV.menuHint,
  ].join('\n');
  const out = composeReply({ kind: 'section', profile: salon, parts: { section: 1 } });
  assert.equal(out.reply, expected);
  assert.equal(out.reply, renderSection(1, salon));
  assert.equal(out.nav, 'section:1');
});

test('lead kinds', () => {
  assert.equal(
    composeReply({ kind: 'lead_start' }).reply,
    `${LEAD_INTRO}\n\n${leadQuestion('contactConsent')}`
  );
  assert.equal(
    composeReply({
      kind: 'lead_question',
      parts: { step: 'channels', intro: LEAD_BRIDGE },
    }).reply,
    `${LEAD_BRIDGE}\n\n${leadQuestion('channels')}`
  );
  assert.equal(
    composeReply({ kind: 'lead_invalid', parts: { step: 'contactConsent', multi: false } }).reply,
    `${LEAD_INVALID}\n\n${leadQuestion('contactConsent')}`
  );
  assert.equal(
    composeReply({ kind: 'lead_invalid', parts: { step: 'channels', multi: true } }).reply,
    `${LEAD_INVALID_MULTI}\n\n${leadQuestion('channels')}`
  );
  assert.equal(
    composeReply({
      kind: 'lead_followup',
      parts: { text: LEAD_STEPS.channels.followUp },
    }).reply,
    LEAD_STEPS.channels.followUp
  );
  assert.equal(
    composeReply({
      kind: 'lead_thanks',
      parts: { answers: { contactConsent: 'Yes, sure' } },
    }).reply,
    LEAD_THANKS_YES
  );
  assert.equal(
    composeReply({
      kind: 'lead_thanks',
      parts: { answers: { contactConsent: 'No, thanks' } },
    }).reply,
    LEAD_THANKS_NO
  );
  assert.equal(
    composeReply({ kind: 'lead_already_sent', menuOpts: menuNoLead }).reply,
    `${LEAD_ALREADY_SENT}\n\n${menuText(menuNoLead)}`
  );
  assert.equal(
    composeReply({ kind: 'lead_cancelled', menuOpts: menuNoLead }).reply,
    menuText(menuNoLead)
  );
});

test('customer_turn', () => {
  const model = 'We open at 8.';
  assert.equal(
    composeReply({ kind: 'customer_turn', modelText: model, profile: salon }).reply,
    model
  );
  assert.equal(
    composeReply({
      kind: 'customer_turn',
      modelText: model,
      profile: salon,
      parts: { prependOpening: true },
    }).reply,
    `${defaultCustomerOpeningText(NAME)}\n\n${model}`
  );
});

test('review leftover card', () => {
  const profile = { draft: salon };
  const expected = [
    `Here's your bot for ${NAME}:`,
    [
      `Name: ${NAME}`,
      `Business info: ${salon.whatWeDo}`,
      'Services: Private lesson — $80 / 60 min',
      `Area: ${salon.locationOrArea}`,
      `Hours: ${salon.hours}`,
      `Price policy: ${PRICE_POLICY_OWNER_LABELS.relevant}`,
      'My goal: Answer customer questions',
      "I'll ask customers for: name, phone",
      'Q&A: 1 answer',
      'How I talk: warm',
    ].join('\n'),
    reviewOptions(),
  ].join('\n\n');
  const out = composeReply({ kind: 'review', profile });
  assert.equal(out.reply, expected);
  assert.equal(out.reply, renderReview(profile));
});

test('review_options setup_continue return_to_editing', () => {
  assert.equal(composeReply({ kind: 'review_options' }).reply, reviewOptions());
  assert.equal(composeReply({ kind: 'review_options' }).reply, renderReviewOptions());
  assert.equal(composeReply({ kind: 'setup_continue' }).reply, NAV.setupContinue);
  assert.equal(
    composeReply({ kind: 'return_to_editing', menuOpts: menuLead }).reply,
    `${NAV.returned}\n\n${menuText(menuLead)}`
  );
});

test('empty profile cards use not-added copy', () => {
  const expected = [
    SETUP_COMPLETE_INTRO,
    '',
    field(NAV.fields.name, NAV.notAdded),
    field(NAV.fields.whatYouDo, NAV.notAdded),
    field(NAV.fields.services, NAV.notAdded),
    field(NAV.fields.hours, NAV.notAdded),
    field(NAV.fields.location, NAV.notAdded),
    field(NAV.fields.pricePolicy, PRICE_POLICY_OWNER_LABELS.relevant),
    '',
    reviewOptions(),
  ].join('\n');
  assert.equal(composeReply({ kind: 'setup_complete', profile: empty }).reply, expected);
});

test('withSingleQuestion and reviewAck stay byte-identical helpers', () => {
  assert.equal(withSingleQuestion('Nice! ✨', 'Q?'), 'Nice! ✨\n\nQ?');
  assert.equal(withSingleQuestion('Ack? more', 'Q?'), 'Q?');
  assert.equal(reviewAck('Looks good. Ready for review?'), 'Looks good.');
  assert.equal(reviewAck('1. skip me\nHere is a summary:'), '');
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
