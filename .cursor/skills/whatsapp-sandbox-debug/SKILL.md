---
name: whatsapp-sandbox-debug
description: >-
  Connects to and debugs easyBot Twilio WhatsApp Sandbox conversations on
  Render (webhook → Supabase queue → worker → Builder/Business Bot → OpenAI).
  Use when the user mentions WhatsApp, Twilio Sandbox, sandbox chat, inbound
  messages, Business Bot errors, Builder context length, or asks to check /
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

Approve → live at once (no sync step). /test → Business Bot = one OpenAI
chat completion per message with the last 20 messages of test_history.
```

State is **per WhatsApp `From`** in Supabase (`easybot_*`), not `data/business-profile.json`.

| Piece | Where |
|---|---|
| Webhook | `src/twilio/webhook.js` |
| Worker | `src/twilio/worker.js` |
| Session / `/test` `/end` `/reset` | `src/session.js` |
| Business Bot reply (OpenAI) | `src/businessBot.js` |
| Store | `src/store/supabaseStore.js` |

## Live endpoints

| Service | URL / id |
|---|---|
| App | `https://easybot-app.onrender.com` — Render `srv-dbdlnqu7bikc73e2fuk0` |
| Webhook | `https://easybot-app.onrender.com/webhooks/twilio/whatsapp` |
| Health | `GET …/api/health` |

Free tier sleeps ~15m. **Wake the app** before Sandbox tests (cold start ~1m).

## Env (names only)

App needs: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `PUBLIC_BASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` (optional `OPENAI_MODEL`).

Twilio Console webhook = `PUBLIC_BASE_URL` + `/webhooks/twilio/whatsapp` (POST). Signature fails if `PUBLIC_BASE_URL` ≠ exact HTTPS origin (no trailing slash).

Local `npm start` with Twilio configured can steal the Supabase queue from Render — keep `DISABLE_INBOUND_WORKER=1` locally when debugging production Sandbox.

## Debug playbook (do in order)

### 1. Wake + health

```bash
curl -sS -m 120 https://easybot-app.onrender.com/api/health
```

Expect app JSON with `ok`, `openai`, `twilioWebhook`, `supabase`.

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

Also load `easybot_sessions` (`build_history`, `test_history`, `mode`) and `easybot_business_profiles.profile` (`approvedAt`, `draft`, `reviewedDraftKey`).

Inbound columns: `id, message_sid, sender_id, body, status, error, reply_sid, reply_body, created_at, claimed_at, finished_at` — no `updated_at` / `processed_at`.

### 3. Render logs

```bash
export PATH="$HOME/.local/bin:$PATH"
render logs -r srv-dbdlnqu7bikc73e2fuk0 -o text --confirm --limit 100
```

Useful filters: `--text "Business Bot"`, `--text inbound`, `--text Twilio`, `--path /webhooks/twilio/whatsapp`.

### 4. Map reply text → cause

| User-visible / reply pattern | Likely cause | Next check |
|---|---|---|
| `Bot updated ✅` (+ editing menu after **approve**; TEST line after Try my bot) | Approval saved; bot live | Profile `approvedAt` |
| `Business Bot error: no reply could be generated…` | OpenAI call failed in TEST | App logs `Business Bot reply failed:` (status only); `OPENAI_API_KEY` / `OPENAI_MODEL` |
| `Nothing approved yet…` on `/test` | No `approvedAt` | Finish review + **approve** |
| `Builder error: … maximum context length` | Bloated `build_history` | Truncate history or `/reset` |
| `Twilio signature rejected` / no reply at all | Bad token or `PUBLIC_BASE_URL` mismatch | App logs; Twilio webhook URL vs health `publicBaseUrl` |
| `Sorry, something went wrong…` | Worker threw; row `status=failed` | `error` column + app logs for that `message_sid` |
| Rate / length skips | Soft limits | `DEMO_MAX_*` env |

### 5. After fix

1. If history is poisoned: `/reset` or shorten the oversized turn in `easybot_sessions`.
2. `approvedAt` set before `/test`.

## Do not

- Re-explore README/DEPLOY from scratch every time — this skill is the map.
- Run local inbound worker against the same Supabase as Render while Sandbox testing.
- Dump Auth Token / service role key into chat or commits.
- Treat Sandbox as launch-ready (see `DEPLOY.md`).

## Related

- Spec: `DEPLOY.md`, `README.md` WhatsApp section
- Mocked webhook tests only: `npm run test:twilio` (no live Twilio)
- Vocabulary: Builder / Business Bot (project rule)
