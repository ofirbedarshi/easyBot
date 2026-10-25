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

## GitHub Actions → Render deploy

Native Render Auto Deploy is unreliable here; deploys are triggered explicitly by [`.github/workflows/deploy-render.yml`](.github/workflows/deploy-render.yml) via **Deploy Hooks** (not the Render API key).

### 1. Create deploy hooks in Render

For each service (**easybot-app**, **easybot-flowise**):

1. Render Dashboard → open the service → **Settings**
2. Find **Deploy Hook** → copy the full URL (secret)
3. If a URL may have leaked → **Regenerate Hook** and update the GitHub secret

### 2. Add GitHub Actions secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret name | Value |
|---|---|
| `RENDER_DEPLOY_HOOK_APP` | Deploy Hook URL from **easybot-app** |
| `RENDER_DEPLOY_HOOK_FLOWISE` | Deploy Hook URL from **easybot-flowise** |

Do **not** commit hook URLs, API keys, or `.env`.

### 3. What triggers what

| Paths changed on `main` | Redeploy |
|---|---|
| `src/**`, `public/**`, `package.json`, `package-lock.json`, `Dockerfile`, `templates/**` | **easybot-app** only |
| `Dockerfile.flowise` | **easybot-flowise** only |
| `render.yaml` | both |
| Docs / `.cursor/**` / scripts / supabase only | neither (jobs skip) |

`workflow_dispatch` (Actions → **Deploy Render** → Run workflow) redeploys both.

Each hook call appends `&ref=<commit-sha>` so Render deploys that push.

### 4. Verify

1. Paste the two secrets (above).
2. Push an app path change to `main` (or run **workflow_dispatch**).
3. GitHub → **Actions** → **Deploy Render** → run green; log shows `deploy_id` + dashboard link (no secrets).
4. Render → **easybot-app** → **Events** / deploys list → new deploy for that SHA.

Optional: set each service’s **Auto Deploy** to **No** so only this Action triggers deploys (avoids double deploys if native auto-deploy starts working again).

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
| Deterministic | `npm run test:approval` / `test:nav` / `test:customer-prompt` | Product-behavior checks |
| Sandbox | Message Sandbox after Render URL live | **Not run** — Twilio number still in progress |
| Live | Real WhatsApp number E2E | **Not run** — not public-ready |

## Not public-ready

Do not declare launch until one real WhatsApp conversation succeeds end-to-end on your number (not only Sandbox, if you plan to use a real sender).
