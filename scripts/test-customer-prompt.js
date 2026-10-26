/**
 * Deterministic structure/boundary checks for buildCustomerSystemPrompt.
 */
import assert from 'assert';
import {
  buildCustomerSystemPrompt,
  intakeGoalEnabled,
} from '../src/customerPrompt.js';
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

function testOwnerGoalSeparatedFromFacts() {
  const goal =
    'Answer from the approved facts, then invite them to leave the listed details';
  const prompt = buildCustomerSystemPrompt({
    name: 'Maya Yoga',
    whatWeDo: 'Yoga lessons',
    ownerGoal: 'answer_and_collect',
    services: [{ name: 'Private', price: '$70 for 60 minutes', notes: null }],
    hours: 'Weekday evenings',
    locationOrArea: 'Oak Street',
    commonQuestions: [],
    informationToCollect: [],
    unknowns: [],
    tone: 'warm',
  });

  const facts = sectionBetween(
    prompt,
    '=== APPROVED BUSINESS FACTS ===',
    '=== BOT OBJECTIVE ==='
  );
  const objective = sectionBetween(
    prompt,
    '=== BOT OBJECTIVE ===',
    '=== CONVERSATION SETTINGS ==='
  );

  assert.ok(facts.includes('Maya Yoga'), 'business name in facts');
  assert.ok(facts.includes('$70 for 60 minutes'), 'service price in facts');
  assert.ok(
    !facts.includes(goal),
    'ownerGoal must not appear inside APPROVED BUSINESS FACTS'
  );
  assert.ok(
    !/Owner goal for this bot:/i.test(facts),
    'facts must not label ownerGoal as a business fact line'
  );
  assert.ok(objective.includes(goal), 'ownerGoal appears under BOT OBJECTIVE');
  assert.ok(
    /must NOT establish facts/i.test(objective),
    'objective must warn that ownerGoal does not establish facts'
  );
}

function testObjectivePerGoal() {
  const base = { name: 'X', whatWeDo: 'Y', services: [], informationToCollect: [] };
  const objective = (ownerGoal) =>
    sectionBetween(
      buildCustomerSystemPrompt({ ...base, ownerGoal }),
      '=== BOT OBJECTIVE ===',
      '=== CONVERSATION SETTINGS ==='
    );
  assert.match(
    objective('answer_questions'),
    /anything else they would like to know/
  );
  assert.doesNotMatch(objective('answer_questions'), /INFORMATION TO COLLECT/);
  assert.match(
    objective('collect_details'),
    /missing INFORMATION TO COLLECT items/
  );
  assert.match(
    objective('answer_and_collect'),
    /Answer from the approved facts[\s\S]*INFORMATION TO COLLECT/
  );
  // Legacy free text is never sent to the Business Bot.
  const legacy = objective('Book as many sessions as possible');
  assert.match(legacy, /none set/i);
  assert.doesNotMatch(legacy, /Book as many/);
}

function testFactsFaqUnknownsIntakeRendered() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Harbor Cafe',
    whatWeDo: 'Neighborhood cafe',
    ownerGoal: null,
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
  assert.ok(/whitelist/i.test(prompt), 'intake whitelist guidance present');
  assert.ok(
    /messaging the owner/i.test(prompt),
    'owner redirect guidance present'
  );
  assert.match(
    prompt,
    /If not listed, say it is not available here; do not say it is or is not offered/
  );
  assert.match(
    prompt,
    /Lead with a listed answer, or say it isn't available here/
  );
  assert.match(
    prompt,
    /If none do, say it isn't available here\. Not a no/
  );
  assert.match(
    prompt,
    /Invite messaging the owner only when a needed fact is actually missing/
  );
  assert.match(prompt, /consultation \/ no-quote policy/);
  assert.doesNotMatch(prompt, /say you do not know/);
  assert.ok(/CLOSED-WORLD CONTRACT/i.test(prompt));
}

function testEmptyIntakeAndNullOwnerGoal() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Spark Clean',
    whatWeDo: 'Home cleaning',
    ownerGoal: null,
    services: [{ name: 'Standard clean', price: '$120 per visit', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });

  assert.ok(
    /do not ask the customer for any intake details/i.test(prompt),
    'empty intake must instruct collect nothing'
  );
  const objective = sectionBetween(
    prompt,
    '=== BOT OBJECTIVE ===',
    '=== CONVERSATION SETTINGS ==='
  );
  assert.ok(/none set/i.test(objective), 'null ownerGoal stated as unset');
  assert.match(prompt, /ask if there is anything else they would like to know/i);
  assert.match(prompt, /Do not ask for intake details/);
  assert.ok(
    !intakeGoalEnabled({
      ownerGoal: null,
      informationToCollect: [],
    })
  );
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
    /does not mean you booked/i.test(prompt),
    'must separate approved process facts from bot action claims'
  );
}

function testIntakeConfirmDoesNotRefuseKeepingDetails() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Test Biz',
    whatWeDo: 'Services',
    ownerGoal: 'answer_and_collect',
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
  assert.match(prompt, /do not lead with "I can't book"/i);
  assert.match(
    prompt,
    /if they ask whether they are booked, say they are not/i
  );
  assert.match(prompt, /do not ask for details again/i);
  assert.ok(intakeGoalEnabled({
    ownerGoal: 'answer_and_collect',
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
  assert.match(
    prompt,
    /approved pricing process \(consultation, no-quote-in-chat/
  );
  assert.match(prompt, /is a complete answer — not a gap/i);
  assert.match(
    prompt,
    /Invite messaging the owner only when a needed fact is actually missing/
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
    responseLength: 'short',
    priceDisclosure: 'on_request',
  });

  const facts = sectionBetween(
    prompt,
    '=== APPROVED BUSINESS FACTS ===',
    '=== BOT OBJECTIVE ==='
  );
  const settings = sectionBetween(
    prompt,
    '=== CONVERSATION SETTINGS ===',
    '=== BEHAVIOR RULES ==='
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
  assert.ok(/Reply length: short/i.test(settings));
  assert.ok(/Price disclosure: on request only/i.test(settings));
  assert.ok(
    /must NOT establish facts/i.test(settings),
    'settings must carry priority statement'
  );
  assert.ok(
    /CLOSED-WORLD CONTRACT/i.test(settings) ||
      /capability limits/i.test(settings),
    'settings must defer to closed-world / whitelist'
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
    /even if a price was stated earlier|Do NOT mention prices for|I'd like to book/i.test(
      onReq
    ),
    'on_request must clarify non-pricing turns and prior prices do not unlock disclosure'
  );
  assert.ok(!/on request only/i.test(relevant));
  assert.ok(/Price disclosure: relevant/i.test(relevant));
}

function testNextStepFollowsGoalAndIntake() {
  const facts = {
    name: 'Harbor Cuts',
    whatWeDo: 'Hair salon',
    services: [{ name: 'Cut', price: '$45', notes: null }],
    unknowns: [],
  };
  const collect = buildCustomerSystemPrompt({
    ...facts,
    ownerGoal: 'answer_and_collect',
    informationToCollect: ['name', 'phone'],
  });
  const questions = buildCustomerSystemPrompt({
    ...facts,
    ownerGoal: 'answer_questions',
    informationToCollect: [],
  });
  const collectNoList = buildCustomerSystemPrompt({
    ...facts,
    ownerGoal: 'collect_details',
    informationToCollect: [],
  });

  assert.ok(intakeGoalEnabled({
    ownerGoal: 'answer_and_collect',
    informationToCollect: ['name', 'phone'],
  }));
  assert.ok(!intakeGoalEnabled({
    ownerGoal: 'answer_questions',
    informationToCollect: [],
  }));
  assert.ok(!intakeGoalEnabled({
    ownerGoal: 'collect_details',
    informationToCollect: [],
  }));
  assert.ok(!intakeGoalEnabled({
    ownerGoal: 'answer_questions',
    informationToCollect: ['name'],
  }));

  assert.match(collect, /invite them to leave their listed details/i);
  assert.match(collect, /Interest or a booking request: ask for the missing listed items now/);
  assert.doesNotMatch(collect, /Do not ask for intake details/);
  assert.doesNotMatch(collect, /gently invite a useful next step/i);

  assert.match(questions, /ask if there is anything else they would like to know/i);
  assert.match(questions, /Do not ask for intake details/);
  assert.doesNotMatch(questions, /invite them to leave their listed details/i);

  assert.match(collectNoList, /Do not ask for intake details/);
  assert.doesNotMatch(collectNoList, /invite them to leave their listed details/i);
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
  assert.match(prompt, /Warm, friendly, and human/);
}

function testDefaultOpeningText() {
  assert.equal(
    defaultCustomerOpening({ name: 'BurgerBarber' }),
    "Hi! I'm Adam, BurgerBarber's digital assistant 😊"
  );
  assert.equal(
    defaultCustomerOpening({}),
    "Hi! I'm Adam, this business's digital assistant 😊"
  );
  assert.equal(
    customerOpeningText({
      name: 'BurgerBarber',
    }),
    "Hi! I'm Adam, BurgerBarber's digital assistant 😊"
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
    // no responseLength / priceDisclosure
  });
  const settings = sectionBetween(
    prompt,
    '=== CONVERSATION SETTINGS ===',
    '=== BEHAVIOR RULES ==='
  );
  const eff = effectiveBehavior({
    tone: 'warm and calm',
    responseLength: null,
    priceDisclosure: null,
  });
  assert.equal(eff.responseLength, DEFAULT_BEHAVIOR.responseLength);
  assert.equal(eff.priceDisclosure, DEFAULT_BEHAVIOR.priceDisclosure);
  assert.ok(settings.includes('warm and calm'));
  assert.ok(/Reply length: standard/i.test(settings));
  assert.ok(/Price disclosure: relevant/i.test(settings));
  assert.match(settings, /You are Adam, Legacy Biz's digital assistant/);
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
  assert.match(prompt, /Stay on this business only/);
  assert.match(prompt, /Poems, homework, general knowledge, coding/);
  assert.match(prompt, /one short, warm steer back to the business/);
  assert.doesNotMatch(prompt, /happy to help with anything/i);
  assert.doesNotMatch(prompt, /Keep replies concise and helpful/);
}

function main() {
  testOwnerGoalSeparatedFromFacts();
  testObjectivePerGoal();
  testFactsFaqUnknownsIntakeRendered();
  testEmptyIntakeAndNullOwnerGoal();
  testNoForcedBookingProcess();
  testIntakeConfirmDoesNotRefuseKeepingDetails();
  testPricingProcessIsCompleteAnswer();
  testConversationSettingsSectionSeparated();
  testOnRequestPolicyOnlyWhenSet();
  testNextStepFollowsGoalAndIntake();
  testOpeningNotInStandingPrompt();
  testDefaultOpeningText();
  testLegacyDefaultsInPrompt();
  testStayOnBusinessRule();
  console.log('test-customer-prompt: all passed');
}

main();
