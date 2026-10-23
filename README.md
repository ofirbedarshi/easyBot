# easyBot — Local POC

AI Business Bot Builder: interview a business owner → approve facts → test a Flowise customer chatbot.

## Prerequisites

- Node 18.15+ / 20+
- OpenAI API key in `.env`
- Flowise running locally on port 3000

## Setup

```bash
cp .env.example .env   # then set OPENAI_API_KEY
npm install
npm install -g flowise   # once
```

## Run

Terminal 1 — Flowise (Docker; use **1.8.3** — latest image has auth/SQLite issues for local POC):

```bash
docker run -d --name easybot-flowise -p 3000:3000 flowiseai/flowise:1.8.3
```

Terminal 2 — app:

```bash
npm start
```

Open http://localhost:3080

## Commands in chat

- `/test` — switch to customer bot (Flowise)
- `/end` — back to builder
- `/reset` — clear local profile

## Scripts

```bash
npm run spike          # create Flowise chatflow + one prediction
npm run judge:calib    # calibrate Tester judge on fixed labelled examples
npm run e2e            # full yoga-teacher workflow (app must be running)
npm run e2e:ambiguity  # fabrication / unknowns regressions + semantic judge
npm run e2e:adaptive   # adaptive Tester-as-Owner (fixtures; real /api/chat only)
```

Adaptive suite env: `ADAPTIVE_BUSINESS=yoga-teacher` (one business), `OWNER_TURN_LIMIT=20`, `ADAPTIVE_CONCURRENCY=2` (parallel businesses; default 2). Fixtures under `fixtures/businesses/`. Backs up/restores `data/business-profile.json` around the run. Each fixture uses an isolated session writing `data/test-profiles/<id>.json` (cleaned before/after the run).

Tester NL checks use a **separate judge call** (not phrase regex). Results: `data/test-results/latest.json` + stamped history; viewer http://localhost:3080/results.html (run picker + transcripts). Set `JUDGE_MODE=stub` to avoid paid judge calls.

## Notes

- Approved profile (UI): `data/business-profile.json`
- Adaptive e2e profiles: `data/test-profiles/<fixture-id>.json`
- Builder behavior (what it asks and approves): [BUILDER.md](BUILDER.md)
- Graph template: `templates/customer-bot.flowise.json` (full nodes+edges)
- Leave `FLOWISE_API_KEY` empty unless Flowise auth is enabled
