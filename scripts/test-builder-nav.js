/**
 * Deterministic editing-menu navigation tests through real handleMessage
 * with stubbed Builder turns (no network).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  customerOpeningText,
  emptyProfile,
  loadProfile,
  saveProfile,
  testProfilePath,
} from '../src/profile.js';
import { OFF_PURPOSE_OWNER_REPLY } from '../src/builder.js';
import {
  createSession,
  handleMessage,
  isExitTestCommand,
  ENTER_TEST_REPLY,
} from '../src/session.js';
import {
  interveningBuilderQuestion,
  isMenuRequest,
  isReviewNumberChoice,
  lastShownNav,
  menuActive,
  menuItems,
  parseMenuChoice,
  parseMenuItem,
  parseReviewChoice,
  renderMenu,
  renderReview,
  renderSavedChanges,
  reviewActive,
} from '../src/ownerNav.js';

const PROFILE = testProfilePath('builder-nav');
const MENU_HEAD = '2. 🏪 Tell me more about your business';
const FOOTER = 'Pick a number, or just tell me what you want me to learn.';

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

/** Review text minus the app's fixed "what would you like to do next?" line. */
function withoutOptionsPrompt(reply) {
  return String(reply).replace(/^What should we do next\?$/m, '');
}

function readRaw() {
  return fs.readFileSync(PROFILE, 'utf8');
}

function facts() {
  return {
    name: 'Studio Yoga',
    whatWeDo: 'Private yoga lessons in Tel Aviv',
    ownerGoal: 'answer_and_collect',
    services: [{ name: 'Private lesson', price: '200 ILS / 60 min', notes: null }],
    hours: 'Sun–Thu 8–18',
    locationOrArea: 'Tel Aviv',
    commonQuestions: [{ question: 'Beginners?', answer: 'Yes, beginners welcome.' }],
    informationToCollect: ['name', 'phone'],
    unknowns: [],
    tone: 'warm',
    priceDisclosure: 'on_request',
    openingMessage: null,
  };
}

function approvedProfile(overrides = {}) {
  const f = facts();
  return {
    ...emptyProfile(),
    ...f,
    approvedAt: '2026-01-01T00:00:00.000Z',
    draft: { ...f },
    ...overrides,
  };
}

function makeSession(turns) {
  const calls = { builder: 0 };
  let i = 0;
  const session = createSession({
    profilePath: PROFILE,
    deps: {
      runBuilderTurn: async () => {
        calls.builder += 1;
        const turn = turns[Math.min(i, turns.length - 1)];
        i += 1;
        return { source: 'stub-builder', ...turn };
      },
    },
  });
  return { session, calls };
}

function lastAssistant(session) {
  return [...session.buildHistory].reverse().find((m) => m.role === 'assistant');
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    results.push({ name, pass: false });
    console.log(`FAIL ${name}: ${err.message}`);
  }
}

/** Typed "approve" after a review is an ordinary Builder turn: nothing is approved. */
async function testTypedApproveIsBuilderTurn() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Thanks!', draft: f, readyForReview: true },
    { message: 'Great!', draft: f, readyForReview: false, approved: true },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run a yoga studio in Tel Aviv, private lessons');
  const r = await handleMessage(session, 'approve');
  assert.equal(r.event, 'build_turn');
  assert.equal(calls.builder, 2);
  assert.ok(loadProfile(PROFILE).approvedAt, 'first understood dump is already saved');
}

/** Section views (2–4 after approval) are read-only and show real values; numbers after a section go to the Builder. */
async function testSectionRoutingReadOnly() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session, calls } = makeSession([
    { message: 'ok', draft: facts(), readyForReview: false },
  ]);
  session.buildHistory.push({ role: 'user', content: 'Hi, I run a studio' });
  const before = readRaw();
  const m = await handleMessage(session, 'menu');
  assert.equal(m.event, 'menu');
  assert.ok(m.reply.includes(MENU_HEAD));
  const talks = await handleMessage(session, '4');
  assert.equal(talks.event, 'menu_section');
  assert.ok(talks.reply.startsWith('💬 This is how I talk to your customers right now:\n\n'), talks.reply);
  assert.ok(talks.reply.includes('*Style:* warm'), talks.reply);
  assert.ok(!talks.reply.includes('Reply length'), talks.reply);
  assert.ok(!talks.reply.includes('Price policy'), talks.reply);
  assert.ok(talks.reply.includes('*Opening message:*'), talks.reply);
  assert.ok(!talks.reply.includes('(default)'), talks.reply);
  assert.ok(
    talks.reply.trim().endsWith('What do you want to change?\nType *menu* to go back to the main menu.'),
    talks.reply
  );
  assert.equal(readRaw(), before, 'profile file must be unchanged by navigation');
  assert.equal(calls.builder, 0);

  // *menu* from a section returns to the main editing menu (like stop: exact word).
  const back = await handleMessage(session, '*menu*');
  assert.equal(back.event, 'menu');
  assert.ok(back.reply.startsWith('What should we do next?'), back.reply);
  assert.ok(back.reply.includes(MENU_HEAD), back.reply);
  assert.equal(calls.builder, 0, '*menu* must not reach the Builder');
  const please = await handleMessage(session, 'please menu');
  assert.equal(please.event, 'build_turn');
  assert.equal(calls.builder, 1, 'please menu must reach the Builder');

  // A number right after a section view is an answer, not a menu choice.
  await handleMessage(session, 'menu');
  await handleMessage(session, '4');
  await handleMessage(session, '3');
  assert.equal(calls.builder, 2, 'number after section view must reach the Builder');

  // Other sections render their own fields.
  await handleMessage(session, 'menu');
  const s1 = await handleMessage(session, '2');
  assert.ok(s1.reply.includes('Studio Yoga') && s1.reply.includes('200 ILS'), s1.reply);
  await handleMessage(session, 'menu');
  const s2 = await handleMessage(session, '3');
  assert.ok(s2.reply.includes('Yes, beginners welcome.'), s2.reply);
}

/** Free text after a section (other topic) goes to the Builder normally. */
async function testFreeTextAfterSection() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session, calls } = makeSession([
    { message: 'Updated the hours', draft: { ...facts(), hours: 'Sun–Fri 8–14' }, readyForReview: true },
  ]);
  session.buildHistory.push({ role: 'assistant', content: 'menu', nav: 'menu' });
  await handleMessage(session, '4');
  const r = await handleMessage(session, 'Change the hours to Sun–Fri 8–14');
  assert.equal(calls.builder, 1);
  assert.equal(r.event, 'build_turn');
  assert.equal(r.readyForReview, true);
  assert.equal(reviewActive(session.buildHistory), true, 'review offers two options');
  assert.equal(menuActive(session.buildHistory), false, 'full menu only after Make changes');
  assert.match(r.reply, /1\. 🤖 Chat with me like a customer\n2\. ✏️ Keep teaching me/);
  assert.ok(!r.reply.includes(MENU_HEAD), r.reply);
  assert.doesNotMatch(withoutOptionsPrompt(r.reply), /\?/);
}

/** After a review, a customer-style answer does not clear 1 / 2 / Try my bot. */
async function testReviewChoiceAfterInterveningAnswer() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: "A private lesson is 200 ILS.", draft: f, readyForReview: false },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  assert.equal(lastShownNav(session.buildHistory), 'review');
  const q = await handleMessage(session, 'how much is a private lesson?');
  assert.equal(q.event, 'build_turn');
  assert.equal(session.mode, 'BUILD');
  assert.equal(menuActive(session.buildHistory), true, 'non-question turn restores the menu');
  assert.equal(interveningBuilderQuestion(session.buildHistory), false);
  assert.equal(calls.builder, 2);

  const tryIt = await handleMessage(session, '5');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.equal(calls.builder, 2, '5 must not reach the Builder after a restored menu');
}

/** Same as above: option wording and 2 still follow the last shown review. */
async function testReviewWordsAndMakeChangesAfterAnswer() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: "A private lesson is 200 ILS.", draft: f, readyForReview: false },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  await handleMessage(session, 'how much is a private lesson?');
  const ch = await handleMessage(session, '2');
  assert.equal(ch.event, 'menu_section');
  assert.ok(ch.reply.includes('This is what I know about your business'), ch.reply);
  assert.equal(calls.builder, 2);
}

async function testTryMyBotWordsAfterAnswer() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: "A private lesson is 200 ILS.", draft: f, readyForReview: false },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  await handleMessage(session, 'how much is a private lesson?');
  assert.equal(menuActive(session.buildHistory), true);
  const tryIt = await handleMessage(session, 'chat with me like a customer');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.equal(calls.builder, 2);
}

/** Correction ack with no question: last shown review still accepts 1. */
async function testReviewChoiceAfterCorrectionAck() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: 'Got it, thanks!', draft: f, readyForReview: false },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  const ack = await handleMessage(session, 'the hours are already correct');
  assert.equal(ack.event, 'build_turn');
  assert.equal(menuActive(session.buildHistory), true);
  assert.equal(interveningBuilderQuestion(session.buildHistory), false);
  const tryIt = await handleMessage(session, '5');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(calls.builder, 2);
}

/** Courtesy closer with a ? still lets 1 enter Try my bot unless asksQuestion. */
async function testCourtesyCloserDoesNotBlockReviewNumber() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: "A private lesson is 200 ILS. Anything else?", draft: f, readyForReview: false },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  const q = await handleMessage(session, 'how much is a private lesson?');
  assert.equal(q.event, 'build_turn');
  assert.equal(interveningBuilderQuestion(session.buildHistory), false);
  const tryIt = await handleMessage(session, '5');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.equal(calls.builder, 2);
}

/** Intervening Builder question: bare 1/2 answer it; option wording still selects. */
async function testNumberAfterInterveningQuestionGoesToBuilder() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: 'How many instructors work there?', draft: f, readyForReview: false, asksQuestion: true },
    { message: 'Noted one instructor.', draft: f, readyForReview: true },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  await handleMessage(session, 'staff size');
  assert.equal(interveningBuilderQuestion(session.buildHistory), true);
  const ans = await handleMessage(session, '1');
  assert.equal(ans.event, 'build_turn');
  assert.equal(session.mode, 'BUILD');
  assert.equal(calls.builder, 3);
  assert.match(ans.reply, /1\. 🤖 Chat with me like a customer\n2\. ✏️ Keep teaching me/);
}

async function testTryMyBotWordsAfterInterveningQuestion() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: 'How many instructors work there?', draft: f, readyForReview: false, asksQuestion: true },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  await handleMessage(session, 'staff size');
  const tryIt = await handleMessage(session, 'chat with me like a customer');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.equal(calls.builder, 2);
}

/** Re-presenting the same draft shows the summary with no model line in front. */
async function testUnchangedReviewOmitsAck() {
  clean();
  const f = facts();
  const { session } = makeSession([
    { message: 'Got it, thanks!', draft: f, readyForReview: true },
    { message: '**Studio Yoga** is a yoga studio in Tel Aviv.', draft: f, readyForReview: true },
  ]);
  await handleMessage(session, 'hi');
  const first = await handleMessage(session, 'I run Studio Yoga');
  assert.ok(first.reply.startsWith('Got it, thanks!\n\n'), first.reply);
  const shown = await handleMessage(session, 'please show the current bot');
  assert.equal(shown.readyForReview, true);
  assert.ok(shown.reply.startsWith("Here's your bot for Studio Yoga:"), shown.reply);
  assert.ok(!shown.reply.includes('**Studio Yoga**'), shown.reply);
  assert.match(shown.reply, /1\. 🤖 Chat with me like a customer\n2\. ✏️ Keep teaching me/);
}

/** Numbers without menu context go to the Builder (e.g. a price answer). */
async function testNumberWithoutMenuContext() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session, calls } = makeSession([
    { message: 'What is the new price?', draft: facts(), readyForReview: false, asksQuestion: true },
  ]);
  session.buildHistory.push({ role: 'user', content: 'Hi' });
  await handleMessage(session, 'I want to change a price');
  await handleMessage(session, '3');
  assert.equal(calls.builder, 2);
  assert.equal(session.mode, 'BUILD');
}

/** Try my bot (5 after approval) → same path as /test (fresh session); stop → editing menu. */
async function testSixAndEnd() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'user', content: 'Hi' });
  await handleMessage(session, 'menu');
  const oldSid = session.testSessionId;
  await new Promise((r) => setTimeout(r, 2));
  const tryIt = await handleMessage(session, '5');
  assert.equal(tryIt.event, 'enter_test');
  const open = customerOpeningText(approvedProfile());
  assert.equal(tryIt.reply, `${ENTER_TEST_REPLY}\n\n${open}`);
  assert.doesNotMatch(tryIt.reply, /\/end/);
  assert.equal(session.mode, 'TEST');
  assert.notEqual(session.testSessionId, oldSid);
  const end = await handleMessage(session, 'stop');
  assert.equal(end.event, 'enter_build');
  assert.ok(end.reply.startsWith("I'm back! What should I learn next?"), end.reply);
  assert.ok(end.reply.includes(MENU_HEAD));
  assert.ok(!/BUILD mode/.test(end.reply));
  const talks = await handleMessage(session, '4');
  assert.equal(talks.event, 'menu_section');
}

/** Try my bot (5) on an already-approved profile enters TEST immediately. */
async function testSixEntersTestWhenApproved() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'assistant', content: 'menu', nav: 'menu' });
  const tryIt = await handleMessage(session, '5');
  assert.equal(tryIt.ok, true, tryIt.reply);
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.equal(loadProfile(PROFILE).approvedAt, '2026-01-01T00:00:00.000Z');
}

/** Section views show live current values; navigation does not write the profile. */
async function testPendingChangesPreserved() {
  clean();
  const p = approvedProfile();
  p.draft = { ...p.draft, tone: 'playful', priceDisclosure: 'relevant' };
  saveProfile(p, PROFILE);
  const before = readRaw();
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'user', content: 'hi, I run a yoga studio' });
  await handleMessage(session, 'menu');
  const talks = await handleMessage(session, '4');
  assert.ok(talks.reply.includes('💬 This is how I talk to your customers right now:'), talks.reply);
  assert.ok(talks.reply.includes('*Style:* warm'), talks.reply);
  assert.ok(!talks.reply.includes('Pending change'), talks.reply);
  await handleMessage(session, 'menu');
  const s1 = await handleMessage(session, '2');
  assert.ok(!s1.reply.includes('Pending change'), 'section shows current only');
  assert.equal(readRaw(), before, 'navigation must not save');
}

/** First-time setup: menu words and stop do not show the editing menu. */
async function testOnboardingPreserved() {
  clean();
  const { session, calls } = makeSession([
    { message: 'Tell me about the business', draft: {}, readyForReview: false },
  ]);
  const wake = await handleMessage(session, 'menu');
  assert.equal(wake.event, 'opening');
  assert.equal(calls.builder, 0, 'first message only wakes; discarded');
  await handleMessage(session, 'menu');
  assert.equal(calls.builder, 1, 'menu request before approval goes to the Builder');
  const end = await handleMessage(session, 'stop');
  assert.ok(!end.reply.includes(MENU_HEAD), end.reply);
  assert.equal(menuActive(session.buildHistory), false);
}

/** Editing menu and section labels. */
async function testMenuLabels() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'user', content: 'I run a yoga studio in Tel Aviv' });
  const end = await handleMessage(session, 'stop');
  assert.ok(end.reply.startsWith("I'm back! What should I learn next?"), end.reply);
  assert.ok(
    end.reply.endsWith(
      [
        '1. 🚀 Get me working for your business',
        '2. 🏪 Tell me more about your business',
        '3. ❓ Teach me more questions and answers',
        '4. 💬 Tell me how to talk to your customers',
        '5. 🤖 Chat with me like a customer',
        '',
        'Pick a number, or just tell me what you want me to learn.',
      ].join('\n')
    ),
    end.reply
  );
  const talks = await handleMessage(session, '4');
  assert.ok(talks.reply.startsWith('💬 This is how I talk to your customers right now:\n\n'), talks.reply);
  assert.ok(talks.reply.includes('*Style:* warm'), talks.reply);
  const biz = await handleMessage(session, 'menu');
  assert.ok(biz.reply.startsWith('What should we do next?'), biz.reply);
  const s1 = await handleMessage(session, '2');
  assert.ok(s1.reply.includes('*Price policy:* I share prices only when a customer asks'), s1.reply);
}

/** Menu request and menu number parsing. */
async function testMenuParseHelpers() {
  assert.equal(isMenuRequest('Menu'), true);
  assert.equal(isMenuRequest('*menu*'), true);
  assert.equal(isMenuRequest('*Menu*'), true);
  assert.equal(isMenuRequest('  *menu*  '), true);
  assert.equal(isMenuRequest('/menu'), true);
  assert.equal(isMenuRequest('show menu'), true);
  assert.equal(isMenuRequest('menu please'), false);
  assert.equal(isMenuRequest('please menu'), false);
  assert.equal(isMenuRequest('menu.'), false);
  assert.equal(isMenuRequest('change the menu prices'), false);
  assert.equal(parseMenuChoice(' 4. '), 4);
  assert.equal(parseMenuChoice('7'), null);
  assert.equal(parseMenuChoice('40'), null);
  assert.ok(renderMenu().endsWith(FOOTER));
}

/** First-time save card: changed lines + two options; 1 enters TEST. */
async function testFirstReviewTryApprovesAndTests() {
  clean();
  const f = facts();
  const { session } = makeSession([
    { message: 'Got it! Here is a summary:\n- Business Name: Studio Yoga\nReady to approve?', draft: f, readyForReview: true },
  ]);
  await handleMessage(session, 'hi');
  const review = await handleMessage(session, 'I run Studio Yoga in Tel Aviv');
  assert.equal(review.event, 'build_turn');
  assert.equal(review.readyForReview, true);
  assert.equal(reviewActive(session.buildHistory), true);
  assert.ok(review.reply.startsWith('Got it!\n\n'), review.reply);
  assert.match(review.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  assert.match(review.reply, /Business info: Private yoga lessons in Tel Aviv/);
  assert.doesNotMatch(review.reply, /\*\*/, 'no markdown bold');
  assert.doesNotMatch(review.reply, /\(was:/);
  assert.match(review.reply, /\nServices: Private lesson — 200 ILS \/ 60 min\n/);
  assert.match(review.reply, /\nI'll ask customers for: name, phone\n/);
  assert.match(review.reply, /\nHow I talk: warm\n/);
  assert.match(review.reply, /\nPrice policy: I share prices only when a customer asks\n/);
  assert.doesNotMatch(review.reply, /What your bot will do|contact you directly/);
  assert.match(review.reply, /1\. 🤖 Chat with me like a customer\n2\. ✏️ Keep teaching me/);
  assert.ok(!review.reply.includes('2. Edit Q&A'), 'full menu hidden until Make changes');
  assert.doesNotMatch(withoutOptionsPrompt(review.reply), /\?|Business Name:|Ready to approve/);
  assert.ok(loadProfile(PROFILE).approvedAt);

  const tryIt = await handleMessage(session, '1');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.ok(tryIt.reply.includes('chatting with me as a customer'), tryIt.reply);
  assert.ok(loadProfile(PROFILE).approvedAt);
}

/** "Make changes" shows the full editing menu; from there 5 is Try my bot. */
async function testMakeChangesShowsMenu() {
  clean();
  const f = facts();
  const { session } = makeSession([
    { message: 'Thanks!', draft: f, readyForReview: true },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  const before = readRaw();
  const ch = await handleMessage(session, 'keep teaching me');
  assert.equal(ch.event, 'menu');
  assert.ok(ch.reply.startsWith('What should we do next?'), ch.reply);
  assert.ok(ch.reply.includes('🏪 Tell me more about your business') && ch.reply.includes('🤖 Chat with me like a customer'), ch.reply);
  assert.equal(menuActive(session.buildHistory), true);
  assert.equal(readRaw(), before, 'Make changes must not save');
  const tryIt = await handleMessage(session, '5');
  assert.equal(tryIt.event, 'enter_test');
}

/** Later pending edit: review lists only what changes; 1 applies it then enters TEST. */
async function testTryApprovesPendingEdit() {
  clean();
  const f = facts();
  saveProfile(approvedProfile(), PROFILE);
  const pending = { ...f, hours: 'Sun–Fri 8–14' };
  const { session } = makeSession([
    { message: 'Updated the hours.', draft: pending, readyForReview: true },
  ]);
  session.buildHistory.push({ role: 'user', content: 'I run a yoga studio' });
  const review = await handleMessage(session, 'Change hours to Sun–Fri 8–14');
  assert.match(review.reply, /Got it, I'll remember that! 🌟 Here's what changed:\n\nHours: Sun–Fri 8–14\n\n/);
  assert.ok(!review.reply.includes('Studio Yoga'), 'unchanged facts not repeated');
  assert.equal(loadProfile(PROFILE).hours, 'Sun–Fri 8–14');

  const tryIt = await handleMessage(session, 'chat with me like a customer');
  assert.equal(tryIt.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.equal(loadProfile(PROFILE).hours, 'Sun–Fri 8–14');
}

async function testSectionsBeforeApprovalShowDraft() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Thanks!', draft: f, readyForReview: true },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  const before = readRaw();
  await handleMessage(session, '2');
  const s1 = await handleMessage(session, '2');
  assert.equal(s1.event, 'menu_section');
  assert.ok(s1.reply.includes('Studio Yoga') && s1.reply.includes('200 ILS'), s1.reply);
  assert.equal(readRaw(), before, 'section view must not save');
  assert.equal(calls.builder, 1);
  assert.ok(loadProfile(PROFILE).approvedAt);
}

async function testReviewRenderHelpers() {
  const p = { draft: { ...facts(), informationToCollect: [], tone: null, priceDisclosure: null } };
  const en = renderReview(p);
  assert.match(en, /Here's your bot for Studio Yoga:/);
  assert.match(en, /1\. 🤖 Chat with me like a customer\n2\. ✏️ Keep teaching me/);
  assert.match(en, /\nI'll ask customers for: nothing\n/);
  assert.match(en, /\nHow I talk: default\n/, 'unset settings shown as default');
  assert.match(en, /\nPrice policy: I mention prices when they're relevant\n/);
  // One line per item, in review-summary order.
  const labels = en
    .split('\n')
    .map((l) => l.split(':')[0])
    .filter((l) => ['Business info', 'Services', 'Area', 'Hours', 'Price policy', 'My goal', "I'll ask customers for", 'Q&A', 'How I talk'].includes(l));
  assert.deepEqual(labels, ['Business info', 'Services', 'Area', 'Hours', 'Price policy', 'My goal', "I'll ask customers for", 'Q&A', 'How I talk']);

  // Gaps are shown; review values are not clipped; legacy free-text goal reads as not set.
  const gaps = renderReview(
    { draft: { name: 'X', whatWeDo: 'a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(40), ownerGoal: 'help me sell', services: [], commonQuestions: [], informationToCollect: null } }
  );
  assert.match(gaps, /\nHours: not set \(I'll send them to you\)\n/);
  assert.match(gaps, /\nArea: not set \(I'll send them to you\)\n/);
  assert.match(gaps, /\nQ&A: none yet \(I'll send them to you\)\n/);
  assert.match(gaps, /\nMy goal: not set\n/);
  assert.match(gaps, /\nI'll ask customers for: not decided yet\n/);
  assert.match(gaps, /\nBusiness info: a{30} b{30} c{40}\n/);

  const manyServices = renderReview({
    draft: {
      name: 'Studio Yoga',
      whatWeDo: 'Lessons',
      services: [
        { name: "Women's cut", price: '$45', notes: null },
        { name: "Men's cut", price: '$30', notes: null },
        { name: "Kids' cut (under 10)", price: '$25', notes: null },
        { name: 'Blowout', price: '$35', notes: null },
        { name: 'Long or thick hair extra', price: '$15', notes: null },
      ],
      informationToCollect: [],
    },
  });
  assert.match(manyServices, /Women's cut — \$45/);
  assert.match(manyServices, /Men's cut — \$30/);
  assert.match(manyServices, /Kids' cut \(under 10\) — \$25/);
  assert.match(manyServices, /Blowout — \$35/);
  assert.match(manyServices, /Long or thick hair extra — \$15/);
  assert.doesNotMatch(manyServices, /…/);

  // Changes view: same labels; new values only (no previous-value suffix).
  const live = { ...facts(), approvedAt: '2026-01-01T00:00:00Z', hours: null };
  const changed = renderSavedChanges(live, {
    ...live,
    hours: 'Sun–Thu 9–18',
    services: [{ ...live.services[0], notes: 'new note' }],
    ownerGoal: 'answer_questions',
  });
  assert.match(changed, /\nHours: Sun–Thu 9–18\n/);
  assert.match(changed, /\nServices: Private lesson — 200 ILS \/ 60 min\n/);
  assert.doesNotMatch(changed, /\(was:|\(updated\)/);
  assert.match(changed, /\nMy goal: Answer customer questions/);
  assert.doesNotMatch(changed, /\nArea:/, 'unchanged lines hidden');
  assert.equal(parseReviewChoice('1'), 'try');
  assert.equal(parseReviewChoice('chat with me like a customer'), 'try');
  assert.equal(parseReviewChoice('2.'), 'change');
  assert.equal(parseReviewChoice('keep teaching me'), 'change');
  assert.equal(parseReviewChoice('3'), null);
  assert.equal(isReviewNumberChoice('1'), true);
  assert.equal(isReviewNumberChoice('2.'), true);
  assert.equal(isReviewNumberChoice('chat with me like a customer'), false);
  assert.equal(
    lastShownNav([
      { role: 'assistant', content: 'review', nav: 'review' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'A private lesson is 200 ILS.' },
    ]),
    'review'
  );
  assert.equal(
    interveningBuilderQuestion([
      { role: 'assistant', content: 'How many stylists do you have?', asksQuestion: true },
    ]),
    true
  );
  assert.equal(
    interveningBuilderQuestion([
      { role: 'assistant', content: "A women's cut is $45. Anything else?" },
    ]),
    false
  );
  assert.equal(
    interveningBuilderQuestion([
      { role: 'assistant', content: 'review', nav: 'review' },
      { role: 'assistant', content: 'Got it, thanks!' },
    ]),
    false
  );
}

/** Menu numbering per state: lead item first only when shown; numbers map to what is rendered. */
async function testMenuLayoutStates() {
  const lead = { leadOption: true };
  const noLead = { leadOption: false };
  assert.deepEqual(menuItems(lead), ['lead', 1, 2, 3, 'try']);
  assert.deepEqual(menuItems(noLead), [1, 2, 3, 'try']);
  assert.deepEqual(menuItems(), menuItems(noLead));
  for (const opts of [lead, noLead]) {
    const rendered = renderMenu(opts).split('\n').filter((l) => /^\d\. /.test(l));
    assert.equal(rendered.length, menuItems(opts).length);
    rendered.forEach((line, i) => {
      assert.ok(line.startsWith(`${i + 1}. `), line);
      assert.equal(parseMenuItem(String(i + 1), opts), menuItems(opts)[i]);
    });
  }
  assert.ok(renderMenu(noLead).startsWith('1. 🏪 Tell me more about your business\n'));
  assert.equal(parseMenuItem('1', lead), 'lead');
  assert.equal(parseMenuItem('2.', lead), 1);
  assert.equal(parseMenuItem('5', lead), 'try');
  assert.equal(parseMenuItem('1', noLead), 1);
  assert.equal(parseMenuItem('4', noLead), 'try');
  assert.equal(parseMenuItem('5', noLead), null);
  assert.equal(parseMenuItem('6', lead), null);
  assert.equal(parseMenuItem('0', lead), null);
  assert.equal(parseMenuItem('change Q&A', lead), null);
  const withLead = renderMenu(lead).split('\n');
  assert.equal(withLead[0], '1. 🚀 Get me working for your business');
  assert.equal(withLead[1], MENU_HEAD);
  assert.equal(withLead[4], '5. 🤖 Chat with me like a customer');
}

/** Owner asked to see the summary: app renderReview, never the model's invented text. */
async function testWantsReviewUsesRenderReview() {
  clean();
  const f = facts();
  const { session } = makeSession([
    {
      message:
        "Here's the updated summary for Studio Yoga:\nQ&A:\n- What are your prices? A private lesson is $99 invented.\nColor prices are given at the free consultation",
      draft: f,
      readyForReview: false,
      wantsReview: true,
    },
  ]);
  await handleMessage(session, 'hi');
  const r = await handleMessage(session, 'show me the updated summary');
  assert.equal(r.event, 'build_turn');
  assert.equal(reviewActive(session.buildHistory), true);
  assert.equal(lastShownNav(session.buildHistory), 'review');
  assert.match(r.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  assert.match(r.reply, /\nQ&A: 1 answer\n/);
  assert.doesNotMatch(r.reply, /updated summary|\$99 invented|Color prices are given|What are your prices\?|Here's your bot for/);
}

/** stop is an exact command (case/bold variants); /end stays a silent alias. */
async function testStopExitCommand() {
  assert.equal(isExitTestCommand('stop'), true);
  assert.equal(isExitTestCommand('Stop'), true);
  assert.equal(isExitTestCommand('STOP'), true);
  assert.equal(isExitTestCommand('  stop  '), true);
  assert.equal(isExitTestCommand('*stop*'), true);
  assert.equal(isExitTestCommand('*Stop*'), true);
  assert.equal(isExitTestCommand('  *stop*  '), true);
  assert.equal(isExitTestCommand('/end'), true);
  assert.equal(isExitTestCommand('/END'), true);
  assert.equal(isExitTestCommand('*/end*'), true);
  assert.equal(isExitTestCommand('please stop'), false);
  assert.equal(isExitTestCommand('stop now'), false);
  assert.equal(isExitTestCommand('stop.'), false);
  assert.equal(isExitTestCommand('*stop'), false);
  assert.equal(isExitTestCommand('stopping'), false);

  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'assistant', content: 'menu', nav: 'menu' });
  const entered = await handleMessage(session, '5');
  assert.equal(entered.event, 'enter_test');
  const bold = await handleMessage(session, '*stop*');
  assert.equal(bold.event, 'enter_build');
  assert.equal(session.mode, 'BUILD');

  const again = await handleMessage(session, '5');
  assert.equal(again.event, 'enter_test');
  const alias = await handleMessage(session, '/end');
  assert.equal(alias.event, 'enter_build');
  assert.doesNotMatch(alias.reply, /\/end/);
}

/** Without wantsReview or readyForReview, a model-written dump is not replaced. */
async function testNoWantsReviewKeepsModelMessage() {
  clean();
  const f = facts();
  const { session } = makeSession([
    {
      message: 'A private lesson is 200 ILS.',
      draft: f,
      readyForReview: false,
      wantsReview: false,
    },
  ]);
  await handleMessage(session, 'hi');
  const r = await handleMessage(session, 'how much is a lesson?');
  assert.equal(r.event, 'build_turn');
  assert.equal(lastShownNav(session.buildHistory), 'review');
  assert.match(r.reply, /Got it, I'll remember that! 🌟 Here's what changed:/);
  assert.ok(r.reply.includes('A private lesson is 200 ILS.'), r.reply);
}

/** Off-purpose: fixed reply, nothing saved, history untouched. */
async function testOffPurposeSavesNothing() {
  clean();
  const f = facts();
  saveProfile(approvedProfile(), PROFILE);
  const { session, calls } = makeSession([
    {
      message: 'Roses are red…',
      draft: { ...f, name: 'HACKED', whatWeDo: 'should not save' },
      newFacts: ['poem about the moon'],
      onPurpose: false,
      readyForReview: true,
      asksQuestion: true,
    },
  ]);
  session.buildHistory.push({ role: 'assistant', content: '(opened)' });
  session.buildHistory.push({ role: 'user', content: 'I run a yoga studio' });
  const historyBefore = structuredClone(session.buildHistory);
  const fileBefore = readRaw();
  const r = await handleMessage(session, 'Write me a poem about the moon');
  assert.equal(r.event, 'build_turn');
  assert.equal(r.reply, OFF_PURPOSE_OWNER_REPLY);
  assert.equal(r.onPurpose, false);
  assert.equal(calls.builder, 1);
  assert.deepEqual(session.buildHistory, historyBefore, 'history must stay untouched');
  assert.equal(readRaw(), fileBefore, 'profile must stay untouched');
  assert.equal(loadProfile(PROFILE).name, f.name);
}

async function main() {
  await test('typed_approve_is_builder_turn', testTypedApproveIsBuilderTurn);
  await test('section_routing_read_only', testSectionRoutingReadOnly);
  await test('free_text_after_section', testFreeTextAfterSection);
  await test('review_choice_after_intervening_answer', testReviewChoiceAfterInterveningAnswer);
  await test('review_words_and_make_changes_after_answer', testReviewWordsAndMakeChangesAfterAnswer);
  await test('try_my_bot_words_after_answer', testTryMyBotWordsAfterAnswer);
  await test('review_choice_after_correction_ack', testReviewChoiceAfterCorrectionAck);
  await test('courtesy_closer_does_not_block_review_number', testCourtesyCloserDoesNotBlockReviewNumber);
  await test('number_after_intervening_question_goes_to_builder', testNumberAfterInterveningQuestionGoesToBuilder);
  await test('try_my_bot_words_after_intervening_question', testTryMyBotWordsAfterInterveningQuestion);
  await test('unchanged_review_omits_ack', testUnchangedReviewOmitsAck);
  await test('number_without_menu_context', testNumberWithoutMenuContext);
  await test('six_and_end', testSixAndEnd);
  await test('stop_exit_command', testStopExitCommand);
  await test('six_enters_test_when_approved', testSixEntersTestWhenApproved);
  await test('pending_changes_preserved', testPendingChangesPreserved);
  await test('onboarding_preserved', testOnboardingPreserved);
  await test('menu_labels', testMenuLabels);
  await test('menu_parse_helpers', testMenuParseHelpers);
  await test('first_review_try_approves_and_tests', testFirstReviewTryApprovesAndTests);
  await test('make_changes_shows_menu', testMakeChangesShowsMenu);
  await test('try_approves_pending_edit', testTryApprovesPendingEdit);
  await test('sections_before_approval_show_draft', testSectionsBeforeApprovalShowDraft);
  await test('review_render_helpers', testReviewRenderHelpers);
  await test('wants_review_uses_render_review', testWantsReviewUsesRenderReview);
  await test('no_wants_review_keeps_model_message', testNoWantsReviewKeepsModelMessage);
  await test('menu_layout_states', testMenuLayoutStates);
  await test('off_purpose_saves_nothing', testOffPurposeSavesNothing);
  clean();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
