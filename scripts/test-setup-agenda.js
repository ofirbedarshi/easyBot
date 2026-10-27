/**
 * Table-driven setup agenda. No handleMessage, no model flow flags consulted.
 */
import assert from 'assert';
import { topicByKey } from '../src/builderTopics.js';
import {
  IDENTITY_FALLBACK_QUESTION,
  SETUP_STEPS,
  setupStep,
  stepSetupAgenda,
} from '../src/setupAgenda.js';

assert.deepEqual([...SETUP_STEPS], ['identity', 'businessDetails', 'complete']);

const DETAILS = topicByKey('businessDetails');

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
  });
}

const rows = [
  {
    id: 1,
    name: 'name only stays on identity; no ? → fallback',
    priorAsked: [],
    draft: draft({ name: 'Ofir garage' }),
    modelMessage: 'Nice place.',
    expect: {
      step: 'identity',
      askedTopics: [],
      question: IDENTITY_FALLBACK_QUESTION,
      presentComplete: false,
    },
  },
  {
    id: 2,
    name: 'name + what → tell-me-more',
    priorAsked: [],
    draft: nameWhat(),
    modelMessage: 'Ofir garage is your garage ✨',
    expect: {
      step: 'businessDetails',
      askedTopics: ['businessDetails'],
      topic: DETAILS,
      ack: DETAILS.ack,
      presentComplete: false,
    },
  },
  {
    id: 3,
    name: 'all details already present skips tell-me-more → complete',
    priorAsked: [],
    draft: allDetails(),
    modelMessage: 'Got it ✨',
    expect: {
      step: 'complete',
      askedTopics: [],
      presentComplete: true,
    },
  },
  {
    id: 4,
    name: 'skip tell-me-more after it was asked → complete',
    priorAsked: ['businessDetails'],
    draft: nameWhat(),
    topicResponse: 'skipped',
    justAsked: 'businessDetails',
    expect: {
      step: 'complete',
      askedTopics: ['businessDetails'],
      presentComplete: true,
    },
  },
  {
    id: 5,
    name: 'unclear tell-me-more stays; keepLead',
    priorAsked: ['businessDetails'],
    draft: nameWhat(),
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
    id: 6,
    name: 'hours this turn settle tell-me-more → complete',
    priorAsked: ['businessDetails'],
    priorDraft: nameWhat(),
    draft: nameWhat({ hours: 'Mon–Fri 8–18' }),
    justAsked: 'businessDetails',
    expect: {
      step: 'complete',
      askedTopics: ['businessDetails'],
      presentComplete: true,
    },
  },
  {
    id: 7,
    name: 'unresolved config stays without recording a new ask',
    priorAsked: [],
    draft: nameWhat(),
    unresolvedConfig: true,
    expect: {
      step: 'businessDetails',
      askedTopics: [],
      stay: true,
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

assert.equal(setupStep(nameWhat()), 'businessDetails');
assert.equal(setupStep(allDetails()), 'complete');
assert.equal(setupStep(draft()), 'identity');

if (failed) {
  console.error(`FAIL setup-agenda: ${failed} row(s)`);
  process.exit(1);
}
console.log(`PASS setup-agenda: ${rows.length} rows`);
