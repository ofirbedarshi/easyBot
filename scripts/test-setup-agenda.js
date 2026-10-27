/**
 * Table-driven setup agenda. No handleMessage, no model flow flags consulted.
 */
import assert from 'assert';
import { topicByKey } from '../src/builderTopics.js';
import {
  IDENTITY_FALLBACK_QUESTION,
  OWNER_NAME_QUESTION,
  SETUP_STEPS,
  applyOwnerNameCollisionGuard,
  setupStep,
  stepSetupAgenda,
} from '../src/setupAgenda.js';
import {
  businessDetailsAck,
  ownerMeetAck,
} from '../src/copy.js';

assert.deepEqual([...SETUP_STEPS], ['ownerName', 'identity', 'businessDetails', 'complete']);

const DETAILS = topicByKey('businessDetails');
const OWNER = 'Ofir';

function draft(overrides = {}) {
  return {
    name: null,
    whatWeDo: null,
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    ...overrides,
  };
}

function nameWhat(overrides = {}) {
  return draft({ name: 'Ofir garage', whatWeDo: 'Garage', ...overrides });
}

function allDetails(overrides = {}) {
  return nameWhat({
    services: [{ name: 'Oil change', price: '200 ILS', notes: null }],
    hours: 'Mon–Fri 8–18',
    locationOrArea: 'Haifa',
    ...overrides,
  });
}

function advance(row) {
  return stepSetupAgenda({
    priorAsked: row.priorAsked || [],
    draftAfterExtract: row.draft,
    modelMessage: row.modelMessage || '',
    unresolvedConfig: row.unresolvedConfig === true,
    topicResponse: row.topicResponse,
    justAsked: row.justAsked,
    priorDraft: row.priorDraft,
    ownerName: row.ownerName,
  });
}

const rows = [
  {
    id: 1,
    name: 'no owner name stays on ownerName; keepLead after opening',
    priorAsked: [],
    draft: draft(),
    ownerName: null,
    justAsked: 'ownerName',
    modelMessage: 'I can explain — what should I call you?',
    expect: {
      step: 'ownerName',
      askedTopics: [],
      question: OWNER_NAME_QUESTION,
      keepLead: true,
      presentComplete: false,
    },
  },
  {
    id: 2,
    name: 'owner name only → Nice to meet you + identity',
    priorAsked: [],
    draft: draft(),
    ownerName: OWNER,
    justAsked: 'ownerName',
    modelMessage: 'Hi Ofir!',
    expect: {
      step: 'identity',
      askedTopics: [],
      question: IDENTITY_FALLBACK_QUESTION,
      ack: ownerMeetAck(OWNER),
      presentComplete: false,
    },
  },
  {
    id: 3,
    name: 'name + business same turn skips identity → tell-me-more',
    priorAsked: [],
    draft: nameWhat(),
    ownerName: OWNER,
    justAsked: 'ownerName',
    modelMessage: 'Ofir garage is your garage ✨',
    expect: {
      step: 'businessDetails',
      askedTopics: ['businessDetails'],
      topic: DETAILS,
      ack: businessDetailsAck(OWNER),
      presentComplete: false,
    },
  },
  {
    id: 4,
    name: 'name only stays on identity; no ? → fallback',
    priorAsked: [],
    draft: draft({ name: 'Ofir garage' }),
    ownerName: OWNER,
    modelMessage: 'Nice place.',
    expect: {
      step: 'identity',
      askedTopics: [],
      question: IDENTITY_FALLBACK_QUESTION,
      presentComplete: false,
    },
  },
  {
    id: 5,
    name: 'all details already present skips tell-me-more → complete',
    priorAsked: [],
    draft: allDetails(),
    ownerName: OWNER,
    modelMessage: 'Got it ✨',
    expect: {
      step: 'complete',
      askedTopics: [],
      presentComplete: true,
    },
  },
  {
    id: 6,
    name: 'skip tell-me-more after it was asked → complete',
    priorAsked: ['businessDetails'],
    draft: nameWhat(),
    ownerName: OWNER,
    topicResponse: 'skipped',
    justAsked: 'businessDetails',
    expect: {
      step: 'complete',
      askedTopics: ['businessDetails'],
      presentComplete: true,
    },
  },
  {
    id: 7,
    name: 'unclear tell-me-more stays; keepLead',
    priorAsked: ['businessDetails'],
    draft: nameWhat(),
    ownerName: OWNER,
    topicResponse: 'unclear',
    justAsked: 'businessDetails',
    modelMessage: 'I mean services, hours, or location?',
    expect: {
      step: 'businessDetails',
      askedTopics: ['businessDetails'],
      keepLead: true,
      presentComplete: false,
    },
  },
  {
    id: 8,
    name: 'hours this turn settle tell-me-more → complete',
    priorAsked: ['businessDetails'],
    priorDraft: nameWhat(),
    draft: nameWhat({ hours: 'Mon–Fri 8–18' }),
    ownerName: OWNER,
    justAsked: 'businessDetails',
    expect: {
      step: 'complete',
      askedTopics: ['businessDetails'],
      presentComplete: true,
    },
  },
  {
    id: 9,
    name: 'unresolved config stays without recording a new ask',
    priorAsked: [],
    draft: nameWhat(),
    ownerName: OWNER,
    unresolvedConfig: true,
    expect: {
      step: 'businessDetails',
      askedTopics: [],
      stay: true,
      presentComplete: false,
    },
  },
  {
    id: 10,
    name: 'skipped on ownerName does not settle',
    priorAsked: [],
    draft: draft(),
    ownerName: null,
    topicResponse: 'skipped',
    justAsked: 'ownerName',
    expect: {
      step: 'ownerName',
      question: OWNER_NAME_QUESTION,
      presentComplete: false,
    },
  },
  {
    id: 11,
    name: 'business dump without owner name stays on ownerName',
    priorAsked: [],
    draft: allDetails(),
    ownerName: null,
    justAsked: 'ownerName',
    expect: {
      step: 'ownerName',
      askedTopics: [],
      presentComplete: false,
    },
  },
];

let failed = 0;
for (const row of rows) {
  const got = advance(row);
  try {
    if (row.expect.step) assert.equal(got.step, row.expect.step, `${row.id} step`);
    if (row.expect.askedTopics) {
      assert.deepEqual(got.askedTopics, row.expect.askedTopics, `${row.id} asked`);
    }
    if (row.expect.question !== undefined) {
      assert.equal(got.question, row.expect.question, `${row.id} question`);
    }
    if (row.expect.topic) assert.equal(got.topic, row.expect.topic, `${row.id} topic`);
    if (row.expect.ack !== undefined) assert.equal(got.ack, row.expect.ack, `${row.id} ack`);
    if (row.expect.presentComplete !== undefined) {
      assert.equal(got.presentComplete, row.expect.presentComplete, `${row.id} complete`);
    }
    if (row.expect.keepLead !== undefined) {
      assert.equal(got.keepLead, row.expect.keepLead, `${row.id} keepLead`);
    }
    if (row.expect.stay !== undefined) assert.equal(got.stay, row.expect.stay, `${row.id} stay`);
  } catch (err) {
    failed += 1;
    console.error(`#${row.id} ${row.name}: ${err.message}`);
  }
}

assert.equal(setupStep(nameWhat(), [], OWNER), 'businessDetails');
assert.equal(setupStep(allDetails(), [], OWNER), 'complete');
assert.equal(setupStep(draft(), [], OWNER), 'identity');
assert.equal(setupStep(draft()), 'ownerName');
assert.equal(setupStep(allDetails()), 'ownerName');

const collided = applyOwnerNameCollisionGuard(
  { name: 'Dana', whatWeDo: null },
  'Dana',
  null
);
assert.equal(collided.name, null);
const dumped = applyOwnerNameCollisionGuard(
  { name: "Dana's Hair", whatWeDo: 'Salon' },
  'Dana',
  null
);
assert.equal(dumped.name, "Dana's Hair");
const later = applyOwnerNameCollisionGuard({ name: 'Dana', whatWeDo: null }, 'Dana', 'Sam');
assert.equal(later.name, 'Dana');

if (failed) {
  console.error(`${failed}/${rows.length} failed`);
  process.exit(1);
}
console.log(`PASS setup-agenda ${rows.length} rows`);
