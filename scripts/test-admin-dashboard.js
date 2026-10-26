/**
 * Deterministic admin dashboard tests — no network, no OpenAI.
 * Run: node scripts/test-admin-dashboard.js  (also part of npm test)
 */
import assert from 'assert';
import express from 'express';
import { createMemoryStore } from '../src/store/memoryStore.js';
import { createAdminRouter } from '../src/admin/router.js';
import { emptyProfile } from '../src/profile.js';
import {
  COOKIE_MAX_AGE_MS,
  LOGIN_MAX_FAILURES,
  _resetRateLimitForTests,
  cookieHeader,
  passwordsEqual,
} from '../src/admin/auth.js';
import { deriveStage } from '../src/admin/stage.js';

const PASSWORD = 'test-admin-password-for-suite';

async function withAdmin(store, fn, { password = PASSWORD } = {}) {
  const prev = process.env.ADMIN_PASSWORD;
  if (password == null) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = password;
  _resetRateLimitForTests();
  const app = express();
  app.use(express.json());
  app.post('/api/chat', (_req, res) => res.json({ ok: true, source: 'chat' }));
  app.use('/admin', createAdminRouter(store));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    await fn({ origin, store });
  } finally {
    await new Promise((r) => server.close(r));
    if (prev == null) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prev;
    _resetRateLimitForTests();
  }
}

async function req(origin, path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.referer) headers.Referer = opts.referer;
  if (opts.cookie) headers.Cookie = opts.cookie;
  let body = opts.body;
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`${origin}${path}`, {
    method: opts.method || 'GET',
    headers,
    body,
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json, setCookie: res.headers.get('set-cookie') };
}

function cookieFrom(setCookie) {
  assert.ok(setCookie, 'expected Set-Cookie');
  return String(setCookie).split(';')[0];
}

async function login(origin, password = PASSWORD) {
  const res = await req(origin, '/admin/login', {
    method: 'POST',
    origin,
    body: { password },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json?.ok, true);
  return cookieFrom(res.setCookie);
}

async function seedUsers(store) {
  const building = 'whatsapp:+15551110001';
  await store.ensureSender(building);
  await store.saveProfile(building, {
    ...emptyProfile(),
    draft: { name: 'Bloom Salon' },
  });
  await store.appendMessage({
    senderId: building,
    direction: 'inbound',
    body: 'hi I run Bloom',
    twilioMessageSid: 'SMin1',
    mode: 'opening',
  });
  await store.appendMessage({
    senderId: building,
    direction: 'outbound',
    body: 'Tell me about your business',
    twilioMessageSid: 'SMout1',
    mode: 'opening',
  });

  const approved = 'whatsapp:+15551110002';
  await store.ensureSender(approved);
  await store.saveProfile(approved, {
    ...emptyProfile(),
    name: 'Approved Cafe',
    whatWeDo: 'Coffee',
    approvedAt: '2026-10-01T00:00:00.000Z',
  });
  await store.appendMessage({
    senderId: approved,
    direction: 'inbound',
    body: 'approve',
    twilioMessageSid: 'SMin2',
    mode: 'command',
  });

  const tried = 'whatsapp:+15551110003';
  await store.ensureSender(tried);
  await store.saveProfile(tried, {
    ...emptyProfile(),
    name: 'Tried Gym',
    approvedAt: '2026-10-02T00:00:00.000Z',
  });
  await store.saveSession(tried, {
    mode: 'BUILD',
    buildHistory: [],
    testHistory: [{ role: 'user', content: 'hours?' }],
    testSessionId: 't1',
    leadIntake: null,
  });
  await store.appendMessage({
    senderId: tried,
    direction: 'inbound',
    body: 'Are you open Sundays?',
    twilioMessageSid: 'SMin3',
    mode: 'test',
  });
  await store.appendMessage({
    senderId: tried,
    direction: 'outbound',
    body: 'Yes, 8 to 2',
    twilioMessageSid: 'SMout3',
    mode: 'test',
  });

  const lead = 'whatsapp:+15551110004';
  await store.ensureSender(lead);
  await store.saveProfile(lead, {
    ...emptyProfile(),
    name: 'Lead Bakery',
    whatWeDo: 'Bread',
    approvedAt: '2026-10-03T00:00:00.000Z',
  });
  await store.saveLead(lead, {
    businessName: 'Lead Bakery',
    answers: {
      channels: ['WhatsApp'],
      actions: ['Book meetings or appointments'],
      dailyInquiries: '5-20',
      system: 'No',
    },
    createdAt: '2026-10-04T12:00:00.000Z',
  });
  await store.appendMessage({
    senderId: lead,
    direction: 'inbound',
    body: '3',
    twilioMessageSid: 'SMin4',
    mode: 'lead',
  });
  await store.appendMessage({
    senderId: lead,
    direction: 'outbound',
    body: "Thanks! We'll get back to you soon.",
    twilioMessageSid: 'SMout4',
    mode: 'lead',
  });
}

async function testHiddenWhenUnset() {
  const store = createMemoryStore();
  await withAdmin(store, async ({ origin }) => {
    const res = await req(origin, '/admin');
    assert.equal(res.status, 404);
    const api = await req(origin, '/admin/api/users');
    assert.equal(api.status, 404);
  }, { password: null });
}

async function testCsrfAndLogin() {
  const store = createMemoryStore();
  await withAdmin(store, async ({ origin }) => {
    const noOrigin = await req(origin, '/admin/login', {
      method: 'POST',
      body: { password: PASSWORD },
    });
    assert.equal(noOrigin.status, 403);

    const badOrigin = await req(origin, '/admin/login', {
      method: 'POST',
      origin: 'https://evil.example',
      body: { password: PASSWORD },
    });
    assert.equal(badOrigin.status, 403);

    const viaReferer = await req(origin, '/admin/login', {
      method: 'POST',
      referer: `${origin}/admin`,
      body: { password: PASSWORD },
    });
    assert.equal(viaReferer.status, 200);
    assert.ok(viaReferer.setCookie.includes('HttpOnly'));
    assert.ok(viaReferer.setCookie.includes('Path=/admin'));
    assert.ok(viaReferer.setCookie.toLowerCase().includes('samesite=lax'));
    assert.ok(!viaReferer.setCookie.toLowerCase().includes('secure'));
    assert.ok(viaReferer.setCookie.includes(`Max-Age=${COOKIE_MAX_AGE_MS / 1000}`));

    const wrong = await req(origin, '/admin/login', {
      method: 'POST',
      origin,
      body: { password: 'nope' },
    });
    assert.equal(wrong.status, 401);
  });
}

async function testRateLimit() {
  const store = createMemoryStore();
  await withAdmin(store, async ({ origin }) => {
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      const res = await req(origin, '/admin/login', {
        method: 'POST',
        origin,
        body: { password: 'wrong' },
      });
      assert.equal(res.status, 401);
    }
    const locked = await req(origin, '/admin/login', {
      method: 'POST',
      origin,
      body: { password: PASSWORD },
    });
    assert.equal(locked.status, 429);
  });
}

async function testAuthzAndChatUntouched() {
  const store = createMemoryStore();
  await seedUsers(store);
  await withAdmin(store, async ({ origin }) => {
    const page = await req(origin, '/admin');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('type="password"'));

    const api = await req(origin, '/admin/api/users');
    assert.equal(api.status, 401);

    const detail = await req(origin, '/admin/users/whatsapp:%2B15551110001');
    assert.ok(detail.status === 302 || detail.status === 303);
    assert.equal(new URL(detail.headers.get('location'), origin).pathname, '/admin');

    const chat = await req(origin, '/api/chat', { method: 'POST', body: { message: 'hi' } });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.source, 'chat');

    const send = await req(origin, '/admin/api/send', {
      method: 'POST',
      origin,
      body: { text: 'hi' },
    });
    assert.equal(send.status, 404);
  });
}

async function testListAndDetail() {
  const store = createMemoryStore();
  await seedUsers(store);
  await withAdmin(store, async ({ origin }) => {
    const cookie = await login(origin);
    const list = await req(origin, '/admin/api/users', { cookie });
    assert.equal(list.status, 200);
    const byPhone = Object.fromEntries(list.json.users.map((u) => [u.phoneE164, u]));
    assert.equal(byPhone['+15551110001'].stage, 'building');
    assert.equal(byPhone['+15551110001'].businessName, 'Bloom Salon');
    assert.equal(byPhone['+15551110001'].isLead, false);
    assert.equal(byPhone['+15551110002'].stage, 'approved');
    assert.equal(byPhone['+15551110003'].stage, 'tried');
    assert.equal(byPhone['+15551110004'].stage, 'lead');
    assert.equal(byPhone['+15551110004'].isLead, true);

    const html = await req(origin, '/admin', { cookie });
    assert.ok(html.text.includes('Bloom Salon'));
    assert.ok(html.text.includes('Tried the bot'));
    assert.ok(html.text.includes('>Lead<') || html.text.includes('Lead</span>'));

    const bloom = await req(origin, '/admin/api/users?q=bloom', { cookie });
    assert.equal(bloom.json.users.length, 1);
    assert.equal(bloom.json.users[0].businessName, 'Bloom Salon');

    const approvedOnly = await req(origin, '/admin/api/users?stage=approved', { cookie });
    assert.deepEqual(
      approvedOnly.json.users.map((u) => u.stage),
      ['approved']
    );

    const missing = await req(origin, '/admin/api/users/whatsapp:%2B19999999999', { cookie });
    assert.equal(missing.status, 404);

    const detail = await req(origin, '/admin/api/users/whatsapp:%2B15551110001', { cookie });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.user.messages[0].direction, 'inbound');
    assert.equal(detail.json.user.messages[0].body, 'hi I run Bloom');
    assert.equal(detail.json.user.messages[1].direction, 'outbound');
    assert.equal(detail.json.user.messages[1].mode, 'opening');
    assert.ok(detail.json.user.summary.includes('Bloom Salon') || detail.json.user.summary.includes('Business:'));

    const lead = await req(origin, '/admin/api/users/whatsapp:%2B15551110004', { cookie });
    assert.equal(lead.json.user.lead.answers.dailyInquiries, '5-20');
    assert.ok(lead.json.user.summary.includes('Lead Bakery'));

    const leadHtml = await req(origin, '/admin/users/whatsapp:%2B15551110004', { cookie });
    assert.equal(leadHtml.status, 200);
    assert.ok(leadHtml.text.includes('list-pane'));
    assert.ok(leadHtml.text.includes('detail-pane'));
    assert.ok(leadHtml.text.includes('Inquiries per day'));
    assert.ok(leadHtml.text.includes('5-20'));
    assert.ok(leadHtml.text.includes('Thanks! We&#39;ll get back to you soon.') || leadHtml.text.includes('Thanks!'));
  });
}

async function testLogoutAndHelpers() {
  const store = createMemoryStore();
  await withAdmin(store, async ({ origin }) => {
    const cookie = await login(origin);
    const noOrigin = await req(origin, '/admin/logout', { method: 'POST', cookie });
    assert.equal(noOrigin.status, 403);
    const out = await req(origin, '/admin/logout', {
      method: 'POST',
      origin,
      cookie,
      headers: { Accept: 'application/json' },
    });
    assert.equal(out.status, 200, out.text);
    assert.ok(String(out.setCookie).includes('Max-Age=0'));
    const after = await req(origin, '/admin/api/users');
    assert.equal(after.status, 401);
  });

  assert.equal(passwordsEqual('a', 'a'), true);
  assert.equal(passwordsEqual('short', 'much-longer-secret'), false);
  assert.equal(deriveStage({ hasLead: true, approvedAt: 'x', triedBot: true }), 'lead');
  assert.equal(deriveStage({ hasLead: false, approvedAt: 'x', triedBot: true }), 'tried');
  assert.equal(deriveStage({ hasLead: false, approvedAt: 'x', triedBot: false }), 'approved');
  assert.equal(deriveStage({ hasLead: false, approvedAt: null, triedBot: false }), 'building');

  const prod = cookieHeader('tok', { production: true });
  assert.ok(prod.includes('Secure'));
  assert.ok(prod.includes('SameSite=Lax'));
}

async function main() {
  await testHiddenWhenUnset();
  await testCsrfAndLogin();
  await testRateLimit();
  await testAuthzAndChatUntouched();
  await testListAndDetail();
  await testLogoutAndHelpers();
  console.log('admin-dashboard: ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
