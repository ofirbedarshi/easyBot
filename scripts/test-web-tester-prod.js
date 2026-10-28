/**
 * Deterministic guard for local web tester APIs in production.
 * No network. No OpenAI. Never prints env values.
 */
import assert from 'assert';

process.env.DISABLE_INBOUND_WORKER = '1';

const { app } = await import('../src/server.js');

const WEB_TESTER_PATHS = [
  '/api/chat',
  '/api/state',
  '/api/start',
  '/api/cto-progress',
];

const NOT_FOUND = { ok: false, error: 'Not found' };

async function withEnv(vars, fn) {
  const prev = {};
  for (const key of Object.keys(vars)) {
    prev[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

async function withServer(fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  try {
    await fn(origin);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function req(origin, method, pathname) {
  const res = await fetch(`${origin}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function isGuard404(result) {
  return (
    result.status === 404 &&
    result.json &&
    result.json.ok === false &&
    result.json.error === 'Not found'
  );
}

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  PASS  ${name}`);
}

await withServer(async (origin) => {
  await withEnv({ NODE_ENV: 'production', ENABLE_WEB_TESTER: undefined }, async () => {
    for (const pathname of WEB_TESTER_PATHS) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const result = await req(origin, method, pathname);
        assert.equal(result.status, 404, `${method} ${pathname} production status`);
        assert.deepEqual(result.json, NOT_FOUND, `${method} ${pathname} production body`);
      }
      ok(`production → 404 for ${pathname} (all methods)`);
    }

    const health = await req(origin, 'GET', '/api/health');
    assert.equal(health.status, 200, 'GET /api/health production status');
    assert.equal(health.json?.ok, true, 'GET /api/health production ok');
    ok('/api/health 200 in production');
  });

  await withEnv({ NODE_ENV: 'development', ENABLE_WEB_TESTER: undefined }, async () => {
    const state = await req(origin, 'GET', '/api/state');
    assert.notEqual(state.status, 404, 'GET /api/state non-production');
    assert.ok(!isGuard404(state), 'GET /api/state is not the production guard');

    const cto = await req(origin, 'GET', '/api/cto-progress');
    assert.ok(!isGuard404(cto), 'GET /api/cto-progress is not the production guard');

    const start = await req(origin, 'POST', '/api/start');
    assert.notEqual(start.status, 404, 'POST /api/start non-production');
    assert.ok(!isGuard404(start), 'POST /api/start is not the production guard');

    const chat = await req(origin, 'POST', '/api/chat');
    assert.notEqual(chat.status, 404, 'POST /api/chat non-production');
    assert.ok(!isGuard404(chat), 'POST /api/chat is not the production guard');

    ok('non-production → not 404 for the four tester routes');
  });

  await withEnv({ NODE_ENV: 'production', ENABLE_WEB_TESTER: '1' }, async () => {
    const state = await req(origin, 'GET', '/api/state');
    assert.notEqual(state.status, 404, 'GET /api/state ENABLE_WEB_TESTER=1');
    assert.ok(!isGuard404(state), 'GET /api/state tester override');

    const cto = await req(origin, 'GET', '/api/cto-progress');
    assert.ok(!isGuard404(cto), 'GET /api/cto-progress tester override');

    const start = await req(origin, 'POST', '/api/start');
    assert.notEqual(start.status, 404, 'POST /api/start ENABLE_WEB_TESTER=1');
    assert.ok(!isGuard404(start), 'POST /api/start tester override');

    const chat = await req(origin, 'POST', '/api/chat');
    assert.notEqual(chat.status, 404, 'POST /api/chat ENABLE_WEB_TESTER=1');
    assert.ok(!isGuard404(chat), 'POST /api/chat tester override');

    ok('ENABLE_WEB_TESTER=1 in production → not 404');
  });
});

console.log(`${passed}/${passed} passed`);
