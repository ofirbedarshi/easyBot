/**
 * Table-driven setup agenda. No handleMessage, no model flow flags consulted.
 */
import assert from 'assert';
import { normalizeOwnerGoal } from '../src/profile.js';
import { topicByKey } from '../src/builderTopics.js';
import {
  IDENTITY_FALLBACK_QUESTION,
  SETUP_STEPS,
  setupStep,
  stepSetupAgenda,
} from '../src/setupAgenda.js';
import { composeReply } from '../src/composeReply.js';

assert.deepEqual(
  [...SETUP_STEPS],
  ['identity', 'businessDetails', 'goal', 'faq', 'intake', 'complete']
);

const FAQ = topicByKey('commonQuestions');
const INTAKE = topicByKey('informationToCollect');
const DETAILS = topicByKey('businessDetails');

function draft(overrides = {}) {
  return {
    name: null,
    whatWeDo: null,
    ownerGoal: null,
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

function withGoal(overrides = {}) {
  return allDetails({ ownerGoal: 'answer_questions', ...overrides });
}

function advance(row) {
  return stepSetupAgenda({
    priorAsked: row.priorAsked || [],
    draftAfterExtract: row.draft,
    modelMessage: row.modelMessage || '',
    unresolvedConfig: row.unresolvedConfig === true,
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
    name: 'name + what, details missing → tell-more, all 3 bullets',
    priorAsked: [],
    draft: nameWhat(),
    expect: {
      step: 'businessDetails',
      askedTopics: ['businessDetails'],
      topicKey: 'businessDetails',
      ack: DETAILS.ack,
    },
  },
  {
    id: 3,
    name: 'name + what + all details → goal, asked stays empty',
    priorAsked: [],
    draft: allDetails(),
    expect: { step: 'goal', askedTopics: [], topicKey: null },
  },
  {
    id: 4,
    name: 'tell-more already asked, hours only → goal, do not re-ask',
    priorAsked: ['businessDetails'],
    draft: nameWhat({ hours: 'Mon–Fri 8–18' }),
    expect: { step: 'goal', askedTopics: ['businessDetails'], topicKey: null },
  },
  {
    id: 5,
    name: 'tell-more asked, empty extract / skip-shaped → goal',
    priorAsked: ['businessDetails'],
    draft: nameWhat(),
    expect: { step: 'goal', askedTopics: ['businessDetails'], topicKey: null },
  },
  {
    id: 6,
    name: 'goal step, ownerGoal still null → re-ask goal',
    priorAsked: ['businessDetails'],
    draft: allDetails({ ownerGoal: null }),
    expect: { step: 'goal', askedTopics: ['businessDetails'], topicKey: null },
  },
  {
    id: 7,
    name: 'ownerGoal set → faq',
    priorAsked: ['businessDetails'],
    draft: withGoal(),
    expect: {
      step: 'faq',
      askedTopics: ['businessDetails', 'commonQuestions'],
      topicKey: 'commonQuestions',
      ack: FAQ.ack,
    },
  },
  {
    id: 8,
    name: 'ownerGoal + answered FAQ → intake',
    priorAsked: ['businessDetails'],
    draft: withGoal({
      commonQuestions: [{ question: 'Trucks?', answer: 'Yes, light trucks.' }],
    }),
    expect: {
      step: 'intake',
      askedTopics: ['businessDetails', 'informationToCollect'],
      topicKey: 'informationToCollect',
      ack: INTAKE.ack,
    },
  },
  {
    id: 9,
    name: 'faq asked, no FAQ rows → intake',
    priorAsked: ['businessDetails', 'commonQuestions'],
    draft: withGoal(),
    expect: {
      step: 'intake',
      askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
      topicKey: 'informationToCollect',
      ack: null,
    },
  },
  {
    id: 10,
    name: 'intake asked, still null → re-ask intake',
    priorAsked: ['businessDetails', 'commonQuestions', 'informationToCollect'],
    draft: withGoal({ informationToCollect: null }),
    expect: {
      step: 'intake',
      askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
      topicKey: 'informationToCollect',
      ack: null,
    },
  },
  {
    id: 11,
    name: 'intake asked, [] → complete',
    priorAsked: ['businessDetails', 'commonQuestions', 'informationToCollect'],
    draft: withGoal({ informationToCollect: [] }),
    expect: {
      step: 'complete',
      askedTopics: ['businessDetails', 'commonQuestions', 'informationToCollect'],
      presentComplete: true,
      topicKey: null,
    },
  },
  {
    id: 12,
    name: 'faq asked + volunteered intake array → complete',
    priorAsked: ['businessDetails', 'commonQuestions'],
    draft: withGoal({ informationToCollect: ['name', 'phone'] }),
    expect: {
      step: 'complete',
      askedTopics: ['businessDetails', 'commonQuestions'],
      presentComplete: true,
    },
  },
  {
    id: 13,
    name: 'flags on the turn are not an input (same as row 7)',
    priorAsked: ['businessDetails'],
    draft: withGoal(),
    flags: {
      readyForReview: true,
      wantsReview: true,
      askingTopic: 'commonQuestions',
      asksQuestion: false,
    },
    expect: {
      step: 'faq',
      askedTopics: ['businessDetails', 'commonQuestions'],
      topicKey: 'commonQuestions',
    },
  },
  {
    id: 14,
    name: 'hours edited while on faq → stay/advance faq, no rewind',
    priorAsked: ['businessDetails'],
    draft: withGoal({ hours: 'Sun–Thu 9–17' }),
    expect: {
      step: 'faq',
      askedTopics: ['businessDetails', 'commonQuestions'],
      topicKey: 'commonQuestions',
    },
  },
  {
    id: 15,
    name: 'unresolved config on identity → stay, no tell-more',
    priorAsked: [],
    draft: nameWhat(),
    unresolvedConfig: true,
    expect: {
      step: 'businessDetails',
      askedTopics: [],
      stay: true,
      topicKey: null,
      presentComplete: false,
    },
  },
];

assert.equal(rows.length, 15, 'table must stay 15 rows');

let failed = 0;
for (const row of rows) {
  const got = advance(row);
  const expect = row.expect;
  try {
    assert.equal(got.step, expect.step, `#${row.id} ${row.name}: step`);
    assert.deepEqual(got.askedTopics, expect.askedTopics, `#${row.id} ${row.name}: asked`);
    if ('presentComplete' in expect) {
      assert.equal(
        got.presentComplete,
        expect.presentComplete,
        `#${row.id} ${row.name}: presentComplete`
      );
    }
    if ('stay' in expect) {
      assert.equal(got.stay, expect.stay, `#${row.id} ${row.name}: stay`);
    } else {
      assert.equal(got.stay, false, `#${row.id} ${row.name}: stay false`);
    }
    if ('topicKey' in expect) {
      assert.equal(got.topic?.key ?? null, expect.topicKey, `#${row.id} ${row.name}: topic`);
    }
    if ('ack' in expect) {
      assert.equal(got.ack, expect.ack, `#${row.id} ${row.name}: ack`);
    }
    if ('question' in expect) {
      assert.equal(got.question, expect.question, `#${row.id} ${row.name}: question`);
    }
    if (row.id === 2) {
      const q = DETAILS.questionFor(row.draft);
      assert.ok(q.includes('🛠️ What services do you offer'));
      assert.ok(q.includes('🕒 What are your opening hours?'));
      assert.ok(q.includes('📍 Where are you located?'));
    }
    // Flags on the row must not change the result versus the unflagged twin.
    if (row.flags) {
      const twin = rows.find((r) => r.id === 7);
      const twinGot = advance(twin);
      assert.deepEqual(
        { step: got.step, askedTopics: got.askedTopics, topic: got.topic?.key ?? null },
        {
          step: twinGot.step,
          askedTopics: twinGot.askedTopics,
          topic: twinGot.topic?.key ?? null,
        },
        `#${row.id} flags must not change the agenda`
      );
    }
  } catch (err) {
    failed += 1;
    console.error(err.message);
  }
}

// setupStep derivation (stored askedTopics, no priorAsked override)
assert.equal(setupStep(draft({ name: 'A' })), 'identity');
assert.equal(setupStep(nameWhat()), 'businessDetails');
assert.equal(setupStep(allDetails()), 'goal');
assert.equal(setupStep(withGoal()), 'faq');
assert.equal(
  setupStep(withGoal({ askedTopics: ['commonQuestions'] })),
  'intake'
);
assert.equal(
  setupStep(withGoal({ informationToCollect: [], askedTopics: ['commonQuestions'] })),
  'complete'
);
assert.ok(normalizeOwnerGoal(withGoal().ownerGoal));

{
  const answeredFaq = withGoal({
    commonQuestions: [{ question: 'Trucks?', answer: 'Yes, light trucks.' }],
  });
  const first = advance({ priorAsked: ['businessDetails'], draft: answeredFaq });
  assert.equal(first.ack, INTAKE.ack, 'first intake after answered FAQ keeps INTAKE_ACK');
  assert.equal(
    composeReply({
      kind: 'ask_topic',
      parts: { topic: first.topic, ack: first.ack, draft: answeredFaq },
    }).reply,
    `${INTAKE.ack}\n\n${INTAKE.question}`
  );

  const repeatModel = 'We collect it at booking. Shall I start?';
  const repeatDraft = withGoal({ informationToCollect: null });
  const repeat = advance({
    priorAsked: ['businessDetails', 'commonQuestions', 'informationToCollect'],
    draft: repeatDraft,
    modelMessage: repeatModel,
  });
  assert.equal(repeat.ack, null, 'repeat intake has no INTAKE_ACK');
  const repeatReply = composeReply({
    kind: 'ask_topic',
    modelText: repeatModel,
    parts: { topic: repeat.topic, ack: repeat.ack, draft: repeatDraft },
  }).reply;
  assert.equal(repeatReply, `We collect it at booking.\n\n${INTAKE.question}`);
  assert.ok(!repeatReply.includes(INTAKE.ack));

  const faqQModel =
    'I collect it when a customer is ready to book. When works for you?';
  const faqEmpty = withGoal();
  const afterUnansweredFaq = advance({
    priorAsked: ['businessDetails', 'commonQuestions'],
    draft: faqEmpty,
    modelMessage: faqQModel,
  });
  assert.equal(afterUnansweredFaq.ack, null, 'unanswered FAQ → intake has no INTAKE_ACK');
  const faqQReply = composeReply({
    kind: 'ask_topic',
    modelText: faqQModel,
    parts: { topic: afterUnansweredFaq.topic, ack: afterUnansweredFaq.ack, draft: faqEmpty },
  }).reply;
  assert.equal(faqQReply, `I collect it when a customer is ready to book.\n\n${INTAKE.question}`);
  assert.ok(!faqQReply.includes(INTAKE.ack));
  assert.ok(!/noted/i.test(faqQReply));

  const detailsDraft = nameWhat();
  const detailsRepeat = composeReply({
    kind: 'ask_topic',
    modelText: 'Happy to explain hours first. What else should I know?',
    parts: { topic: DETAILS, ack: null, draft: detailsDraft },
  }).reply;
  assert.equal(
    detailsRepeat,
    `Happy to explain hours first.\n\n${DETAILS.questionFor(detailsDraft)}`
  );
  assert.ok(!detailsRepeat.includes(DETAILS.ack));
}

if (failed) {
  console.error(`setup-agenda: ${failed}/${rows.length} failed`);
  process.exit(1);
}
console.log(`setup-agenda: ${rows.length} cases passed`);
