# Deploy checklist (personal WhatsApp demo)

Do **not** paste secrets into chat. Set them in Render Dashboard → Environment, and/or local `.env`.

## Done in repo / cloud prep

- Supabase project **easybot** created (ref `ikaljptwjamzxlyrwndi`, region `eu-central-1`)
- Migration `easybot_*` tables + claim RPC applied
- App: Twilio webhook, durable worker, sender isolation, rate limits
- `render.yaml` ready
- **Render deploy paused** until you run `render login` (CLI installed at `~/.local/bin/render`)

## You: Render (one free web service)

1. `render login` (browser)
2. Create from Blueprint `render.yaml` **or** dashboard:
   - **easybot-app** — Node, `npm install` / `npm start`, health `/api/health`
3. Set env on **easybot-app** (names only listed in `.env.example`):
   - `NODE_ENV=production`
   - Web tester (`/api/chat`, `/api/state`, `/api/start`, `/api/cto-progress`) is off in production unless `ENABLE_WEB_TESTER=1`
   - `PUBLIC_BASE_URL=https://<your-easybot-app>.onrender.com` (exact, no trailing slash)
   - `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   - Twilio vars when ready
4. Free tier sleeps ~15m; hit `/api/health` before WhatsApp tests.

## GitHub Actions → Render deploy

Native Render Auto Deploy is unreliable here; deploys are triggered explicitly by [`.github/workflows/deploy-render.yml`](.github/workflows/deploy-render.yml) via **Deploy Hooks** (not the Render API key).

### 1. Create deploy hooks in Render

For **easybot-app**:

1. Render Dashboard → open the service → **Settings**
2. Find **Deploy Hook** → copy the full URL (secret)
3. If a URL may have leaked → **Regenerate Hook** and update the GitHub secret

### 2. Add GitHub Actions secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Secret name | Value |
|---|---|
| `RENDER_DEPLOY_HOOK_APP` | Deploy Hook URL from **easybot-app** |

Do **not** commit hook URLs, API keys, or `.env`.

### 3. What triggers what

| Paths changed on `main` | Redeploy |
|---|---|
| `src/**`, `public/**`, `package.json`, `package-lock.json`, `Dockerfile`, `render.yaml` | **easybot-app** |
| Docs / `.cursor/**` / scripts / supabase only | none (job skips) |

`workflow_dispatch` (Actions → **Deploy Render** → Run workflow) redeploys **easybot-app**.

Each hook call appends `&ref=<commit-sha>` so Render deploys that push.

### 4. Verify

1. Paste the secret (above).
2. Push an app path change to `main` (or run **workflow_dispatch**).
3. GitHub → **Actions** → **Deploy Render** → run green; log shows `deploy_id` + dashboard link (no secrets).
4. Render → **easybot-app** → **Events** / deploys list → new deploy for that SHA.

Optional: set the service’s **Auto Deploy** to **No** so only this Action triggers deploys (avoids double deploys if native auto-deploy starts working again).

## You: Twilio (production WhatsApp sender)

| Setting | Where |
|---|---|
| Webhook URL | Twilio Console → WhatsApp sender → `https://<PUBLIC_BASE_URL>/webhooks/twilio/whatsapp` |
| Method | HTTP POST |
| `TWILIO_ACCOUNT_SID` | Render env |
| `TWILIO_AUTH_TOKEN` | Render env (same token used for signature validation) |
| `TWILIO_WHATSAPP_FROM` | Render env, e.g. `whatsapp:+17623205871` |

The live sender is a production Twilio number. The Twilio Sandbox is only for local testing.

## Test labels

| Kind | Command / action | Status |
|---|---|---|
| Deterministic | `npm test` | All no-network suites (also GitHub Actions on PR / push to main) |
| Mocked | `npm run test:twilio` | Ran — signatures, dupes, isolation, order, `/test`+`stop` |
| Live model | `npm run regress` | Manual gpt-6-luna replays (a few cents; optional `Live regress` workflow_dispatch) |
| Sandbox | Message Sandbox after Render URL live (local testing only) | **Not run** — production number is configured |
| Live | Real WhatsApp number E2E | **Not run** — production number is configured |

## Not public-ready

Do not declare launch until one real WhatsApp conversation succeeds end-to-end on the production number (Sandbox is only for local testing).
