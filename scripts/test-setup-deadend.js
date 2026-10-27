/**
 * Setup interview: a no-question reply cannot dead-end, skip after
 * tell-me-more presents ready_first, and "ok" after first ready is the
 * editing menu (model text kept) — not a leftover Here's-your-bot card.
 *
 * No network. Stubbed Builder turns.
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import { applyReviewGate } from '../src/builder.js';
import { IDENTITY_FALLBACK_QUESTION } from '../src/setupAgenda.js';
import {
  BUSINESS_DETAILS_ACK,
  businessDetailsQuestion,
} from '../src/builderTopics.js';
import { composeReply } from '../src/composeReply.js';
import { READY_OPENER } from '../src/copy.js';
import { createSession, handleMessage } from '../src/session.js';
import { lastShownNav } from '../src/ownerNav.js';

const PROFILE = testProfilePath('setup-deadend');
const NAME = 'Pixel Fix';
const WHAT = 'We repair phones and laptops';
const LEGACY_CARD = "Here's your bot";

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

function pixelDraft(overrides = {}) {
  return {
    name: NAME,
    whatWeDo: WHAT,
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    unknowns: [],
    tone: null,
    priceDisclosure: null,
    openingMessage: null,
    askedTopics: ['businessDetails'],
    ...overrides,
  };
}

function setupProfile(draft, extras = {}) {
  return {
    ...emptyProfile(),
    ...draft,
    approvedAt: null,
    draft: { ...draft },
    ...extras,
  };
}

function modelTurn(draft, overrides = {}) {
  return {
    message: `${NAME} repairs phones and laptops ✨`,
    draft,
    readyForReview: false,
    wantsReview: false,
    asksQuestion: true,
    askingTopic: null,
    onPurpose: true,
    source: 'stub-builder',
    ...overrides,
  };
}

function expectedReadyFirst() {
  return composeReply({ kind: 'ready_first', menuOpts: { leadOption: false } }).reply;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, pass: false, error: err.message });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

await test('no-? ack before name attaches identity fallback', () => {
  const draft = {
    name: null,
    whatWeDo: 'A small coffee shop with pastries',
    services: [],
    hours: null,
    locationOrArea: null,
    commonQuestions: [],
    informationToCollect: null,
    askedTopics: [],
  };
  const gated = applyReviewGate(
    setupProfile(draft),
    modelTurn(draft, {
      message: 'A cozy coffee shop with pastries sounds lovely ✨',
      asksQuestion: false,
    }),
    'Cafe Noam, a small coffee shop with pastries'
  );
  assert.equal(
    gated.message,
    `A cozy coffee shop with pastries sounds lovely ✨\n\n${IDENTITY_FALLBACK_QUESTION}`
  );
  assert.equal(gated.presentReview, false);
  assert.ok(!gated.draft.askedTopics.includes('businessDetails'));
});

await test('skip after tell-me-more presents ready_first, nav menu', async () => {
  const draft = pixelDraft();
  clean();
  saveProfile(setupProfile(draft), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, {
          message: `${NAME} repairs phones and laptops ✨`,
          asksQuestion: false,
          topicResponse: 'skipped',
        }),
    },
  });
  session.mode = 'BUILD';
  session.buildHistory = [
    {
      role: 'assistant',
      content: `${BUSINESS_DETAILS_ACK}\n\n${businessDetailsQuestion(draft)}`,
      asksQuestion: true,
    },
  ];

  const out = await handleMessage(session, 'skip');
  assert.equal(out.ok, true);
  assert.equal(out.reply, expectedReadyFirst());
  assert.ok(out.reply.startsWith(READY_OPENER), out.reply);
  assert.ok(out.reply.includes('🏪 Tell me more about your business'));
  assert.doesNotMatch(out.reply, /Here's your bot for/);
  assert.ok(loadProfile(PROFILE).approvedAt, 'approvedAt must be written on the ready turn');
  assert.equal(lastShownNav(session.buildHistory), 'menu');
});

await test('ok after first ready is the editing menu, not the old card', async () => {
  const draft = pixelDraft();
  clean();
  saveProfile(setupProfile(draft), PROFILE);
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, {
          message: `${NAME} repairs phones and laptops ✨`,
          asksQuestion: false,
          topicResponse: 'skipped',
        }),
    },
  });
  session.mode = 'BUILD';
  session.buildHistory = [
    {
      role: 'assistant',
      content: `${BUSINESS_DETAILS_ACK}\n\n${businessDetailsQuestion(draft)}`,
      asksQuestion: true,
    },
  ];

  const first = await handleMessage(session, 'skip');
  assert.ok(first.reply.startsWith(READY_OPENER), first.reply);
  assert.ok(loadProfile(PROFILE).approvedAt);

  const session2 = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () =>
        modelTurn(draft, {
          message: 'Here is your bot again.',
          asksQuestion: false,
        }),
    },
  });
  session2.mode = 'BUILD';
  session2.buildHistory = [
    { role: 'assistant', content: first.reply, nav: 'menu' },
  ];

  const ok = await handleMessage(session2, 'ok');
  assert.equal(ok.ok, true);
  assert.ok(ok.reply.startsWith('Here is your bot again.'), ok.reply);
  assert.match(ok.reply, /🏪 Tell me more about your business/);
  assert.doesNotMatch(ok.reply, /Here's your bot for/);
  assert.doesNotMatch(ok.reply, /Business info:/);
  assert.doesNotMatch(ok.reply, /How I talk: default/);
  assert.ok(!ok.reply.includes(LEGACY_CARD));
  assert.equal(lastShownNav(session2.buildHistory), 'menu');
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
