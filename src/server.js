import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createSession,
  handleMessage,
  bootstrapSession,
  getState,
} from './session.js';
import { testProfilePath } from './profile.js';
import { createStore, isSupabaseConfigured } from './store/index.js';
import { createTwilioWhatsAppRouter } from './twilio/webhook.js';
import { startInboundWorker } from './twilio/worker.js';
import { createAdminRouter } from './admin/router.js';
import { requireWebTester } from './webTester.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CTO_STATE_PATH = path.join(__dirname, '..', 'cto-workflow', 'state.json');
const app = express();
const PORT = Number(process.env.PORT) || 3080;
const isProd = process.env.NODE_ENV === 'production';

// Twilio webhook needs urlencoded body parser on its route (mounted below).
// JSON for browser API.
app.use(express.json({ limit: '1mb' }));

const store = createStore();
app.use('/webhooks/twilio', createTwilioWhatsAppRouter(store));
app.use('/admin', createAdminRouter(store));

app.use(express.static(path.join(__dirname, '..', 'public')));

/** Default UI session → data/business-profile.json */
const defaultSession = createSession();
/** Optional keyed sessions → data/test-profiles/<key>.json */
const keyedSessions = new Map();
const SESSION_KEY_RE = /^[a-z0-9-]{1,64}$/;

function resolveSession(sessionKey) {
  if (sessionKey == null || sessionKey === '') return defaultSession;
  const key = String(sessionKey);
  if (!SESSION_KEY_RE.test(key)) return null;
  if (!keyedSessions.has(key)) {
    keyedSessions.set(key, createSession(testProfilePath(key)));
  }
  return keyedSessions.get(key);
}

/** Read-only CTO workflow progress (persisted handoffs). */
app.get('/api/cto-progress', requireWebTester, (_req, res) => {
  if (!fs.existsSync(CTO_STATE_PATH)) {
    return res.status(404).json({
      ok: false,
      error: 'No cto-workflow/state.json yet.',
    });
  }
  try {
    const state = JSON.parse(fs.readFileSync(CTO_STATE_PATH, 'utf8'));
    res.json({ ok: true, state, path: 'cto-workflow/state.json' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    openai: !!process.env.OPENAI_API_KEY,
    supabase: isSupabaseConfigured(),
    store: store.kind,
    twilioWebhook: !!process.env.TWILIO_AUTH_TOKEN,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
  });
});

app.get('/api/state', requireWebTester, (req, res) => {
  const raw = req.query.sessionKey;
  if (raw != null && raw !== '' && !SESSION_KEY_RE.test(String(raw))) {
    return res.status(400).json({ ok: false, error: 'Invalid sessionKey' });
  }
  const session = resolveSession(raw);
  res.json(getState(session));
});

app.post('/api/start', requireWebTester, (_req, res) => {
  res.json(bootstrapSession(defaultSession));
});

app.post('/api/chat', requireWebTester, async (req, res) => {
  try {
    const sessionKey = req.body?.sessionKey;
    if (
      sessionKey != null &&
      sessionKey !== '' &&
      !SESSION_KEY_RE.test(String(sessionKey))
    ) {
      return res.status(400).json({ ok: false, error: 'Invalid sessionKey' });
    }
    const session = resolveSession(sessionKey);
    const text = req.body?.message ?? req.body?.text ?? '';
    const result = await handleMessage(session, text);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Only run the durable WhatsApp worker when Twilio outbound is configured.
 * Prevents a local `npm start` (same Supabase) from claiming production
 * inbound rows meant for the deployed app.
 * Set DISABLE_INBOUND_WORKER=1 to force off; ENABLE_INBOUND_WORKER=1 to force on.
 */
function shouldStartInboundWorker() {
  if (process.env.DISABLE_INBOUND_WORKER === '1') return false;
  if (process.env.ENABLE_INBOUND_WORKER === '1') return true;
  if (!process.env.TWILIO_AUTH_TOKEN) return false;

  const publicBase = (process.env.PUBLIC_BASE_URL || '').toLowerCase();
  const publicRemote =
    publicBase.startsWith('https://') && !publicBase.includes('localhost');
  // Local UI + Twilio secrets + production Supabase must not steal the queue.
  if (!isProd && publicRemote) return false;

  return true;
}

const worker = shouldStartInboundWorker()
  ? startInboundWorker(store)
  : null;

app.listen(PORT, () => {
  console.log(`easyBot UI → http://localhost:${PORT}`);
  console.log(`WhatsApp webhook → POST /webhooks/twilio/whatsapp (store=${store.kind})`);
  if (worker) {
    console.log('Inbound worker: ON');
  } else {
    console.log(
      'Inbound worker: OFF (no TWILIO_AUTH_TOKEN / disabled) — safe for local UI; Render handles WhatsApp'
    );
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn('WARNING: OPENAI_API_KEY not set');
  }
  if (isProd && !process.env.PUBLIC_BASE_URL) {
    console.warn('WARNING: PUBLIC_BASE_URL not set — Twilio signature validation will fail');
  }
});

export { app, store, worker };
