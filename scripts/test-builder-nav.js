/**
 * Deterministic editing-menu navigation tests through real handleMessage
 * with stubbed Builder turns and mocked Flowise (no network).
 */
import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { emptyProfile, loadProfile, saveProfile, testProfilePath } from '../src/profile.js';
import {
  createSenderSession,
  createSession,
  handleMessage,
  persistSenderSession,
} from '../src/session.js';
import {
  isMenuRequest,
  menuActive,
  ownerLanguage,
  parseMenuChoice,
  parseReviewChoice,
  renderMenu,
  renderReview,
  reviewActive,
} from '../src/ownerNav.js';
import { startFlowiseSyncWorker } from '../src/flowiseSyncWorker.js';
import { createMemoryStore } from '../src/store/memoryStore.js';

const PROFILE = testProfilePath('builder-nav');
const HE_MENU_HEAD = '1. פרטי העסק';
const HE_FOOTER = 'אפשר לבחור מספר או פשוט לכתוב מה רוצים לשנות.';

function clean() {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  if (fs.existsSync(PROFILE)) fs.unlinkSync(PROFILE);
}

/** Review text minus the app's fixed "what would you like to do next?" line. */
function withoutOptionsPrompt(reply) {
  return String(reply).replace(/^(What would you like to do next\?|מה תרצה לעשות עכשיו\?)$/m, '');
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
    responseLength: 'short',
    priceDisclosure: 'on_request',
    assistantName: 'Maya',
    openingMessage: null,
  };
}

function approvedProfile(overrides = {}) {
  const f = facts();
  return {
    ...emptyProfile(),
    ...f,
    approvedAt: '2026-01-01T00:00:00.000Z',
    chatflowId: 'cf-live',
    flowiseSyncOk: true,
    flowiseSyncedAt: '2026-01-01T00:00:00.000Z',
    draft: { ...f },
    ...overrides,
  };
}

function makeSession(turns, opts = {}) {
  const calls = { builder: 0, flowise: 0 };
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
      pingFlowise: async () => opts.flowiseUp !== false,
      wakeFlowise: async () => {},
      createOrUpdateChatflow: async () => {
        calls.flowise += 1;
        return 'cf-secret-123';
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

/** Onboarding (Hebrew) → review → approve → Hebrew success + menu, no infra details. */
async function testHebrewApproveShowsMenu() {
  clean();
  const f = facts();
  const { session } = makeSession([
    { message: 'הנה סיכום.', draft: f, readyForReview: true, approved: false },
    { message: 'מעולה!', draft: f, readyForReview: true, approved: true },
  ]);
  await handleMessage(session, 'hi'); // wake → opening (content discarded)
  await handleMessage(session, 'יש לי סטודיו ליוגה בתל אביב, שיעורים פרטיים');
  const r = await handleMessage(session, 'approve');
  assert.equal(r.event, 'approved_synced');
  assert.ok(r.reply.includes('הבוט עודכן ✅'), r.reply);
  assert.ok(r.reply.includes('אנחנו במצב עריכה'), r.reply);
  assert.ok(r.reply.includes(HE_MENU_HEAD) && r.reply.includes(HE_FOOTER), r.reply);
  assert.ok(!/flowise|chatflow|cf-secret/i.test(r.reply), r.reply);
  assert.equal(lastAssistant(session).nav, 'menu');
}

/** Sync not reachable → honest pending note, no success claim, no menu context. */
async function testPendingSyncNoSuccess() {
  clean();
  const f = facts();
  const { session } = makeSession(
    [
      { message: 'סיכום', draft: f, readyForReview: true, approved: false },
      { message: 'אוקיי', draft: f, readyForReview: true, approved: true },
    ],
    { flowiseUp: false }
  );
  await handleMessage(session, 'hi');
  await handleMessage(session, 'יש לי סטודיו ליוגה');
  const r = await handleMessage(session, 'approve');
  assert.equal(r.event, 'approved_sync_pending');
  assert.ok(!r.reply.includes('הבוט עודכן'), r.reply);
  assert.ok(!r.reply.includes(HE_MENU_HEAD), r.reply);
  assert.equal(menuActive(session.buildHistory), false);
}

/** Section 1–5 views are read-only and show real values; numbers after a section go to the Builder. */
async function testSectionRoutingReadOnly() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session, calls } = makeSession([
    { message: 'ok', draft: facts(), readyForReview: false, approved: false },
  ]);
  session.buildHistory.push({ role: 'user', content: 'שלום, יש לי סטודיו' });
  const before = readRaw();
  const m = await handleMessage(session, 'תפריט');
  assert.equal(m.event, 'menu');
  assert.ok(m.reply.includes(HE_MENU_HEAD));
  const s4 = await handleMessage(session, '4');
  assert.equal(s4.event, 'menu_section');
  assert.ok(s4.reply.includes('סגנון: warm'), s4.reply);
  assert.ok(s4.reply.includes('אורך תשובות: קצרות'), s4.reply);
  assert.ok(s4.reply.includes('מחירים: רק כשהלקוח שואל על מחיר'), s4.reply);
  assert.ok(s4.reply.trim().endsWith('מה תרצה לשנות?'), s4.reply);
  assert.equal(readRaw(), before, 'profile file must be unchanged by navigation');
  assert.equal(calls.builder, 0);

  // A number right after a section view is an answer, not a menu choice.
  await handleMessage(session, '4');
  assert.equal(calls.builder, 1, 'number after section view must reach the Builder');

  // Other sections render their own fields.
  await handleMessage(session, 'menu');
  const s1 = await handleMessage(session, '1');
  assert.ok(s1.reply.includes('Studio Yoga') && s1.reply.includes('200 ILS'), s1.reply);
  await handleMessage(session, 'menu');
  const s2 = await handleMessage(session, '2');
  assert.ok(s2.reply.includes('name, phone'), s2.reply);
  await handleMessage(session, 'menu');
  const s3 = await handleMessage(session, '3');
  assert.ok(s3.reply.includes('Yes, beginners welcome.'), s3.reply);
  await handleMessage(session, 'menu');
  const s5 = await handleMessage(session, '5');
  assert.ok(s5.reply.includes('Maya') && s5.reply.includes('(ברירת מחדל)'), s5.reply);
}

/** Free text after a section (other topic) goes to the Builder normally. */
async function testFreeTextAfterSection() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session, calls } = makeSession([
    { message: 'עדכנתי את השעות', draft: { ...facts(), hours: 'Sun–Fri 8–14' }, readyForReview: true, approved: false },
  ]);
  session.buildHistory.push({ role: 'assistant', content: 'menu', nav: 'menu' });
  await handleMessage(session, '4');
  const r = await handleMessage(session, 'תשנה את השעות לראשון עד שישי 8–14');
  assert.equal(calls.builder, 1);
  assert.equal(r.event, 'build_turn');
  assert.equal(r.readyForReview, true);
  assert.equal(reviewActive(session.buildHistory), true, 'review offers two options');
  assert.equal(menuActive(session.buildHistory), false, 'full menu only after Make changes');
  assert.match(r.reply, /1\. לנסות את הבוט\n2\. לעשות שינויים/);
  assert.ok(!r.reply.includes(HE_MENU_HEAD), r.reply);
  assert.doesNotMatch(withoutOptionsPrompt(r.reply), /\?/);
}

/** Numbers without menu context go to the Builder (e.g. a price answer). */
async function testNumberWithoutMenuContext() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session, calls } = makeSession([
    { message: 'מה המחיר החדש?', draft: facts(), readyForReview: false, approved: false },
  ]);
  session.buildHistory.push({ role: 'user', content: 'שלום' });
  await handleMessage(session, 'אני רוצה לשנות מחיר');
  await handleMessage(session, '3');
  assert.equal(calls.builder, 2);
  assert.equal(session.mode, 'BUILD');
}

/** 6 → same path as /test (fresh session); /end → Hebrew editing menu. */
async function testSixAndEnd() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'user', content: 'שלום' });
  await handleMessage(session, 'תפריט');
  const oldSid = session.testSessionId;
  await new Promise((r) => setTimeout(r, 2));
  const six = await handleMessage(session, '6');
  assert.equal(six.event, 'enter_test');
  assert.equal(session.mode, 'TEST');
  assert.notEqual(session.testSessionId, oldSid);
  const end = await handleMessage(session, '/end');
  assert.equal(end.event, 'enter_build');
  assert.ok(end.reply.startsWith('חזרנו למצב עריכה. מה תרצה לעשות?'), end.reply);
  assert.ok(end.reply.includes(HE_MENU_HEAD));
  assert.ok(!/BUILD mode|flowise/i.test(end.reply));
  const s5 = await handleMessage(session, '5');
  assert.equal(s5.event, 'menu_section');
}

/** 6 keeps /test prerequisites: unsynced profile stays in BUILD with the existing reason. */
async function testSixRespectsSyncGate() {
  clean();
  saveProfile(approvedProfile({ flowiseSyncOk: false }), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'assistant', content: 'menu', nav: 'menu' });
  const six = await handleMessage(session, '6');
  const slash = await handleMessage(session, '/test');
  assert.equal(six.ok, false);
  assert.equal(session.mode, 'BUILD');
  assert.equal(six.reply, slash.reply);
}

/** Pending draft: section shows live vs pending; navigation keeps draft + review key. */
async function testPendingChangesPreserved() {
  clean();
  const p = approvedProfile({ reviewedDraftKey: 'review-key-1' });
  p.draft = { ...p.draft, tone: 'playful', priceDisclosure: 'relevant' };
  saveProfile(p, PROFILE);
  const before = readRaw();
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'user', content: 'hi, I run a yoga studio' });
  await handleMessage(session, 'menu');
  const s4 = await handleMessage(session, '4');
  assert.ok(s4.reply.includes('Live now:') && s4.reply.includes('Pending change'), s4.reply);
  assert.ok(s4.reply.includes('Style: warm') && s4.reply.includes('Style: playful'), s4.reply);
  await handleMessage(session, 'menu');
  const s1 = await handleMessage(session, '1');
  assert.ok(!s1.reply.includes('Pending change'), 'unchanged section shows current only');
  assert.equal(readRaw(), before, 'draft and reviewedDraftKey unchanged');
}

/** First-time setup: menu words and /end do not show the editing menu. */
async function testOnboardingPreserved() {
  clean();
  const { session, calls } = makeSession([
    { message: 'ספר לי על העסק', draft: {}, readyForReview: false, approved: false },
  ]);
  const wake = await handleMessage(session, 'תפריט');
  assert.equal(wake.event, 'opening');
  assert.equal(calls.builder, 0, 'first message only wakes; discarded');
  await handleMessage(session, 'תפריט');
  assert.equal(calls.builder, 1, 'menu request before approval goes to the Builder');
  const end = await handleMessage(session, '/end');
  assert.ok(!end.reply.includes(HE_MENU_HEAD), end.reply);
  assert.equal(menuActive(session.buildHistory), false);
}

/** English owner → English menu and section labels. */
async function testEnglishOwner() {
  clean();
  saveProfile(approvedProfile(), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'user', content: 'I run a yoga studio in Tel Aviv' });
  const end = await handleMessage(session, '/end');
  assert.ok(end.reply.startsWith('Back in editing mode. What would you like to do?'), end.reply);
  assert.ok(end.reply.includes('1. Business\n'));
  assert.ok(end.reply.includes('6. Try my bot'));
  const s4 = await handleMessage(session, '4');
  assert.ok(s4.reply.includes('Prices: only when the customer asks about pricing'), s4.reply);
}

/** Language helpers: approve / commands / numbers skipped; business data never consulted. */
async function testLanguageHelpers() {
  const he = [
    { role: 'user', content: 'יש לי מספרה' },
    { role: 'assistant', content: 'Great! What services?' },
    { role: 'user', content: 'approve' },
    { role: 'user', content: '4' },
    { role: 'user', content: '/test' },
  ];
  assert.equal(ownerLanguage(he), 'he');
  assert.equal(ownerLanguage([{ role: 'assistant', content: 'שלום' }]), 'en');
  assert.equal(ownerLanguage([{ role: 'user', content: 'Change the hours please' }]), 'en');
  assert.equal(isMenuRequest('Menu'), true);
  assert.equal(isMenuRequest('תפריט בבקשה'), true);
  assert.equal(isMenuRequest('change the menu prices'), false);
  assert.equal(parseMenuChoice(' 4. '), 4);
  assert.equal(parseMenuChoice('7'), null);
  assert.equal(parseMenuChoice('40'), null);
  assert.ok(renderMenu('he').endsWith(HE_FOOTER));
}

/** First-time review: prose summary + two options, no questions, no field dump; 1 approves then TEST. */
async function testFirstReviewTryApprovesAndTests() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Got it! Here is a summary:\n- Business Name: Studio Yoga\nReady to approve?', draft: f, readyForReview: true, approved: false },
  ]);
  await handleMessage(session, 'hi');
  const review = await handleMessage(session, 'I run Studio Yoga in Tel Aviv');
  assert.equal(review.event, 'build_turn');
  assert.equal(review.readyForReview, true);
  assert.equal(reviewActive(session.buildHistory), true);
  assert.ok(review.reply.startsWith('Got it!\n\n'), review.reply);
  assert.match(review.reply, /Here's your bot for Studio Yoga:\n\nBusiness: /);
  assert.doesNotMatch(review.reply, /\*\*/, 'no markdown bold');
  assert.match(review.reply, /\nServices: Private lesson — 200 ILS \/ 60 min\n/);
  assert.match(review.reply, /\nAsks customers for: name, phone\n/);
  assert.match(review.reply, /\nStyle: [^\n]*prices only when asked/);
  assert.doesNotMatch(review.reply, /What your bot will do|contact you directly/);
  assert.match(review.reply, /1\. Try my bot\n2\. Make changes/);
  assert.ok(!review.reply.includes('2. Bot goal'), 'full menu hidden until Make changes');
  assert.doesNotMatch(withoutOptionsPrompt(review.reply), /\?|Business Name:|Ready to approve/);
  assert.equal(loadProfile(PROFILE).approvedAt, null);

  const tryIt = await handleMessage(session, '1');
  assert.equal(tryIt.event, 'approved_enter_test');
  assert.equal(session.mode, 'TEST');
  assert.ok(tryIt.reply.includes('Bot updated ✅'), tryIt.reply);
  assert.ok(tryIt.reply.includes('TEST mode'), tryIt.reply);
  assert.ok(loadProfile(PROFILE).approvedAt);
  assert.equal(loadProfile(PROFILE).flowiseSyncOk, true);
  assert.equal(calls.flowise, 1);
}

/** "Make changes" shows the full editing menu; from there 6 still approves + tests. */
async function testMakeChangesShowsMenu() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Thanks!', draft: f, readyForReview: true, approved: false },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  const before = readRaw();
  const ch = await handleMessage(session, 'Make changes');
  assert.equal(ch.event, 'menu');
  assert.ok(ch.reply.startsWith('What would you like to change?'), ch.reply);
  assert.ok(ch.reply.includes('1. Business\n') && ch.reply.includes('6. Try my bot'), ch.reply);
  assert.equal(menuActive(session.buildHistory), true);
  assert.equal(readRaw(), before, 'Make changes must not save');
  const six = await handleMessage(session, '6');
  assert.equal(six.event, 'approved_enter_test');
  assert.equal(calls.flowise, 1);
}

/** Later pending edit: review lists only what changes; 1 applies it then enters TEST. */
async function testTryApprovesPendingEdit() {
  clean();
  const f = facts();
  saveProfile(approvedProfile(), PROFILE);
  const pending = { ...f, hours: 'Sun–Fri 8–14' };
  const { session, calls } = makeSession([
    { message: 'Updated the hours.', draft: pending, readyForReview: true, approved: false },
  ]);
  session.buildHistory.push({ role: 'user', content: 'I run a yoga studio' });
  const review = await handleMessage(session, 'Change hours to Sun–Fri 8–14');
  assert.match(review.reply, /Here's what will change:\n\nHours: Sun–Fri 8–14 \(was: Sun–Thu 8–18\)\n\n/);
  assert.ok(!review.reply.includes('Studio Yoga'), 'unchanged facts not repeated');
  assert.equal(loadProfile(PROFILE).hours, 'Sun–Thu 8–18');

  const tryIt = await handleMessage(session, 'Try my bot');
  assert.equal(tryIt.event, 'approved_enter_test');
  assert.equal(session.mode, 'TEST');
  assert.equal(loadProfile(PROFILE).hours, 'Sun–Fri 8–14');
  assert.equal(calls.flowise, 1);
}

/** 6 with no pending review uses the normal /test path (refusal when unsynced). */
async function testSixWithoutPendingReview() {
  clean();
  saveProfile(approvedProfile({ flowiseSyncOk: false }), PROFILE);
  const { session } = makeSession([{ message: 'x', draft: facts() }]);
  session.buildHistory.push({ role: 'assistant', content: 'menu', nav: 'menu' });
  const six = await handleMessage(session, '6');
  assert.equal(six.ok, false);
  assert.equal(session.mode, 'BUILD');
  assert.equal(loadProfile(PROFILE).approvedAt, '2026-01-01T00:00:00.000Z');
}

/** Before approval, Make changes → 1–5 show draft values and do not save. */
async function testSectionsBeforeApprovalShowDraft() {
  clean();
  const f = facts();
  const { session, calls } = makeSession([
    { message: 'Thanks!', draft: f, readyForReview: true, approved: false },
  ]);
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga');
  const before = readRaw();
  await handleMessage(session, '2');
  const s1 = await handleMessage(session, '1');
  assert.equal(s1.event, 'menu_section');
  assert.ok(s1.reply.includes('Studio Yoga') && s1.reply.includes('200 ILS'), s1.reply);
  assert.equal(readRaw(), before, 'section view must not save');
  assert.equal(calls.builder, 1);
  assert.equal(loadProfile(PROFILE).approvedAt, null);
}

/** Sync pending on Try my bot: waking-up note, stay in BUILD. */
async function testTrySyncPendingStaysInBuild() {
  clean();
  const f = facts();
  const { session } = makeSession(
    [{ message: 'Ready.', draft: f, readyForReview: true, approved: false }],
    { flowiseUp: false }
  );
  await handleMessage(session, 'hi');
  await handleMessage(session, 'I run Studio Yoga in Tel Aviv');
  const tryIt = await handleMessage(session, '1');
  assert.equal(tryIt.event, 'approved_sync_pending');
  assert.equal(session.mode, 'BUILD');
  assert.ok(tryIt.reply.includes('Try my bot'), tryIt.reply);
  assert.ok(loadProfile(PROFILE).approvedAt);
  assert.equal(loadProfile(PROFILE).flowiseSyncOk, false);
  assert.equal(loadProfile(PROFILE).flowiseSyncPending, true);
}

/** Review render: Hebrew prose + options; empty intake wording; review phrase parsing. */
async function testReviewRenderHelpers() {
  const p = { draft: { ...facts(), informationToCollect: [], tone: null, responseLength: null, priceDisclosure: null, assistantName: null } };
  const he = renderReview(p, 'he');
  assert.match(he, /זה הבוט שלך עבור Studio Yoga:/);
  assert.match(he, /1\. לנסות את הבוט\n2\. לעשות שינויים/);
  const en = renderReview(p, 'en');
  assert.match(en, /\nAsks customers for: nothing\n/);
  assert.match(en, /\nStyle: default\nName & opening: default\n/, 'unset settings shown as default');
  // One line per item, in editing-menu order.
  const labels = en
    .split('\n')
    .map((l) => l.split(':')[0])
    .filter((l) => ['Business', 'Services', 'Area', 'Hours', 'Bot goal', 'Asks customers for', 'Q&A', 'Style', 'Name & opening'].includes(l));
  assert.deepEqual(labels, ['Business', 'Services', 'Area', 'Hours', 'Bot goal', 'Asks customers for', 'Q&A', 'Style', 'Name & opening']);

  // Gaps are shown; long values trimmed; legacy free-text goal reads as not set.
  const gaps = renderReview(
    { draft: { name: 'X', whatWeDo: 'a'.repeat(30) + ' ' + 'b'.repeat(30) + ' ' + 'c'.repeat(40), ownerGoal: 'help me sell', services: [], commonQuestions: [], informationToCollect: null } },
    'en'
  );
  assert.match(gaps, /\nHours: not set \(bot refers customers to you\)\n/);
  assert.match(gaps, /\nArea: not set \(bot refers customers to you\)\n/);
  assert.match(gaps, /\nQ&A: none yet \(bot refers customers to you\)\n/);
  assert.match(gaps, /\nBot goal: not set\n/);
  assert.match(gaps, /\nAsks customers for: not decided yet\n/);
  assert.match(gaps, /\nBusiness: a{30} b{30}…\n/);

  // Changes view: same labels; hidden edits marked (updated); gap note not repeated in "was".
  const live = { ...facts(), approvedAt: '2026-01-01T00:00:00Z', hours: null };
  const changed = renderReview(
    {
      ...live,
      draft: {
        ...live,
        hours: 'Sun–Thu 9–18',
        services: [{ ...live.services[0], notes: 'new note' }],
        ownerGoal: 'answer_questions',
      },
    },
    'en'
  );
  assert.match(changed, /\nHours: Sun–Thu 9–18 \(was: not set\)/);
  assert.match(changed, /\nServices: [^\n]* \(updated\)/);
  assert.match(changed, /\nBot goal: Answer customer questions/);
  assert.doesNotMatch(changed, /\nArea:/, 'unchanged lines hidden');
  assert.equal(parseReviewChoice('1'), 'try');
  assert.equal(parseReviewChoice('Try my bot'), 'try');
  assert.equal(parseReviewChoice('2.'), 'change');
  assert.equal(parseReviewChoice('לעשות שינויים'), 'change');
  assert.equal(parseReviewChoice('3'), null);
}

/** Background worker: BUILD → success + menu context; TEST → no editing claim, no menu. */
async function testWorkerRespectsMode() {
  for (const mode of ['BUILD', 'TEST']) {
    const store = createMemoryStore();
    const sender = `web:nav-${mode}`;
    const session = await createSenderSession(store, sender);
    session.mode = mode;
    session.buildHistory.push({ role: 'user', content: 'יש לי סטודיו ליוגה' });
    await persistSenderSession(session);
    await store.saveProfile(sender, {
      ...approvedProfile({ flowiseSyncOk: false, chatflowId: null }),
      flowiseSyncPending: true,
      flowiseSyncRequestedAt: new Date().toISOString(),
    });
    const runner = startFlowiseSyncWorker(store, {
      intervalMs: 60000,
      deps: {
        pingFlowise: async () => true,
        wakeFlowise: async () => {},
        createOrUpdateChatflow: async () => 'cf-secret-456',
      },
    });
    await runner.tick();
    runner.stop();
    const after = await store.loadSession(sender);
    const last = after.buildHistory[after.buildHistory.length - 1];
    const profile = await store.loadProfile(sender);
    assert.equal(profile.flowiseSyncOk, true);
    assert.ok(last.content.includes('הבוט עודכן ✅'), last.content);
    assert.ok(!/flowise|chatflow|cf-secret/i.test(last.content), last.content);
    assert.equal(after.mode, mode);
    if (mode === 'BUILD') {
      assert.equal(last.nav, 'menu');
      assert.ok(last.content.includes('אנחנו במצב עריכה') && last.content.includes(HE_MENU_HEAD));
    } else {
      assert.equal(last.nav, undefined);
      assert.ok(!last.content.includes('אנחנו במצב עריכה'), last.content);
      assert.ok(!last.content.includes(HE_MENU_HEAD), last.content);
      assert.equal(menuActive(after.buildHistory), false);
    }
  }
}

async function main() {
  await test('approve_hebrew_menu', testHebrewApproveShowsMenu);
  await test('pending_sync_no_success', testPendingSyncNoSuccess);
  await test('section_routing_read_only', testSectionRoutingReadOnly);
  await test('free_text_after_section', testFreeTextAfterSection);
  await test('number_without_menu_context', testNumberWithoutMenuContext);
  await test('six_and_end', testSixAndEnd);
  await test('six_respects_sync_gate', testSixRespectsSyncGate);
  await test('pending_changes_preserved', testPendingChangesPreserved);
  await test('onboarding_preserved', testOnboardingPreserved);
  await test('english_owner', testEnglishOwner);
  await test('language_helpers', testLanguageHelpers);
  await test('first_review_try_approves_and_tests', testFirstReviewTryApprovesAndTests);
  await test('make_changes_shows_menu', testMakeChangesShowsMenu);
  await test('try_approves_pending_edit', testTryApprovesPendingEdit);
  await test('six_without_pending_review', testSixWithoutPendingReview);
  await test('sections_before_approval_show_draft', testSectionsBeforeApprovalShowDraft);
  await test('try_sync_pending_stays_in_build', testTrySyncPendingStaysInBuild);
  await test('review_render_helpers', testReviewRenderHelpers);
  await test('worker_respects_mode', testWorkerRespectsMode);
  clean();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
