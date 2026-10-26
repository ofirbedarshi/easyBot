import express from 'express';
import {
  adminPasswordConfigured,
  clearLoginFailures,
  clientIp,
  cookieHeader,
  loginAllowed,
  parseCookie,
  passwordsEqual,
  recordLoginFailure,
  requestOriginOk,
  signSession,
  verifySession,
} from './auth.js';
import { filterUsers, sortUsers, USER_LIST_CAP } from './users.js';
import { renderApp, renderLogin, renderSimple } from './views.js';

async function loadUsers(store, query) {
  const all = sortUsers(await store.listAdminUsers());
  const filtered = filterUsers(all, { q: query.q, stage: query.stage });
  return {
    users: filtered.slice(0, USER_LIST_CAP),
    truncated: filtered.length > USER_LIST_CAP,
    q: query.q || '',
    stage: query.stage || '',
  };
}

function wantsJson(req) {
  const accept = String(req.get('accept') || '');
  const type = String(req.get('content-type') || '');
  return (
    type.includes('application/json') ||
    accept.includes('application/json') ||
    req.path.startsWith('/api/')
  );
}

function sendLoginError(req, res, status, message) {
  if (wantsJson(req)) {
    return res.status(status).json({ ok: false, error: message });
  }
  if (status === 429) {
    return res.status(429).type('html').send(renderSimple(message, { error: true }));
  }
  return res.status(status).type('html').send(renderLogin({ error: message }));
}

export function createAdminRouter(store) {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  r.use((req, res, next) => {
    if (!adminPasswordConfigured()) {
      return res.status(404).type('text').send('Not found');
    }
    next();
  });

  r.post('/login', (req, res) => {
    if (!requestOriginOk(req)) {
      return sendLoginError(req, res, 403, 'Forbidden');
    }
    const ip = clientIp(req);
    if (!loginAllowed(ip)) {
      return sendLoginError(
        req,
        res,
        429,
        'Too many login attempts. Try again in 15 minutes.'
      );
    }
    const password = req.body?.password ?? '';
    if (!passwordsEqual(password, process.env.ADMIN_PASSWORD)) {
      recordLoginFailure(ip);
      return sendLoginError(req, res, 401, 'Invalid password');
    }
    clearLoginFailures(ip);
    res.setHeader('Set-Cookie', cookieHeader(signSession()));
    if (wantsJson(req)) return res.json({ ok: true });
    return res.redirect(303, '/admin');
  });

  r.post('/logout', (req, res) => {
    if (!requestOriginOk(req)) {
      if (wantsJson(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
      return res.status(403).type('html').send(renderSimple('Forbidden', { error: true }));
    }
    res.setHeader('Set-Cookie', cookieHeader('', { clear: true }));
    if (wantsJson(req)) return res.json({ ok: true });
    return res.redirect(303, '/admin');
  });

  r.get('/', async (req, res) => {
    if (!authed(req)) {
      return res.type('html').send(renderLogin());
    }
    try {
      const model = await loadUsers(store, req.query);
      return res.type('html').send(renderApp({ ...model, selected: null }));
    } catch (err) {
      console.error('admin list failed:', err.message);
      return res.status(500).type('html').send(renderSimple('Could not load users.', { error: true }));
    }
  });

  r.get('/api/users', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const all = sortUsers(await store.listAdminUsers());
      const filtered = filterUsers(all, { q: req.query.q, stage: req.query.stage });
      const truncated = filtered.length > USER_LIST_CAP;
      return res.json({
        ok: true,
        users: filtered.slice(0, USER_LIST_CAP),
        truncated,
      });
    } catch (err) {
      console.error('admin api list failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Could not load users' });
    }
  });

  r.get('/api/users/:senderId', async (req, res) => {
    if (!authed(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    try {
      const user = await store.getAdminUser(req.params.senderId);
      if (!user) return res.status(404).json({ ok: false, error: 'Not found' });
      return res.json({ ok: true, user });
    } catch (err) {
      console.error('admin api detail failed:', err.message);
      return res.status(500).json({ ok: false, error: 'Could not load user' });
    }
  });

  r.get('/users/:senderId', async (req, res) => {
    if (!authed(req)) return res.redirect(302, '/admin');
    try {
      const [user, model] = await Promise.all([
        store.getAdminUser(req.params.senderId),
        loadUsers(store, req.query),
      ]);
      if (!user) {
        return res.status(404).type('html').send(renderSimple('User not found.', { error: true }));
      }
      return res.type('html').send(renderApp({ ...model, selected: user }));
    } catch (err) {
      console.error('admin detail failed:', err.message);
      return res.status(500).type('html').send(renderSimple('Could not load user.', { error: true }));
    }
  });

  return r;
}

function authed(req) {
  return verifySession(parseCookie(req.headers.cookie));
}
