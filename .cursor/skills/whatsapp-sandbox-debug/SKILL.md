---
name: whatsapp-sandbox-debug
description: >-
  Connects to and debugs easyBot Twilio WhatsApp Sandbox conversations on
  Render (webhook → Supabase queue → worker → Builder/Business Bot → Flowise).
  Use when the user mentions WhatsApp, Twilio Sandbox, sandbox chat, inbound
  messages, Flowise sync failed, Builder context length, or asks to check /
  debug a WhatsApp conversation.
---

# WhatsApp Sandbox debug

Personal demo path only. Sandbox ≠ public number. Never paste secrets from `.env` into chat.

## Architecture (one glance)

```
WhatsApp → Twilio → POST /webhooks/twilio/whatsapp (easybot-app)
  → validate X-Twilio-Signature (TWILIO_AUTH_TOKEN + PUBLIC_BASE_URL)
  → enqueue easybot_inbound_messages (MessageSid unique)
  → empty TwiML ACK
  → inbound worker claims row → handleMessage (Builder or Business Bot)
  → sendWhatsAppReply (Messages API)

Approve while Flowise asleep:
  → approve locally + flowiseSyncPending
  → wake ping + flowiseSyncWorker polls → sync → WhatsApp “ready /test”
```

State is **per WhatsApp `From`** in Supabase (`easybot_*`), not `data/business-profile.json`.

| Piece | Where |
|---|---|
| Webhook | `src/twilio/webhook.js` |
| Worker | `src/twilio/worker.js` |
| Flowise pending sync | `src/flowiseSyncWorker.js` |
| Session / `/test` `/end` `/reset` | `src/session.js` |
| Flowise sync + predict + wake | `src/flowise.js` (`pingFlowise`, `wakeFlowise`) |
| Store | `src/store/supabaseStore.js` |

## Live endpoints

| Service | URL / id |
|---|---|
| App | `https://easybot-app.onrender.com` — Render `srv-dbdlnqu7bikc73e2fuk0` |
| Flowise | `https://easybot-flowise.onrender.com` — Render `srv-dbdlj6g473hc73cpnfb0` |
| Webhook | `https://easybot-app.onrender.com/webhooks/twilio/whatsapp` |
| Health | `GET …/api/health` (app), `GET …/api/v1/ping` (Flowise) |

Free tier sleeps ~15m. **Wake both** before Sandbox tests (cold start ~1m).

## Env (names only)

App needs: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `PUBLIC_BASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `FLOWISE_URL`.

Twilio Console webhook = `PUBLIC_BASE_URL` + `/webhooks/twilio/whatsapp` (POST). Signature fails if `PUBLIC_BASE_URL` ≠ exact HTTPS origin (no trailing slash).

Local `npm start` with Twilio configured can steal the Supabase queue from Render — keep `DISABLE_INBOUND_WORKER=1` locally when debugging production Sandbox.

## Debug playbook (do in order)

### 1. Wake + health

```bash
curl -sS -m 120 https://easybot-app.onrender.com/api/health
curl -sS -m 120 https://easybot-flowise.onrender.com/api/v1/ping
```

Expect app JSON with `ok`, `twilioWebhook`, `supabase`. `flowise: false` is OK for Approve (pending sync + wake); `/test` waits until `flowiseSyncOk` or ready WhatsApp.

### 2. Latest conversation (Supabase)

Sender format: `whatsapp:+E164` (demo often `whatsapp:+972546351194`).

```bash
cd <repo> && set -a && source .env && set +a
node --input-type=module <<'EOF'
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data } = await sb.from('easybot_inbound_messages').select('created_at,sender_id,body,status,error,reply_body').order('created_at',{ascending:false}).limit(20);
for (const r of data) console.log(JSON.stringify({ t:r.created_at, status:r.status, body:(r.body||'').slice(0,80), reply:(r.reply_body||'').slice(0,200), error:r.error }));
EOF
```

Also load `easybot_sessions` (`build_history`, `test_history`, `mode`) and `easybot_business_profiles.profile` (`approvedAt`, `chatflowId`, `flowiseSyncOk`, `flowiseSyncPending`, `flowiseSyncRequestedAt`).

Inbound columns: `id, message_sid, sender_id, body, status, error, reply_sid, reply_body, created_at, claimed_at, finished_at` — no `updated_at` / `processed_at`.

### 3. Render logs

```bash
export PATH="$HOME/.local/bin:$PATH"
render logs -r srv-dbdlnqu7bikc73e2fuk0 -o text --confirm --limit 100
render logs -r srv-dbdlj6g473hc73cpnfb0 -o text --confirm --limit 100
```

Useful filters: `--text Flowise`, `--text inbound`, `--text Twilio`, `--path /webhooks/twilio/whatsapp`.

### 4. Map reply text → cause

| User-visible / reply pattern | Likely cause | Next check |
|---|---|---|
| `Flowise is waking up` / `Still syncing` / `approved_sync_pending` note | Cold start — expected | Profile `flowiseSyncPending`; wait for ready WhatsApp; app logs `flowise sync ok` |
| Ready WhatsApp: `Bot updated ✅` (+ editing menu in BUILD; no menu in TEST) | Sync worker succeeded | `flowiseSyncOk: true`; app logs `flowise sync ok … chatflow=` |
| Give-up: `still unavailable after waiting` | Down > ~5 min | Flowise Render logs; pooler/`DATABASE_SSL_KEY_BASE64`; user **approve** again |
| `Flowise … → 500` `getRunningExpressApp` / saveChatflow | Flowise app/DB broken | Flowise logs; pooler vs IPv6 direct host |
| Old: `[Approved locally, but Flowise sync failed…]` + HTML | Pre-pending-sync deploy | Redeploy app; repair bloated history; `/reset` if needed |
| `Builder error: … maximum context length` | Bloated `build_history` (old HTML dump) | Truncate history; confirm `truncateFlowiseErrorBody` shipped |
| `Twilio signature rejected` / no reply at all | Bad token or `PUBLIC_BASE_URL` mismatch | App logs; Twilio webhook URL vs health `publicBaseUrl` |
| `Sorry, something went wrong…` | Worker threw; row `status=failed` | `error` column + app logs for that `message_sid` |
| Rate / length skips | Soft limits | `DEMO_MAX_*` env |

### 5. After fix

1. Prefer waiting for sync-worker ready message over manual wake — but wake ping still helps debug.
2. If history poisoned (legacy): `/reset` or shorten oversized assistant turn in `easybot_sessions`.
3. `flowiseSyncOk: true` (or ready WhatsApp) before `/test`.

## Do not

- Re-explore README/DEPLOY from scratch every time — this skill is the map.
- Run local inbound worker against the same Supabase as Render while Sandbox testing.
- Dump Auth Token / service role key into chat or commits.
- Treat Sandbox as launch-ready (see `DEPLOY.md`).

## Related

- Spec: `DEPLOY.md`, `README.md` WhatsApp section
- Mocked webhook tests only: `npm run test:twilio` (no live Twilio)
- Vocabulary: Builder / Business Bot (project rule)
