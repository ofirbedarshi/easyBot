/**
 * Deterministic structure/boundary checks for buildCustomerSystemPrompt.
 * Behavioral regressions belong in e2e / judge calibration — not here.
 */
import assert from 'assert';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';

function sectionBetween(prompt, startMarker, endMarker) {
  const start = prompt.indexOf(startMarker);
  assert.ok(start >= 0, `missing marker: ${startMarker}`);
  const from = start + startMarker.length;
  const end = endMarker ? prompt.indexOf(endMarker, from) : prompt.length;
  assert.ok(end > from, `missing end marker after ${startMarker}`);
  return prompt.slice(from, end);
}

function testOwnerGoalSeparatedFromFacts() {
  const goal = 'Steer customers toward weekday evening lessons';
  const prompt = buildCustomerSystemPrompt({
    name: 'Maya Yoga',
    whatWeDo: 'Yoga lessons',
    ownerGoal: goal,
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
    '=== BEHAVIOR RULES ==='
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
    '=== BEHAVIOR RULES ==='
  );
  assert.ok(/none set/i.test(objective), 'null ownerGoal stated as unset');
}

function testNoForcedEnglishOrForcedBookingProcess() {
  const prompt = buildCustomerSystemPrompt({
    name: 'Test Biz',
    whatWeDo: 'Services',
    services: [{ name: 'A', price: '$1', notes: null }],
    informationToCollect: [],
    unknowns: [],
  });

  assert.ok(
    !/Speak naturally in English/i.test(prompt),
    'must not force English'
  );
  assert.ok(
    /Respond in the customer's language/i.test(prompt),
    'must instruct matching customer language'
  );
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

function main() {
  testOwnerGoalSeparatedFromFacts();
  testFactsFaqUnknownsIntakeRendered();
  testEmptyIntakeAndNullOwnerGoal();
  testNoForcedEnglishOrForcedBookingProcess();
  console.log('test-customer-prompt: all passed');
}

main();
