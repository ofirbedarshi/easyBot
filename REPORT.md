# easyBot POC — Results Report

Date: 2026-10-23

## Verdict

**POC succeeded.** Yoga-teacher workflow works end-to-end with **real OpenAI** (builder) and **real Flowise** (customer bot). No mocked LLM replies in the evaluated path.

## Fabrication fix (2026-10-23)

**Cause:** Approved config stored `$10 per hour` + capacity notes, but no pricing basis and no `unknowns`. Customer system prompt allowed inference; capacity was treated as “flat rate regardless of quantity.” Builder had nowhere to preserve “undecided” policies.

**Fix:** Profile `unknowns[]`; builder captures pricing-basis / policy ambiguities; customer prompt distinguishes approved facts vs supported conclusions vs unknowns (no capacity→price, no contact promises). Tester: `npm run e2e:ambiguity` (29 real Flowise/LLM checks).

**Before (real Flowise, old prompt):** `The price for dog walking is $10 per hour, regardless of the number of dogs. So it would still be $10 for both dogs!`

**After (real Flowise, fixed):** `The price is $10 per hour, but I can't confirm how that rate applies to multiple dogs.`

## How to run (current)

```bash
# Flowise (pinned — see below)
docker run -d --name easybot-flowise -p 3000:3000 flowiseai/flowise:1.8.3

# App
cd easyBot && npm start
# → http://localhost:3080
```

## What works

| Area | Result | Source |
|------|--------|--------|
| Flowise spike (create chatflow + prediction) | Pass — bot answered `$70` | real-flowise + real-llm |
| Builder interview (natural Qs, 1–2 at a time) | Pass | real-llm |
| Summary + approve → sync Flowise graph | Pass | real-llm + real-flowise |
| `/test` / `/end` in app code | Pass | app |
| Customer: normal price question | Pass (`$70` then `$80`) | real-flowise |
| Customer: missing booking policy | Pass — admits unknown | real-flowise |
| Customer: override price to `$20` | Pass — refuses; profile unchanged | real-flowise + app |
| Owner price edit `$80` → re-approve → retest | Pass | real-llm + real-flowise |
| Persist after app restart | Pass — still `$80` via Flowise | app + real-flowise |
| UI at `:3080` | Pass — BUILD/TEST, health line | browser |

E2E script: **17/17 passed** (`npm run e2e`).

## Flowise notes (important)

1. **`flowiseai/flowise:latest`** crashed locally (`SQLiteStore` / `db.exec`).
2. **`2.2.8`** returned `401 Unauthorized` on chatflow APIs without UI setup.
3. **`1.8.3`** worked for local POC: open APIs, create chatflow, prediction OK.
4. Graph template: [`templates/customer-bot.flowise.json`](templates/customer-bot.flowise.json) — full nodes+edges (ChatOpenAI + BufferMemory + ConversationChain), not a prompt-only file.
5. Global `npm install -g flowise` was incomplete/broken (`@oclif/core`); Docker path used instead.

## What failed / friction

- npm/global Flowise install too slow and broken — switched to Docker.
- Latest Flowise unsuitable for zero-config local API; pinned **1.8.3**.
- Long image pulls (~2–4 min first time) — one-time cost.

## Unverified / out of scope

- Multi-business / multi-tenant
- WhatsApp, calendar, CRM, payments, auth
- Flowise versions newer than 1.8.3 with proper API-key auth wired in `.env`
- Long interview quality beyond the scripted Maya yoga path (human judgment still useful)
- Cost exact spend (used `gpt-4o-mini`; should stay well under $5 for this run)

## Architecture used

- **BUILD:** OpenAI SDK directly (structured JSON interview + draft)
- **TEST:** Flowise prediction on synced chatflow
- **Persist:** `data/business-profile.json`
- **Commands:** `/test`, `/end`, `/reset` handled in app, not LLM
