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

## Pre-built demo profiles (operator)

Do **not** apply migrations from the app or an agent. Apply `supabase/migrations/20261028120000_easybot_demo_profiles.sql` yourself after you approve it.

1. Copy public text from the business's own website into a local file, or use a local prospects JSON. The script does not scrape. Do not commit real prospect files.
2. With `OPENAI_API_KEY` set (never print those values):

   `node scripts/create-demo.js --label "Business" --owner-name "Dana" --phone +E164 --source https://their.site --text ./paste.txt`

   or `node scripts/create-demo.js --prospect ./prospects.json --id <id>`

   `--phone` / `whatsapp_e164` is optional. Only a value that normalizes to E.164 is stored; otherwise the demo is code-link only and the script warns. Short links are not resolved. `--owner-name` / prospect `owner_name` is optional. The extracted business name is required; the script refuses to save without it. `--dry-run` extracts and prints the profile and writes nothing (no Supabase). Saving still needs Supabase env.
3. Read the printed profile. Type `y` to save, or pass `--yes` after you have already reviewed it.
4. The script prints a fallback WhatsApp link `https://wa.me/17623205871?text=Hi%20Adam%20code-<CODE>`.
5. When the business WhatsApp number (if stored) first texts the production number, Adam claims that demo, skips detail collection, and sends the flow-2 opening (owner name when stored, plus the business name, and `1️⃣ Let's start`). They pick `1` to enter TEST. If they text from a different phone, or the demo has no phone, they send the fallback message exactly (`Hi Adam code-…`).
6. To remove a demo, look it up by prospect id, code, or phone:

   `node scripts/delete-demo.js --id <prospect id>`

   or `--code <CODE>` / `--phone +E164`. `--dry-run` prints row counts per table plus local `demo-output/<id>/` paths and deletes nothing. Type `y` or pass `--yes` to delete. A claimed demo refuses until you pass `--include-claimed`, which also deletes that sender's profile, session, messages, inbound, and leads (children first, then `easybot_senders`, then the demo row). Prints counts only, never message bodies. A second run on a missing demo is a no-op. Do not commit `demo-output/`.

Expired unclaimed rows are ignored. Optional cleanup (commented in the migration, not scheduled): delete unclaimed rows with `expires_at < now()`.

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
