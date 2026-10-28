/**
 * Dev web-tester API gate: off in production unless ENABLE_WEB_TESTER=1.
 * No network. Never prints env values.
 */
import assert from 'assert';
import express from 'express';
import { requireWebTester, webTesterEnabled } from '../src/webTester.js';

assert.equal(webTesterEnabled({}), true);
assert.equal(webTesterEnabled({ NODE_ENV: 'development' }), true);
assert.equal(webTesterEnabled({ NODE_ENV: 'production' }), false);
assert.equal(
  webTesterEnabled({ NODE_ENV: 'production', ENABLE_WEB_TESTER: '1' }),
  true
);
assert.equal(
  webTesterEnabled({ NODE_ENV: 'development', ENABLE_WEB_TESTER: '1' }),
  true
);
console.log('PASS webTesterEnabled env matrix');

const prevNode = process.env.NODE_ENV;
const prevFlag = process.env.ENABLE_WEB_TESTER;

async function withApp(fn) {
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/state', requireWebTester, (_req, res) => res.json({ ok: true, live: true }));
  app.post('/api/start', requireWebTester, (_req, res) => res.json({ ok: true, live: true }));
  app.post('/api/chat', requireWebTester, (_req, res) => res.json({ ok: true, live: true }));
  app.get('/api/cto-progress', requireWebTester, (_req, res) =>
    res.json({ ok: true, live: true })
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    await fn(origin);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

async function hit(origin, path, method = 'GET') {
  const res = await fetch(`${origin}${path}`, { method });
  const json = await res.json();
  return { status: res.status, json };
}

process.env.NODE_ENV = 'production';
delete process.env.ENABLE_WEB_TESTER;
await withApp(async (origin) => {
  const health = await hit(origin, '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.ok, true);
  for (const [path, method] of [
    ['/api/state', 'GET'],
    ['/api/start', 'POST'],
    ['/api/chat', 'POST'],
    ['/api/cto-progress', 'GET'],
  ]) {
    const r = await hit(origin, path, method);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(r.json, { ok: false, error: 'Not found' });
  }
});
console.log('PASS production 404s tester APIs; health stays public');

process.env.NODE_ENV = 'production';
process.env.ENABLE_WEB_TESTER = '1';
await withApp(async (origin) => {
  const chat = await hit(origin, '/api/chat', 'POST');
  assert.equal(chat.status, 200);
  assert.equal(chat.json.live, true);
});
console.log('PASS ENABLE_WEB_TESTER=1 reopens tester in production');

process.env.NODE_ENV = 'development';
delete process.env.ENABLE_WEB_TESTER;
await withApp(async (origin) => {
  const start = await hit(origin, '/api/start', 'POST');
  assert.equal(start.status, 200);
  assert.equal(start.json.live, true);
});
console.log('PASS non-production tester stays open');

if (prevNode == null) delete process.env.NODE_ENV;
else process.env.NODE_ENV = prevNode;
if (prevFlag == null) delete process.env.ENABLE_WEB_TESTER;
else process.env.ENABLE_WEB_TESTER = prevFlag;
