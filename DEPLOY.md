# Deploy checklist (personal WhatsApp demo)

Do **not** paste secrets into chat. Set them in Render Dashboard → Environment, and/or local `.env`.

## Done in repo / cloud prep

- Supabase project **easybot** created (ref `ikaljptwjamzxlyrwndi`, region `eu-central-1`)
- Migration `easybot_*` tables + claim RPC applied
- App: Twilio webhook, durable worker, sender isolation, rate limits
- `render.yaml` + `Dockerfile.flowise` ready
- **Render deploy paused** until you run `render login` (CLI installed at `~/.local/bin/render`)

## You: Render (two free web services)

1. `render login` (browser)
2. Create from Blueprint `render.yaml` **or** dashboard:
   - **easybot-app** — Node, `npm install` / `npm start`, health `/api/health`
   - **easybot-flowise** — Docker `Dockerfile.flowise`, health `/api/v1/ping`
3. Set env on **easybot-app** (names only listed in `.env.example`):
   - `NODE_ENV=production`
   - `PUBLIC_BASE_URL=https://<your-easybot-app>.onrender.com` (exact, no trailing slash)
   - `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - `FLOWISE_URL=https://<your-easybot-flowise>.onrender.com`
   - Twilio vars when ready
4. Set Flowise Postgres env from Supabase → Connect → **Session pooler** (IPv4). Do not use the direct host `db.<ref>.supabase.co`: it is IPv6-only, and Render cannot reach it (`ENETUNREACH`), which leaves Flowise up on `/api/v1/ping` but unable to save chatflows. For this project: host `aws-1-eu-central-1.pooler.supabase.com`, user `postgres.ikaljptwjamzxlyrwndi`, port `5432`. Also set `DATABASE_SSL=true` and `DATABASE_SSL_KEY_BASE64` to the base64 PEM of the Supabase root CA (the pooler cert is signed by Supabase’s private CA; without the CA, Flowise logs `self-signed certificate in certificate chain` and still cannot save chatflows).
5. Free tier sleeps ~15m; hit `/api/health` before Sandbox tests.

## You: Twilio (when WhatsApp number / Sandbox ready)

| Setting | Where |
|---|---|
| Webhook URL | Twilio Console → WhatsApp Sandbox or sender → `https://<PUBLIC_BASE_URL>/webhooks/twilio/whatsapp` |
| Method | HTTP POST |
| `TWILIO_ACCOUNT_SID` | Render env |
| `TWILIO_AUTH_TOKEN` | Render env (same token used for signature validation) |
| `TWILIO_WHATSAPP_FROM` | Render env, e.g. `whatsapp:+14155238886` for Sandbox |

Sandbox is **not** a public number you can advertise.

## Test labels

| Kind | Command / action | Status |
|---|---|---|
| Mocked | `npm run test:twilio` | Ran — signatures, dupes, isolation, order, `/test`+/`/end` |
| Existing e2e | `npm run e2e` | Ran — all passed |
| Existing ambiguity | `npm run e2e:ambiguity` | Ran — some Flowise/judge flaky fails (model unknowns), not webhook regressions |
| Adaptive | `npm run e2e:adaptive` | **Not run** (needs approval — paid model heavy) |
| Sandbox | Message Sandbox after Render URL live | **Not run** — Twilio number still in progress |
| Live | Real WhatsApp number E2E | **Not run** — not public-ready |

## Not public-ready

Do not declare launch until one real WhatsApp conversation succeeds end-to-end on your number (not only Sandbox, if you plan to use a real sender).
