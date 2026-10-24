# easyBot — Builder + Business Bot demo

AI Business Bot Builder: interview a business owner → approve facts → `/test` a Flowise customer chatbot. Browser UI locally; optional WhatsApp via Twilio on Render + Supabase.

## Prerequisites

- Node 18.15+ / 20+
- OpenAI API key in `.env`
- Flowise on port 3000 (local Docker or Render)
- For WhatsApp: Supabase project `easybot`, Twilio credentials, Render (or local + tunnel)

## Setup

```bash
cp .env.example .env   # set OPENAI_API_KEY and any other names you need
npm install
```

## Run locally

Terminal 1 — Flowise (use **1.8.3**):

```bash
npm run flowise
# or: docker compose up flowise
```

Terminal 2 — app:

```bash
npm start
```

Open http://localhost:3080

## Commands in chat

- `/test` — customer bot (Flowise); requires approved facts **and** successful Flowise sync
- `/end` — back to Builder
- `/reset` — clear profile for this session

## WhatsApp (Twilio) — personal demo

Webhook: `POST /webhooks/twilio/whatsapp`

1. Validates `X-Twilio-Signature` (Auth Token + `PUBLIC_BASE_URL` + all form params). Rejects missing/invalid.
2. Enqueues by `MessageSid` (duplicates ACK, no re-process).
3. Returns empty TwiML quickly; durable worker runs Builder / Business Bot and replies via Messages API.
4. State isolated per WhatsApp `From` in Supabase (`easybot_*` tables).

**Sandbox ≠ public number.** Do not advertise a Sandbox number. Live WhatsApp is ready only after a real end-to-end conversation on your number.

### Env you set yourself (never paste secrets in chat)

| Variable | Where |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` | Render / local `.env` |
| `PUBLIC_BASE_URL` | Exact HTTPS origin of the app (e.g. `https://easybot-app.onrender.com`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Render / local `.env` |
| `FLOWISE_URL` | Flowise service URL |
| Twilio Console → WhatsApp webhook | `https://<PUBLIC_BASE_URL>/webhooks/twilio/whatsapp` |

See [.env.example](.env.example) for the full name list.

### Deploy (Render, no Vercel)

- Blueprint: [render.yaml](render.yaml) — free web services `easybot-app` + `easybot-flowise`.
- Push to `main` triggers deploys via GitHub Actions + Render Deploy Hooks (path-filtered). Setup: [DEPLOY.md](DEPLOY.md) § **GitHub Actions → Render deploy**.
- Free tier spins down after ~15 minutes idle; cold start ~1 minute. Hit `/api/health` before Sandbox tests.
- Flowise should use Supabase Postgres (`DATABASE_*` in Flowise service) — free Render has no persistent disk.
- Production hides `/api/test-results*` and `results.html` unless `ALLOW_TEST_RESULTS=1`.

## CTO agent workflow

Milestone handoffs live in [`cto-workflow/`](cto-workflow/). Start/resume paste text: [`cto-workflow/README.md`](cto-workflow/README.md). Progress UI: http://localhost:3080/progress.html

## Scripts

```bash
npm run test:twilio   # MOCKED signature / dupe / isolation / order (no Twilio network)
npm run spike         # create Flowise chatflow + one prediction
npm run judge:calib   # calibrate Tester judge on fixed labelled examples
npm run e2e           # full yoga-teacher workflow (app must be running)
npm run e2e:ambiguity # fabrication / unknowns regressions + semantic judge
npm run e2e:adaptive  # adaptive Tester-as-Owner (expensive; ask before large runs)
```

### Test labels

| Label | Meaning |
|---|---|
| **Mocked** | `npm run test:twilio` — fake signatures, memory store |
| **Sandbox** | Twilio WhatsApp Sandbox against deployed/tunneled URL |
| **Live** | Real WhatsApp Business number — not done until you finish Twilio setup |

Adaptive suite env: `ADAPTIVE_BUSINESS=yoga-teacher`, `OWNER_TURN_LIMIT=20`, `ADAPTIVE_CONCURRENCY=2`. Set `JUDGE_MODE=stub` to avoid paid judge calls.

## Notes

- Browser profile: `data/business-profile.json`
- Adaptive e2e profiles: `data/test-profiles/<fixture-id>.json`
- Builder behavior: [BUILDER.md](BUILDER.md)
- SQL: `supabase/migrations/`
- Leave `FLOWISE_API_KEY` empty unless Flowise auth is enabled
