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
import { pingFlowise } from './flowise.js';
import {
  RESULTS_LATEST,
  RESULTS_DIR,
  resolveJudgeMode,
  judgeModelName,
  JUDGE_VERSION,
} from './judge.js';
import { createStore, isSupabaseConfigured } from './store/index.js';
import { createTwilioWhatsAppRouter } from './twilio/webhook.js';
import { startInboundWorker } from './twilio/worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3080;
const isProd = process.env.NODE_ENV === 'production';

/** Protect private Tester artifacts in deployed environments. */
function blockTestResultsInProd(req, res, next) {
  if (isProd && process.env.ALLOW_TEST_RESULTS !== '1') {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  next();
}

// Twilio webhook needs urlencoded body parser on its route (mounted below).
// JSON for browser API.
app.use(express.json({ limit: '1mb' }));

const store = createStore();
app.use('/webhooks/twilio', createTwilioWhatsAppRouter(store));

if (isProd) {
  app.get('/results.html', (_req, res) => {
    res.status(404).send('Not found');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

/** Default UI / non-adaptive e2e session → data/business-profile.json */
const defaultSession = createSession();
/** Adaptive e2e keyed sessions → data/test-profiles/<key>.json */
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

function safeResultsBasename(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || base.includes('..') || !base.endsWith('.json')) {
    return null;
  }
  return base;
}

function summarizeResultsFile(filePath, name) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entries = data.entries || [];
    const fail = entries.filter((e) => e.pass === false).length;
    const pass = entries.filter((e) => e.pass === true).length;
    return {
      id: name,
      runName: data.runName || name,
      finishedAt: data.finishedAt || null,
      startedAt: data.startedAt || null,
      pass,
      fail,
      entryCount: entries.length,
      hasTranscript: Array.isArray(data.transcript) && data.transcript.length > 0,
      judgeMode: data.judgeMode || null,
      judgeModel: data.judgeModel || null,
      calibrationOk: data.calibration?.ok ?? null,
      synthetic: !!data.synthetic,
      pathLabels: data.pathLabels || null,
      isLatest: name === 'latest.json',
    };
  } catch (err) {
    return {
      id: name,
      runName: name,
      error: err.message,
      pass: 0,
      fail: 0,
      entryCount: 0,
      hasTranscript: false,
    };
  }
}

app.get('/api/health', async (_req, res) => {
  let flowise = false;
  try {
    flowise = await pingFlowise();
  } catch {
    flowise = false;
  }
  res.json({
    ok: true,
    openai: !!process.env.OPENAI_API_KEY,
    flowise,
    flowiseUrl: process.env.FLOWISE_URL || 'http://localhost:3000',
    supabase: isSupabaseConfigured(),
    store: store.kind,
    twilioWebhook: !!process.env.TWILIO_AUTH_TOKEN,
    publicBaseUrl: process.env.PUBLIC_BASE_URL || null,
    judgeMode: resolveJudgeMode(),
    judgeModel: judgeModelName(),
    judgeVersion: JUDGE_VERSION,
  });
});

app.get('/api/test-results', blockTestResultsInProd, (_req, res) => {
  if (!fs.existsSync(RESULTS_LATEST)) {
    return res.status(404).json({
      ok: false,
      error:
        'No test results yet. Run npm run e2e, e2e:ambiguity, or e2e:adaptive.',
    });
  }
  try {
    const data = JSON.parse(fs.readFileSync(RESULTS_LATEST, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/test-results/index', blockTestResultsInProd, (_req, res) => {
  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const files = fs
      .readdirSync(RESULTS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(RESULTS_DIR, f);
        const st = fs.statSync(full);
        return { ...summarizeResultsFile(full, f), mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
    res.json({ ok: true, runs: files });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/test-results/file', blockTestResultsInProd, (req, res) => {
  const base = safeResultsBasename(req.query.name);
  if (!base) {
    return res.status(400).json({ ok: false, error: 'Invalid name' });
  }
  const full = path.join(RESULTS_DIR, base);
  if (!fs.existsSync(full)) {
    return res.status(404).json({ ok: false, error: 'Not found' });
  }
  try {
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    res.json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});


app.get('/api/state', (req, res) => {
  const raw = req.query.sessionKey;
  if (raw != null && raw !== '' && !SESSION_KEY_RE.test(String(raw))) {
    return res.status(400).json({ ok: false, error: 'Invalid sessionKey' });
  }
  const session = resolveSession(raw);
  res.json(getState(session));
});

app.post('/api/start', (_req, res) => {
  res.json(bootstrapSession(defaultSession));
});

app.post('/api/chat', async (req, res) => {
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
    const flowiseSessionId =
      typeof req.body?.flowiseSessionId === 'string'
        ? req.body.flowiseSessionId
        : undefined;
    const result = await handleMessage(session, text, { flowiseSessionId });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Only run the durable WhatsApp worker when Twilio outbound is configured.
 * Prevents a local `npm start` (same Supabase, no Twilio) from claiming
 * inbound rows and marking them done without sending a WhatsApp reply.
 * Set DISABLE_INBOUND_WORKER=1 to force off; ENABLE_INBOUND_WORKER=1 to force on.
 */
function shouldStartInboundWorker() {
  if (process.env.DISABLE_INBOUND_WORKER === '1') return false;
  if (process.env.ENABLE_INBOUND_WORKER === '1') return true;
  return !!process.env.TWILIO_AUTH_TOKEN;
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
