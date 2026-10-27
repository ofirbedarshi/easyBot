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
    name: 'leftover readyForReview on a view does not start wrap-up',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: null, draft: { ownerGoal: null, askedTopics: [] } },
    view: { turn: { readyForReview: true } },
    expect: 'setup',
  },
  {
    id: 11,
    name: 'leftover wantsReview on a view does not start wrap-up',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: null, draft: { ownerGoal: null, askedTopics: [] } },
    view: { turn: { wantsReview: true } },
    expect: 'setup',
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
  {
    id: 17,
    name: 'empty history + approvedAt is still wake',
    session: { mode: 'BUILD', buildHistory: [], leadIntake: null },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'wake',
  },
];

assert.equal(rows.length, 17, 'table must stay 17 rows');

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

const TS = '2026-01-01T00:00:00.000Z';
const opened = [{ role: 'assistant', content: 'opening' }];
const wrapDraft = { ownerGoal: 'answer_questions', askedTopics: ['commonQuestions'] };

/** Each edge: mutate the same fields handleMessage / enterTest / enterBuild / lead writers change. */
const transitions = [
  {
    id: 'wake→setup',
    from: { session: { mode: 'BUILD', buildHistory: [], leadIntake: null }, profile: {} },
    apply: (s) => {
      s.buildHistory = opened;
    },
    expect: 'setup',
  },
  {
    id: 'wake→ready',
    from: {
      session: { mode: 'BUILD', buildHistory: [], leadIntake: null },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.buildHistory = opened;
    },
    expect: 'ready',
  },
  {
    id: 'setup→wrapup',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: { askedTopics: [], ownerGoal: null } },
    },
    apply: (_s, p) => {
      p.draft = wrapDraft;
    },
    expect: 'wrapup',
  },
  {
    id: 'setup→ready',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: { askedTopics: [], ownerGoal: null } },
    },
    apply: (_s, p) => {
      p.approvedAt = TS;
    },
    expect: 'ready',
  },
  {
    id: 'wrapup→ready',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: wrapDraft },
    },
    apply: (_s, p) => {
      p.approvedAt = TS;
    },
    expect: 'ready',
  },
  {
    id: 'setup→test',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: { askedTopics: [], ownerGoal: null } },
    },
    apply: (s) => {
      s.mode = 'TEST';
    },
    expect: 'test',
  },
  {
    id: 'wrapup→test',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: wrapDraft },
    },
    apply: (s) => {
      s.mode = 'TEST';
    },
    expect: 'test',
  },
  {
    id: 'ready→test',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.mode = 'TEST';
    },
    expect: 'test',
  },
  {
    id: 'test→ready',
    from: {
      session: { mode: 'TEST', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.mode = 'BUILD';
    },
    expect: 'ready',
  },
  {
    id: 'test→setup',
    from: {
      session: { mode: 'TEST', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: { askedTopics: [], ownerGoal: null } },
    },
    apply: (s) => {
      s.mode = 'BUILD';
    },
    expect: 'setup',
  },
  {
    id: 'test→wrapup',
    from: {
      session: { mode: 'TEST', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: wrapDraft },
    },
    apply: (s) => {
      s.mode = 'BUILD';
    },
    expect: 'wrapup',
  },
  {
    id: 'ready→lead',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.leadIntake = leadInProgress;
    },
    expect: 'lead',
  },
  {
    id: 'lead→lead_resume',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: leadInProgress },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.leadIntake = leadResume;
    },
    expect: 'lead_resume',
  },
  {
    id: 'lead→ready',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: leadInProgress },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.leadIntake = null;
    },
    expect: 'ready',
  },
  {
    id: 'lead→test',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: leadInProgress },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.mode = 'TEST';
      s.leadIntake = null;
    },
    expect: 'test',
  },
  {
    id: 'lead_resume→ready',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: leadResume },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.leadIntake = { submittedAt: leadResume.submittedAt };
    },
    expect: 'ready',
  },
  {
    id: 'lead_resume→test',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: leadResume },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.mode = 'TEST';
      s.leadIntake = { submittedAt: leadResume.submittedAt };
    },
    expect: 'test',
  },
  {
    id: 'ready→wake',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: TS },
    },
    apply: (s, p) => {
      s.buildHistory = [];
      s.leadIntake = null;
      p.approvedAt = null;
    },
    expect: 'wake',
  },
  {
    id: 'setup→wake',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: { askedTopics: [], ownerGoal: null } },
    },
    apply: (s) => {
      s.buildHistory = [];
    },
    expect: 'wake',
  },
  {
    id: 'wrapup→wake',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: wrapDraft },
    },
    apply: (s, p) => {
      s.buildHistory = [];
      p.draft = { askedTopics: [], ownerGoal: null };
    },
    expect: 'wake',
  },
  {
    id: 'test→wake',
    from: {
      session: { mode: 'TEST', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: TS },
    },
    apply: (s, p) => {
      s.mode = 'BUILD';
      s.buildHistory = [];
      p.approvedAt = null;
    },
    expect: 'wake',
  },
  {
    id: 'lead→wake',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: leadInProgress },
      profile: { approvedAt: TS },
    },
    apply: (s, p) => {
      s.buildHistory = [];
      s.leadIntake = null;
      p.approvedAt = null;
    },
    expect: 'wake',
  },
  {
    id: 'lead_resume→wake',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: leadResume },
      profile: { approvedAt: TS },
    },
    apply: (s, p) => {
      s.buildHistory = [];
      s.leadIntake = null;
      p.approvedAt = null;
    },
    expect: 'wake',
  },
];

for (const edge of transitions) {
  const session = structuredClone(edge.from.session);
  const profile = structuredClone(edge.from.profile);
  assert.notEqual(ownerPhase(session, profile), edge.expect, `${edge.id} already at ${edge.expect}`);
  edge.apply(session, profile);
  try {
    assert.equal(ownerPhase(session, profile), edge.expect, edge.id);
  } catch (err) {
    failed += 1;
    console.error(err.message);
  }
}

if (failed) {
  console.error(`owner-phase: ${failed} failed`);
  process.exit(1);
}
console.log(`owner-phase: ${rows.length} cases + ${transitions.length} transitions passed`);
