---
name: e2e-fix-loop
description: >-
  Runs easyBot end-to-end tests, fixes failures, and re-runs only the failed
  suite or adaptive business. Use when the user asks to run e2e, e2e tests,
  e2e:ambiguity, or e2e:adaptive, or to fix failing end-to-end tests.
---

# E2E fix loop

Run the end-to-end tests. If something fails, fix the cause, then run again only what failed.

## Preconditions

`GET http://localhost:3080/api/health` must show OpenAI and Flowise up. App: `npm start`. Flowise: `npm run flowise`. Do not run a suite against a down server.

## First run

Run only the suites the change can affect.

| Area | Command |
|---|---|
| Builder interview, approval, `/test`, `/end`, yoga workflow | `npm run e2e` |
| Unknowns, fabrication, customer prompt | `npm run e2e:ambiguity` |
| Adaptive Tester-as-Owner | `ADAPTIVE_BUSINESS=<id> npm run e2e:adaptive` |

If the user says to run the e2e tests and names no suite, run `npm run e2e` and `npm run e2e:ambiguity`.

Adaptive is expensive. Do not run every fixture unless the user asked. Fixture ids: `yoga-teacher`, `fitness-coach`, `dog-walker`, `home-baker`, `intake-barber`. One id per command (`ADAPTIVE_BUSINESS` accepts a single id).

## On failure

1. Read `FAIL` lines and the summary (` - <name> <detail>`). For adaptive, also read ` - <id>: failed`.
2. Fix the cause in product code. Do not loosen a check, stub the judge, set `JUDGE_MODE=stub` to hide a failure, or edit an expectHint so a wrong answer passes. A wrong test assertion may be fixed when the approved facts and `BUILDER.md` show the test is the bug.
3. If the summary says judge calibration failed, semantic `FAIL` / `REVIEW` results are unreliable. Fix calibration before changing Builder or Business Bot behavior for those checks.
4. Re-run only what failed. Leave passing suites alone.

### Failed scope

- One or more checks inside `npm run e2e` or `npm run e2e:ambiguity`: re-run that script only. Checks share one chat and profile. Skipping earlier checks is not a valid re-run. Do not re-run the other script.
- One or more adaptive businesses: re-run `ADAPTIVE_BUSINESS=<id> npm run e2e:adaptive` once per failed id. Do not re-run businesses that passed. Health checks and calibration inside that command are required setup.
- Do not re-run a suite that already passed in this loop.

## Stop

Repeat fix and targeted re-run until that failed scope passes, or the same failure is still failing after three fix attempts. Then stop and report.

## Report

- Commands run, and pass/fail counts
- What you changed
- The re-run command for the failed scope
- Any `FAIL` names still open
