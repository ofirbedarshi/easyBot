import crypto from 'crypto';

export const ADMIN_COOKIE = 'easybot_admin';
export const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 5;

/** @type {Map<string, { count: number, resetAt: number }>} */
const loginFailures = new Map();

export function adminPasswordConfigured() {
  return String(process.env.ADMIN_PASSWORD || '').length > 0;
}

function sha256buf(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

/** Constant-time string compare via SHA-256 (no length leak). */
export function passwordsEqual(provided, expected) {
  const a = sha256buf(provided);
  const b = sha256buf(expected);
  return crypto.timingSafeEqual(a, b);
}

function hmacSecret() {
  return String(process.env.ADMIN_PASSWORD || '');
}

export function signSession(now = Date.now()) {
  const exp = String(now + COOKIE_MAX_AGE_MS);
  const sig = crypto.createHmac('sha256', hmacSecret()).update(exp).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!exp || !sig) return false;
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || Date.now() > expMs) return false;
  const expected = crypto
    .createHmac('sha256', hmacSecret())
    .update(exp)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function parseCookie(header, name = ADMIN_COOKIE) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1);
  }
  return null;
}

export function cookieHeader(value, { clear = false, production = undefined } = {}) {
  const prod =
    production ??
    (process.env.NODE_ENV === 'production');
  const secure = prod ? '; Secure' : '';
  if (clear) {
    return `${ADMIN_COOKIE}=; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  const maxAge = Math.floor(COOKIE_MAX_AGE_MS / 1000);
  return `${ADMIN_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function requestOriginOk(req) {
  const allowed = allowedOrigins(req);
  if (allowed.length === 0) return false;
  const origin = header(req, 'origin');
  if (origin) return allowed.includes(origin);
  const referer = header(req, 'referer');
  if (!referer) return false;
  try {
    const u = new URL(referer);
    return allowed.includes(`${u.protocol}//${u.host}`);
  } catch {
    return false;
  }
}

function allowedOrigins(req) {
  const host = header(req, 'host');
  const list = [];
  if (host) {
    const xf = header(req, 'x-forwarded-proto');
    const proto =
      (xf && xf.split(',')[0].trim()) ||
      (req.secure ? 'https' : 'http');
    list.push(`${proto}://${host}`);
  }
  const pub = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  if (pub) list.push(pub);
  return list;
}

function header(req, name) {
  if (typeof req.get === 'function') {
    const v = req.get(name);
    if (v) return String(v).trim();
  }
  const raw = req.headers?.[name] ?? req.headers?.[name.toLowerCase()];
  if (Array.isArray(raw)) return String(raw[0] || '').trim();
  return raw ? String(raw).trim() : '';
}

export function clientIp(req) {
  const xf = header(req, 'x-forwarded-for');
  if (xf) return xf.split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function loginAllowed(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return true;
  if (Date.now() > rec.resetAt) {
    loginFailures.delete(ip);
    return true;
  }
  return rec.count < LOGIN_MAX_FAILURES;
}

export function recordLoginFailure(ip) {
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (!rec || now > rec.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  rec.count += 1;
}

export function clearLoginFailures(ip) {
  loginFailures.delete(ip);
}

/** Test-only. */
export function _resetRateLimitForTests() {
  loginFailures.clear();
}
