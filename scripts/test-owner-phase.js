/**
 * Unit table for ownerPhase. Pins phase derivation only.
 * No handleMessage walks — setup-flow owns those.
 */
import assert from 'assert';
import { OWNER_PHASES, ownerPhase } from '../src/ownerPhase.js';

assert.deepEqual(
  [...OWNER_PHASES],
  ['wake', 'setup', 'ready', 'test', 'lead', 'lead_resume', 'chats', 'demo_offer']
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
    name: 'mid-setup: no approvedAt',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: null, draft: { askedTopics: [] } },
    expect: 'setup',
  },
  {
    id: 7,
    name: 'tell-me-more asked is still setup',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: {
      approvedAt: null,
      draft: {
        name: 'Ofir garage',
        whatWeDo: 'Garage',
        askedTopics: ['businessDetails'],
      },
    },
    expect: 'setup',
  },
  {
    id: 8,
    name: 'approvedAt is ready',
    session: { mode: 'BUILD', buildHistory: history, leadIntake: null },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'ready',
  },
  {
    id: 9,
    name: 'session omitted, approvedAt set → ready',
    session: null,
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'ready',
  },
  {
    id: 10,
    name: 'session omitted, no approvedAt → setup',
    session: null,
    profile: { approvedAt: null, draft: { askedTopics: [] } },
    expect: 'setup',
  },
  {
    id: 11,
    name: 'empty history + approvedAt is still wake',
    session: { mode: 'BUILD', buildHistory: [], leadIntake: null },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'wake',
  },
  {
    id: 12,
    name: 'BUILD review chats active is chats',
    session: {
      mode: 'BUILD',
      buildHistory: history,
      leadIntake: null,
      reviewChats: { active: true, snapshot: [], history: [] },
    },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'chats',
  },
  {
    id: 13,
    name: 'demo_origin + demo_start nav is demo_offer',
    session: {
      mode: 'BUILD',
      buildHistory: [{ role: 'assistant', content: 'hi', nav: 'demo_start' }],
      leadIntake: null,
      demoOrigin: true,
    },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'demo_offer',
  },
  {
    id: 14,
    name: 'demo_origin + empty history is wake',
    session: {
      mode: 'BUILD',
      buildHistory: [],
      leadIntake: null,
      demoOrigin: true,
    },
    profile: { approvedAt: null },
    expect: 'wake',
  },
  {
    id: 15,
    name: 'demo_origin + menu nav is ready',
    session: {
      mode: 'BUILD',
      buildHistory: [{ role: 'assistant', content: 'menu', nav: 'menu' }],
      leadIntake: null,
      demoOrigin: true,
    },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'ready',
  },
  {
    id: 16,
    name: 'TEST wins over demo_offer',
    session: {
      mode: 'TEST',
      buildHistory: [{ role: 'assistant', content: 'hi', nav: 'demo_start' }],
      leadIntake: null,
      demoOrigin: true,
    },
    profile: { approvedAt: '2026-01-01T00:00:00.000Z' },
    expect: 'test',
  },
];

let failed = 0;
for (const row of rows) {
  const got = ownerPhase(row.session, row.profile);
  try {
    assert.equal(got, row.expect, `#${row.id} ${row.name}`);
  } catch (err) {
    failed += 1;
    console.error(err.message);
  }
}

const TS = '2026-01-01T00:00:00.000Z';
const opened = [{ role: 'assistant', content: 'opening' }];

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
    id: 'setup→ready',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null },
      profile: { approvedAt: null, draft: { askedTopics: [] } },
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
      profile: { approvedAt: null },
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
      profile: { approvedAt: null },
    },
    apply: (s) => {
      s.mode = 'BUILD';
    },
    expect: 'setup',
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
    id: 'ready→chats',
    from: {
      session: { mode: 'BUILD', buildHistory: opened, leadIntake: null, reviewChats: null },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.reviewChats = { active: true, snapshot: [], history: [] };
    },
    expect: 'chats',
  },
  {
    id: 'chats→ready',
    from: {
      session: {
        mode: 'BUILD',
        buildHistory: opened,
        leadIntake: null,
        reviewChats: { active: true, snapshot: [], history: [] },
      },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.reviewChats = null;
    },
    expect: 'ready',
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
    id: 'wake→demo_offer',
    from: {
      session: { mode: 'BUILD', buildHistory: [], leadIntake: null, demoOrigin: false },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.demoOrigin = true;
      s.buildHistory = [{ role: 'assistant', content: 'opening', nav: 'demo_start' }];
    },
    expect: 'demo_offer',
  },
  {
    id: 'demo_offer→test',
    from: {
      session: {
        mode: 'BUILD',
        buildHistory: [{ role: 'assistant', content: 'opening', nav: 'demo_start' }],
        leadIntake: null,
        demoOrigin: true,
      },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.mode = 'TEST';
    },
    expect: 'test',
  },
  {
    id: 'demo_offer→ready',
    from: {
      session: {
        mode: 'BUILD',
        buildHistory: [{ role: 'assistant', content: 'opening', nav: 'demo_start' }],
        leadIntake: null,
        demoOrigin: true,
      },
      profile: { approvedAt: TS },
    },
    apply: (s) => {
      s.buildHistory = [{ role: 'assistant', content: 'menu', nav: 'menu' }];
    },
    expect: 'ready',
  },
  {
    id: 'demo_offer→wake',
    from: {
      session: {
        mode: 'BUILD',
        buildHistory: [{ role: 'assistant', content: 'opening', nav: 'demo_start' }],
        leadIntake: null,
        demoOrigin: true,
      },
      profile: { approvedAt: TS },
    },
    apply: (s, p) => {
      s.buildHistory = [];
      s.ownerName = null;
      p.approvedAt = null;
    },
    expect: 'wake',
  },
];

for (const row of transitions) {
  const session = structuredClone(row.from.session);
  const profile = structuredClone(row.from.profile);
  row.apply(session, profile);
  const got = ownerPhase(session, profile);
  try {
    assert.equal(got, row.expect, row.id);
  } catch (err) {
    failed += 1;
    console.error(err.message);
  }
}

if (failed) {
  console.error(`FAIL owner-phase: ${failed}`);
  process.exit(1);
}
console.log(`PASS owner-phase: ${rows.length} rows, ${transitions.length} transitions`);
