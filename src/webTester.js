/**
 * Local web chat tester (/api/chat, /api/state, /api/start, /api/cto-progress).
 * Off in production unless ENABLE_WEB_TESTER=1. /api/health stays public.
 */

export function webTesterEnabled(env = process.env) {
  if (String(env.ENABLE_WEB_TESTER || '') === '1') return true;
  return env.NODE_ENV !== 'production';
}

export function requireWebTester(_req, res, next) {
  if (webTesterEnabled()) return next();
  return res.status(404).json({ ok: false, error: 'Not found' });
}
