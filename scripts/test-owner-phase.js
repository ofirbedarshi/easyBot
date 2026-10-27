/**
 * Unit table for ownerPhase. Pins the 7-phase derivation only.
 * No handleMessage walks — setup-flow owns those.
 */
import assert from 'assert';
import { OWNER_PHASES, ownerPhase } from '../src/ownerPhase.js';

assert.deepEqual(
  [...OWNER_PHASES],
  ['wake', 'setup', 'wrapup', 'ready', 'test', 'lead', 'lead_resume']
);

const history = [{ role: 'assistant', content: 'hi' }];
const leadInProgress = { step: 'contactConsent', answers: {} };
const leadResume = { submittedAt: '2026-01-01T00:00:00.000Z', resumeMenu: true };

const rows = [
  {
    id: 1,
    name: 'TEST wins on empty profile',
    session: { mode: 'TEST', buildHistory: [], leadIntake: null },
    profile: {},
    expect: 'test',
  },
  {
    id: 2,
    name: 'TEST wins over approvedAt and lead in progress',
    session: { mode: 'TEST', buildHistory: history, leadIntake: leadInProgress },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'test',
  },
  {
    id: 3,
    name: 'BUILD lead in progress while approved',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: leadInProgress },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'lead',
  },
  {
    id: 4,
    name: 'BUILD lead resume pending',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: leadResume },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'lead_resume',
  },
  {
    id: 5,
    name: 'BUILD empty history is wake',
    session: { mode: 'BUILD', buildHistory: [], leadIntake: null },
    profile: {},
    expect: 'wake',
  },
  {
    id: 6,
    name: 'mid-setup: no approvedAt, no goal, no wrap-up asked',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: null, draft: { askedTopics: [], ownerGoal: null } },
    expect: 'setup',
  },
  {
    id: 7,
    name: 'tell-me-more asked does not start wrap-up',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: {
      approvedAt: null,
      draft: {
        name: 'Ofir garage',
        whatWeDo: 'Garage',
        ownerGoal: null,
        askedTopics: ['businessDetails'],
      },
    },
    expect: 'setup',
  },
  {
    id: 8,
    name: 'ownerGoal set starts wrap-up',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: {
      approvedAt: null,
      draft: { ownerGoal: 'answer_questions', askedTopics: [] },
    },
    expect: 'wrapup',
  },
  {
    id: 9,
    name: 'FAQ asked starts wrap-up even if goal is still null',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: {
      approvedAt: null,
      draft: { ownerGoal: null, askedTopics: ['commonQuestions'] },
    },
    expect: 'wrapup',
  },
  {
    id: 10,
    name: 'this-turn readyForReview starts wrap-up',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: null, draft: { ownerGoal: null, askedTopics: [] } },
    view: { turn: { readyForReview: true } },
    expect: 'wrapup',
  },
  {
    id: 11,
    name: 'this-turn wantsReview starts wrap-up',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: null, draft: { ownerGoal: null, askedTopics: [] } },
    view: { turn: { wantsReview: true } },
    expect: 'wrapup',
  },
  {
    id: 12,
    name: 'approvedAt is ready even if wrap-up keys remain',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: {
      approvedAt: '2026-01-01T00:00:00.000Z',
      draft: { askedTopics: ['commonQuestions', 'informationToCollect'] },
    },
    expect: 'ready',
  },
  {
    id: 13,
    name: 'session omitted, approvedAt set → ready',
    session: null,
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'ready',
  },
  {
    id: 14,
    name: 'session omitted, no approvedAt, no wrap-up inputs → setup',
    session: null,
    profile: { approvedAt: null, draft: { askedTopics: [], ownerGoal: null } },
    expect: 'setup',
  },
  {
    id: 15,
    name: 'approvedAt wins even when hasEnoughForFirstBot is false',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z', name: null, whatWeDo: null, services: [] },
    expect: 'ready',
  },
  {
    id: 16,
    name: 'hasEnoughForFirstBot without approvedAt is still setup',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: {
      approvedAt: null,
      name: 'Ofir garage',
      whatWeDo: 'Garage',
      services: [],
      draft: { name: 'Ofir garage', whatWeDo: 'Garage', ownerGoal: null, askedTopics: [] },
    },
    expect: 'setup',
  },
];

assert.equal(rows.length, 16, 'table must stay 16 rows');

let failed = 0;
for (const row of rows) {
  const got = ownerPhase(row.session, row.profile, row.view);
  try {
    assert.equal(got, row.expect, `#${row.id} ${row.name}`);
  } catch (err) {
    failed += 1;
    console.error(err.message);
  }
}

if (failed) {
  console.error(`owner-phase: ${failed}/${rows.length} failed`);
  process.exit(1);
}
console.log(`owner-phase: ${rows.length} cases passed`);
