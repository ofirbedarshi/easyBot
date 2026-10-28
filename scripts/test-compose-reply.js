/**
 * Exact-equality goldens for every composeReply kind.
 * Expected strings are built from copy.js + the documented join rules,
 * not by calling composeReply twice.
 */
import assert from 'assert';
import { changeLines, composeReply, reviewAck, withSingleQuestion } from '../src/composeReply.js';
import {
  BOT_ERROR_REPLY,
  BUILDER_ERROR_PREFIX,
  BUSINESS_DETAILS_ACK,
  businessDetailsAck,
  GENERIC_ERROR_REPLY,
  IDENTITY_FALLBACK_QUESTION,
  INTAKE_MENU_LABEL,
  CHATS_FOOTER,
  CHATS_MENU_LABEL,
  chatsEmptyLine,
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
  OWNER_NAME_QUESTION,
  PARSE_FALLBACK_MESSAGE,
  READY_OPENER,
  menuIntro,
  ownerMeetAck,
  readyOpener,
  returnedIntro,
  RESET_REPLY,
  REVIEW,
  TEST_REFUSE,
  defaultCustomerOpeningText,
  DEMO_START_OPTION,
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
  renderReadyFirst,
  renderReview,
  renderReturnToEditing,
  renderSavedChanges,
  renderSection,
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
  informationToCollect: null,
  commonQuestions: [],
};

const menuLead = { leadOption: true };
const menuNoLead = { leadOption: false };

function menuText(opts) {
  const items = [
    ...(opts.leadOption ? ['lead'] : []),
    'try',
    ...(opts.chatsOption ? ['chats'] : []),
    1,
    2,
    'intake',
    3,
  ];
  const label = (item) => {
    if (item === 'lead') return `🚀 ${LEAD_MENU_LABEL}`;
    if (item === 'try') return NAV.menu[3];
    if (item === 'chats') return `📋 ${CHATS_MENU_LABEL}`;
    if (item === 'intake') return INTAKE_MENU_LABEL;
    return NAV.menu[item - 1];
  };
  return [...items.map((item, i) => `${i + 1}. ${label(item)}`), '', NAV.menuFooter].join('\n');
}

function leadQuestion(id, businessName) {
  const q = LEAD_STEPS[id];
  const text = typeof q.text === 'function' ? q.text(businessName) : q.text;
  if (!q.options) return text;
  return [text, ...q.options.map((label, i) => `${i + 1}. ${label}`)].join('\n');
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
  assert.equal(out.reply.split('\n\n').length, 3);
  assert.ok(out.reply.endsWith(OWNER_NAME_QUESTION));
  assert.equal(out.nav, null);
});

test('ask_owner_name keepLead and fallback', () => {
  const model = 'I meant your first name — what should I call you?';
  const kept = composeReply({
    kind: 'ask_owner_name',
    modelText: model,
    parts: { keepLead: true },
  });
  assert.equal(kept.reply, `${model}\n\n${OWNER_NAME_QUESTION}`);
  assert.equal(kept.asksQuestion, true);
  const bare = composeReply({ kind: 'ask_owner_name' });
  assert.equal(bare.reply, OWNER_NAME_QUESTION);
});

test('ask_identity', () => {
  const model = 'A cozy coffee shop with pastries sounds lovely ✨';
  const out = composeReply({ kind: 'ask_identity', modelText: model });
  assert.equal(out.reply, `${model}\n\n${IDENTITY_FALLBACK_QUESTION}`);
  assert.equal(out.asksQuestion, true);
  const meet = composeReply({
    kind: 'ask_identity',
    parts: { ack: ownerMeetAck('Dana') },
  });
  assert.equal(
    meet.reply,
    `${ownerMeetAck('Dana')}\n\n${IDENTITY_FALLBACK_QUESTION}`
  );
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

test('ask_topic businessDetails without ack keeps model lead', () => {
  const draft = { name: NAME, whatWeDo: 'Yoga', services: [], hours: null, locationOrArea: null };
  const topic = topicByKey('businessDetails');
  const out = composeReply({
    kind: 'ask_topic',
    modelText: 'Happy to explain hours first. What else should I know?',
    parts: { topic, ack: null, draft },
  });
  assert.equal(out.reply, `Happy to explain hours first.\n\n${topicQuestion(topic, draft)}`);
  assert.ok(!out.reply.includes(BUSINESS_DETAILS_ACK));
});

test('ready_first opener plus menu without and with lead', () => {
  const without = composeReply({ kind: 'ready_first', menuOpts: menuNoLead });
  assert.equal(without.reply, `${READY_OPENER}\n\n${menuText(menuNoLead)}`);
  assert.equal(without.reply, renderReadyFirst(menuNoLead));
  assert.equal(without.nav, 'menu');
  assert.ok(menuText(menuNoLead).includes(`4. ${INTAKE_MENU_LABEL}`));
  assert.match(menuText(menuNoLead), /^1\. 🤖 Chat with me like a customer\n/);
  assert.match(menuText(menuNoLead), /\n2\. 🏪 Tell me more about your business\n/);

  const named = composeReply({
    kind: 'ready_first',
    menuOpts: menuNoLead,
    ownerName: 'Dana',
  });
  assert.equal(named.reply, `${readyOpener('Dana')}\n\n${menuText(menuNoLead)}`);

  const withLead = composeReply({ kind: 'ready_first', menuOpts: menuLead });
  assert.equal(withLead.reply, `${READY_OPENER}\n\n${menuText(menuLead)}`);
  assert.equal(withLead.reply, renderReadyFirst(menuLead));
  assert.equal(withLead.nav, 'menu');
  assert.ok(menuText(menuLead).startsWith(`1. 🚀 ${LEAD_MENU_LABEL}\n`));
  assert.ok(menuText(menuLead).includes(`5. ${INTAKE_MENU_LABEL}`));
  assert.match(menuText(menuLead), /\n2\. 🤖 Chat with me like a customer\n/);
});

test('saved_changes card plus menu, and with ack', () => {
  const prior = { ...salon, hours: 'old hours' };
  const cardAndMenu = renderSavedChanges(prior, salon, menuNoLead);
  assert.equal(
    composeReply({ kind: 'saved_changes', prior, profile: salon, menuOpts: menuNoLead }).reply,
    cardAndMenu
  );
  const ack = 'Hours updated ✨';
  assert.equal(
    composeReply({
      kind: 'saved_changes',
      modelText: ack,
      prior,
      profile: salon,
      menuOpts: menuNoLead,
    }).reply,
    `${ack}\n\n${cardAndMenu}`
  );
  assert.match(cardAndMenu, /^Here's what changed:\n\*Hours:\* Sun–Thu 8–20\n\n/);
  assert.ok(cardAndMenu.includes(menuText(menuNoLead)));
  const withAck = composeReply({
    kind: 'saved_changes',
    modelText: ack,
    prior,
    profile: salon,
    menuOpts: menuNoLead,
  });
  assert.equal(withAck.nav, 'menu');
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
    composeReply({ kind: 'change_menu', menuOpts: menuLead, ownerName: 'Dana' }).reply,
    `${menuIntro('Dana')}\n\n${menuText(menuLead)}`
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

test('demo_opening', () => {
  const withName = composeReply({
    kind: 'demo_opening',
    profile: salon,
    ownerName: 'Dana',
  });
  assert.equal(
    withName.reply,
    `Hi Dana, I'm Adam 👋\nI'm going to be the one talking with ${NAME}'s customers. I already learned about ${NAME} online.\nWant to try me out like one of your customers would? 🎉\n\n${DEMO_START_OPTION}`
  );
  assert.equal(withName.nav, 'demo_start');
  const noName = composeReply({ kind: 'demo_opening', profile: salon });
  assert.equal(
    noName.reply,
    `Hi, I'm Adam 👋\nI'm going to be the one talking with ${NAME}'s customers. I already learned about ${NAME} online.\nWant to try me out like one of your customers would? 🎉\n\n${DEMO_START_OPTION}`
  );
  assert.equal(noName.nav, 'demo_start');
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
  assert.deepEqual(readyExit.replies, [banner, `${NAV.returned}\n\n${menuText(menuLead)}`]);
  const namedExit = composeReply({
    kind: 'test_exit',
    menuOpts: menuLead,
    ownerName: 'Dana',
    parts: { ready: true },
  });
  assert.deepEqual(namedExit.replies, [
    banner,
    `${returnedIntro('Dana')}\n\n${menuText(menuLead)}`,
  ]);

  const setupExit = composeReply({ kind: 'test_exit', parts: { ready: false } });
  assert.deepEqual(setupExit.replies, [banner, NAV.setupContinue]);

  assert.equal(
    composeReply({ kind: 'stop_build', menuOpts: menuLead, parts: { ready: true } }).reply,
    `${NAV.returned}\n\n${menuText(menuLead)}`
  );
  assert.equal(
    composeReply({
      kind: 'stop_build',
      menuOpts: menuLead,
      ownerName: 'Dana',
      parts: { ready: true },
    }).reply,
    `${returnedIntro('Dana')}\n\n${menuText(menuLead)}`
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
      parts: { step: 'whatToDo', businessName: NAME },
    }).reply,
    LEAD_STEPS.whatToDo.text(NAME)
  );
  assert.ok(!composeReply({
    kind: 'lead_question',
    parts: { step: 'whatToDo', businessName: NAME },
  }).reply.includes('\n1. '));
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
      "I'll ask customers for: name, phone",
      'Q&A: 1 answer',
      'How I talk: warm',
    ].join('\n'),
  ].join('\n\n');
  const out = composeReply({ kind: 'review', profile });
  assert.equal(out.reply, expected);
  assert.equal(out.reply, renderReview(profile));
  assert.ok(!out.reply.includes('My goal'));
  assert.ok(!out.reply.includes('Keep teaching me'));
  assert.equal(out.nav, null);
});

test('setup_continue return_to_editing', () => {
  assert.equal(composeReply({ kind: 'setup_continue' }).reply, NAV.setupContinue);
  assert.equal(
    composeReply({ kind: 'return_to_editing', menuOpts: menuLead }).reply,
    `${NAV.returned}\n\n${menuText(menuLead)}`
  );
});

test('withSingleQuestion and reviewAck stay byte-identical helpers', () => {
  assert.equal(withSingleQuestion('Nice! ✨', 'Q?'), 'Nice! ✨\n\nQ?');
  assert.equal(withSingleQuestion('Ack? more', 'Q?'), 'Q?');
  assert.equal(reviewAck('Looks good. Ready for review?'), 'Looks good.');
  assert.equal(reviewAck('1. skip me\nHere is a summary:'), '');
});

const menuAfterTest = { leadOption: true, chatsOption: true };

test('chats_empty named and unnamed plus menu', () => {
  const unnamed = composeReply({ kind: 'chats_empty', menuOpts: menuAfterTest });
  assert.equal(
    unnamed.reply,
    `${chatsEmptyLine()}\n\n${REVIEW.changeAsk}\n\n${menuText(menuAfterTest)}`
  );
  assert.equal(unnamed.nav, 'menu');
  assert.ok(!unnamed.reply.includes(CHATS_FOOTER));
  const named = composeReply({
    kind: 'chats_empty',
    menuOpts: menuAfterTest,
    ownerName: 'Dana',
  });
  assert.equal(
    named.reply,
    `${chatsEmptyLine('Dana')}\n\n${menuIntro('Dana')}\n\n${menuText(menuAfterTest)}`
  );
  assert.ok(menuText(menuAfterTest).includes(`📋 ${CHATS_MENU_LABEL}`));
});

test('chats_report and chats_followup append footer only', () => {
  const report = composeReply({ kind: 'chats_report', modelText: 'I had 1 chat.' });
  assert.equal(report.reply, `I had 1 chat.\n\n${CHATS_FOOTER}`);
  assert.equal(report.nav, null);
  const follow = composeReply({ kind: 'chats_followup', modelText: 'He asked the price.' });
  assert.equal(follow.reply, `He asked the price.\n\n${CHATS_FOOTER}`);
});

test('chats_saved uses businessDetailsAck, change lines, footer, no menu', () => {
  const prior = {
    ...salon,
    services: [{ name: 'Private lesson', price: '$80', notes: null }],
  };
  const profile = {
    ...salon,
    services: [{ name: 'Private lesson', price: '$8', notes: null }],
  };
  const card = [REVIEW.changesIntro, ...changeLines(prior, profile)].join('\n');
  const named = composeReply({
    kind: 'chats_saved',
    prior,
    profile,
    ownerName: 'Dana',
  });
  assert.equal(named.reply, `${businessDetailsAck('Dana')}\n\n${card}\n\n${CHATS_FOOTER}`);
  assert.equal(named.nav, null);
  const unnamed = composeReply({ kind: 'chats_saved', prior, profile });
  assert.equal(unnamed.reply, `${BUSINESS_DETAILS_ACK}\n\n${card}\n\n${CHATS_FOOTER}`);
  assert.ok(!unnamed.reply.includes(REVIEW.changeAsk));
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
