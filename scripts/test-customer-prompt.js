/**
 * Deterministic structure/boundary checks for buildCustomerSystemPrompt.
 */
import assert from 'assert';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import {
  DEFAULT_BEHAVIOR,
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
  const goal = 'Answer customer questions from the approved facts, and when a customer shows interest';
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
  assert.match(objective('answer_questions'), /answering their questions from the approved facts/);
  assert.doesNotMatch(objective('answer_questions'), /INFORMATION TO COLLECT/);
  assert.match(objective('collect_details'), /ask for the details in INFORMATION TO COLLECT/);
  assert.match(objective('answer_and_collect'), /Answer customer questions[\s\S]*INFORMATION TO COLLECT/);
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
    /message the owner directly/i.test(prompt),
    'owner redirect guidance present'
  );
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
    /approved process does NOT prove/i.test(prompt) ||
      /does NOT prove that you saved/i.test(prompt),
    'must separate approved process facts from bot action claims'
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
  assert.ok(!/^Tone:/m.test(prompt.split('===')[0]), 'no top-level Tone line');
}

function main() {
  testOwnerGoalSeparatedFromFacts();
  testObjectivePerGoal();
  testFactsFaqUnknownsIntakeRendered();
  testEmptyIntakeAndNullOwnerGoal();
  testNoForcedBookingProcess();
  testConversationSettingsSectionSeparated();
  testOnRequestPolicyOnlyWhenSet();
  testLegacyDefaultsInPrompt();
  console.log('test-customer-prompt: all passed');
}

main();
