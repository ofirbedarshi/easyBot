/**
 * Deterministic structure/boundary checks for buildCustomerSystemPrompt.
 */
import assert from 'assert';
import {
  buildCustomerSystemPrompt,
  intakeGoalEnabled,
} from '../src/customerPrompt.js';
import { PARAGRAPH_PROMPT_LINE } from '../src/formatReply.js';
import {
  DEFAULT_BEHAVIOR,
  customerOpeningText,
  defaultCustomerOpening,
  effectiveBehavior,
} from '../src/profile.js';

function sectionBetween(prompt, startMarker, endMarker) {
  const start = prompt.indexOf(startMarker);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const from = start + startMarker.length;
  const end = endMarker ? prompt.indexOf(endMarker, from) : prompt.length;
  assert.ok(end > from, `missing end marker after ${startMarker}`);
  return prompt.slice(from, end);
}

const VOICE_LINE =
  'Friendly receptionist texting a customer; speak as the business ("we"). Greet only once. Short lines, blank line between ideas, max one emoji (none when you can\'t help). If you don\'t know, say so; never redirect them to the business. End with a next step. Facts stay strict. Broad price/services: 3–4 categories with lowest from-price, then which service; never the full list. No ** markdown or headings. Don\'t repeat a given caveat; one short line.';

function testFactsGoStraightToSettings() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Maya Yoga',
    whatWeDo: 'Yoga lessons',
    services: [{ name: 'Private', price: '$70 for 60 minutes', notes: null }],
    hours: 'Weekday evenings',
    locationOrArea: 'Oak Street',
    commonQuestions: [],
    informationToCollect: [],
    unknowns: [],
    tone: 'warm',
  });

  assert.doesNotMatch(prompt, /=== BOT OBJECTIVE ===/);
  const facts = sectionBetween(
    prompt,
    '=== APPROVED BUSINESS FACTS ===',
    '=== SETTINGS (shape wording only; never a source of facts) ==='
  );
  const settings = sectionBetween(
    prompt,
    '=== SETTINGS (shape wording only; never a source of facts) ===',
    '=== RULES ==='
  );

  assert.ok(facts.includes('Maya Yoga'), 'business name in facts');
  assert.ok(facts.includes('$70 for 60 minutes'), 'service price in facts');
  assert.ok(!/Owner goal/i.test(facts), 'facts must not mention a bot goal');
  assert.ok(/Tone:/i.test(settings), 'settings follow facts immediately');
  assert.ok(
    /never a source of facts/i.test(settings) ||
      prompt.includes('=== SETTINGS (shape wording only; never a source of facts) ==='),
    'settings must warn they do not establish facts'
  );
}

function testFactsFaqUnknownsIntakeRendered() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Harbor Cafe',
    whatWeDo: 'Neighborhood cafe',
    services: [{ name: 'Latte', price: '$4', notes: null }],
    hours: 'Mon–Fri 8am–4pm',
    locationOrArea: 'Waterfront',
    commonQuestions: [
      { question: 'Do you have oat milk?', answer: 'Yes, oat milk is available.' },
    ],
    informationToCollect: ['name', 'preferred pickup time'],
    unknowns: ['Whether any student discounts exist'],
    tone: 'warm',
  });

  assert.ok(prompt.includes('Harbor Cafe'));
  assert.ok(prompt.includes('$4'));
  assert.ok(prompt.includes('Yes, oat milk is available.'));
  assert.ok(prompt.includes('Whether any student discounts exist'));
  assert.ok(prompt.includes('preferred pickup time'));
  assert.ok(
    /DETAILS YOU MAY ASK FOR \(only these\)/i.test(prompt),
    'intake list guidance present'
  );
  assert.ok(
    /messaging the owner/i.test(prompt),
    'owner redirect guidance present'
  );
  assert.match(
    prompt,
    /If something isn't listed, say it isn't available here, not that it's offered or not/
  );
  assert.match(
    prompt,
    /suggest messaging the owner only if a needed fact is missing/
  );
  assert.match(prompt, /consultation first\) is a full answer/);
  assert.doesNotMatch(prompt, /say you do not know/);
  assert.ok(/KNOWN GAPS \(never fill these in\)/i.test(prompt));
  assert.ok(prompt.includes(VOICE_LINE));
}

function testEmptyIntakeAnswerOnly() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Spark Clean',
    whatWeDo: 'Home cleaning',
    services: [{ name: 'Standard clean', price: '$120 per visit', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });

  assert.ok(
    /don't ask for any details/i.test(prompt),
    'empty intake must instruct collect nothing'
  );
  assert.doesNotMatch(prompt, /=== BOT OBJECTIVE ===/);
  assert.match(prompt, /ask if there's anything else they'd like to know/i);
  assert.ok(!intakeGoalEnabled({ informationToCollect: [] }));
  assert.ok(!intakeGoalEnabled({ informationToCollect: null }));
  assert.ok(!intakeGoalEnabled({}));
}

function testNoForcedBookingProcess() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Test Biz',
    whatWeDo: 'Services',
    services: [{ name: 'A', price: '$1', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });

  assert.ok(
    !/say the owner confirms bookings/i.test(prompt),
    'must not require inventing an owner-confirm process'
  );
  assert.ok(
    /Never claim you booked, paid, or contacted anyone/i.test(prompt),
    'must separate approved process facts from bot action claims'
  );
}

function testIntakeConfirmDoesNotRefuseKeepingDetails() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Test Biz',
    whatWeDo: 'Services',
    services: [{ name: 'A', price: '$1', notes: null }],
    informationToCollect: ['name', 'phone', 'preferred time'],
    unknowns: [],
  });
  assert.match(prompt, /thank them, confirm the details/i);
  assert.doesNotMatch(prompt, /this chat has no save\/send\/handoff/i);
  assert.doesNotMatch(prompt, /never imply collected information was saved/i);
  assert.doesNotMatch(
    prompt,
    /already gathered[\s\S]*message the owner/i
  );
  assert.match(
    prompt,
    /if they ask whether they are booked, say they are not/i
  );
  assert.match(prompt, /don't ask for details again/i);
  assert.ok(intakeGoalEnabled({
    informationToCollect: ['name', 'phone', 'preferred time'],
  }));
}

function testPricingProcessIsCompleteAnswer() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Test Biz',
    whatWeDo: 'Services',
    services: [{ name: 'A', price: '$1', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });
  assert.match(prompt, /A stated pricing process \(e.g. consultation first\) is a full answer/);
  assert.match(
    prompt,
    /suggest messaging the owner only if a needed fact is missing/
  );
  assert.doesNotMatch(
    prompt,
    /optional suggestion to message the owner for booking/i
  );
}

function testConversationSettingsSectionSeparated() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Quiet Mat Yoga',
    whatWeDo: 'In-person private yoga',
    services: [
      { name: 'Private lesson', price: '200 ILS for 60 minutes', notes: null },
    ],
    informationToCollect: [],
    unknowns: [],
    tone: 'professional and concise',
    priceDisclosure: 'on_request',
  });

  const facts = sectionBetween(
    prompt,
    '=== APPROVED BUSINESS FACTS ===',
    '=== SETTINGS (shape wording only; never a source of facts) ==='
  );
  const settings = sectionBetween(
    prompt,
    '=== SETTINGS (shape wording only; never a source of facts) ===',
    '=== RULES ==='
  );

  assert.ok(facts.includes('200 ILS'), 'price remains in facts');
  assert.ok(
    !/Tone:/i.test(facts),
    'facts must not contain Tone line'
  );
  assert.ok(
    !/on request/i.test(facts),
    'facts must not contain price disclosure policy'
  );
  assert.ok(/Tone: professional and concise/i.test(settings));
  assert.ok(!/Reply length:/i.test(settings));
  assert.ok(/Price disclosure: on request only/i.test(settings));
  assert.ok(
    prompt.includes('=== SETTINGS (shape wording only; never a source of facts) ==='),
    'settings must carry priority statement'
  );
}

function testOnRequestPolicyOnlyWhenSet() {
  const onReq = buildCustomerSystemPrompt({
    name: 'A',
    whatWeDo: 'B',
    services: [{ name: 'S', price: '10', notes: null }],
    informationToCollect: [],
    priceDisclosure: 'on_request',
  });
  const relevant = buildCustomerSystemPrompt({
    name: 'A',
    whatWeDo: 'B',
    services: [{ name: 'S', price: '10', notes: null }],
    informationToCollect: [],
    priceDisclosure: 'relevant',
  });

  assert.ok(/on request only/i.test(onReq));
  assert.ok(
    /even if a price is listed or was said earlier|I'd like to book/i.test(
      onReq
    ),
    'on_request must clarify non-pricing turns and prior prices do not unlock disclosure'
  );
  assert.ok(!/on request only/i.test(relevant));
  assert.ok(/Price disclosure: relevant/i.test(relevant));
}

function testNextStepFollowsIntake() {
  const facts = {
    name: 'Harbor Cuts',
    whatWeDo: 'Hair salon',
    services: [{ name: 'Cut', price: '$45', notes: null }],
    unknowns: [],
  };
  const collect = buildCustomerSystemPrompt({
    ...facts,
    informationToCollect: ['name', 'phone'],
  });
  const questions = buildCustomerSystemPrompt({
    ...facts,
    informationToCollect: [],
  });
  const unset = buildCustomerSystemPrompt({
    ...facts,
    informationToCollect: null,
  });

  assert.ok(intakeGoalEnabled({ informationToCollect: ['name', 'phone'] }));
  assert.ok(!intakeGoalEnabled({ informationToCollect: [] }));
  assert.ok(!intakeGoalEnabled({ informationToCollect: null }));
  assert.ok(intakeGoalEnabled({ informationToCollect: ['name'] }));

  assert.match(collect, /invite them to leave the listed details/i);
  assert.match(collect, /Interest or a booking request: ask for the missing listed items now/);
  assert.doesNotMatch(collect, /Don't ask for any details/);

  assert.match(questions, /ask if there's anything else they'd like to know/i);
  assert.match(questions, /Don't ask for any details/);
  assert.doesNotMatch(questions, /invite them to leave the listed details/i);

  assert.match(unset, /Don't ask for any details/);
  assert.doesNotMatch(unset, /invite them to leave the listed details/i);
}

function testOpeningNotInStandingPrompt() {
  const prompt = buildCustomerSystemPrompt({
    name: 'BurgerBarber',
    whatWeDo: 'Men’s barbershop',
    services: [{ name: 'Men’s haircut', price: '100 shekel', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });
  assert.doesNotMatch(prompt, /Use the opening ONLY/);
  assert.doesNotMatch(prompt, /Approved opening \(use this wording\)/);
  assert.doesNotMatch(prompt, /may end without a next step/);
  assert.ok(prompt.includes(VOICE_LINE));
}

function testDefaultOpeningText() {
  assert.equal(
    defaultCustomerOpening({ name: 'BurgerBarber' }),
    "Hi! I'm Adam, BurgerBarber's digital assistant 😊\n\nHow can I help you? ✨"
  );
  assert.equal(
    defaultCustomerOpening({}),
    "Hi! I'm Adam, this business's digital assistant 😊\n\nHow can I help you? ✨"
  );
  assert.equal(
    customerOpeningText({
      name: 'BurgerBarber',
    }),
    "Hi! I'm Adam, BurgerBarber's digital assistant 😊\n\nHow can I help you? ✨"
  );
  assert.equal(
    customerOpeningText({
      name: 'BurgerBarber',
      openingMessage: 'Welcome to the shop!',
    }),
    'Welcome to the shop!'
  );
  assert.equal(DEFAULT_BEHAVIOR.tone, 'warm, friendly, and human');
}

function testLegacyDefaultsInPrompt() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Legacy Biz',
    whatWeDo: 'Stuff',
    services: [{ name: 'S', price: '1', notes: null }],
    informationToCollect: [],
    unknowns: [],
    tone: 'warm and calm',
    // no priceDisclosure
  });
  const settings = sectionBetween(
    prompt,
    '=== SETTINGS (shape wording only; never a source of facts) ===',
    '=== RULES ==='
  );
  const eff = effectiveBehavior({
    tone: 'warm and calm',
    priceDisclosure: null,
  });
  assert.equal(eff.priceDisclosure, DEFAULT_BEHAVIOR.priceDisclosure);
  assert.ok(settings.includes('warm and calm'));
  assert.ok(!/Reply length:/i.test(settings));
  assert.ok(/Price disclosure: relevant/i.test(settings));
  assert.match(prompt, /You are Adam, Legacy Biz's digital assistant/);
  assert.doesNotMatch(settings, /Assistant name:/);
  assert.ok(!/^Tone:/m.test(prompt.split('===')[0]), 'no top-level Tone line');
}

function testStayOnBusinessRule() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Harbor Cafe',
    whatWeDo: 'Neighborhood cafe',
    services: [{ name: 'Latte', price: '$4', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });
  assert.match(prompt, /Stay on this business\./);
  assert.match(prompt, /poems, homework, coding/);
  assert.match(prompt, /one short warm steer back/);
  assert.doesNotMatch(prompt, /happy to help with anything/i);
  assert.doesNotMatch(prompt, /Keep replies concise and helpful/);
  assert.ok(
    prompt.includes(PARAGRAPH_PROMPT_LINE),
    'Business Bot prompt includes the one-line paragraph instruction'
  );
}

function testNoOldPromptHeadings() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Harbor Cafe',
    whatWeDo: 'Neighborhood cafe',
    services: [{ name: 'Latte', price: '$4', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });
  assert.doesNotMatch(prompt, /=== CONVERSATION SETTINGS ===/);
  assert.doesNotMatch(prompt, /=== BEHAVIOR RULES ===/);
  assert.doesNotMatch(prompt, /CLOSED-WORLD CONTRACT/);
  assert.doesNotMatch(prompt, /Never ask whether "the bot\/chatbot should collect"/);
}

function main() {
  testFactsGoStraightToSettings();
  testFactsFaqUnknownsIntakeRendered();
  testEmptyIntakeAnswerOnly();
  testNoForcedBookingProcess();
  testIntakeConfirmDoesNotRefuseKeepingDetails();
  testPricingProcessIsCompleteAnswer();
  testConversationSettingsSectionSeparated();
  testOnRequestPolicyOnlyWhenSet();
  testNextStepFollowsIntake();
  testOpeningNotInStandingPrompt();
  testDefaultOpeningText();
  testLegacyDefaultsInPrompt();
  testStayOnBusinessRule();
  testNoOldPromptHeadings();
  console.log('test-customer-prompt: all passed');
}

main();
