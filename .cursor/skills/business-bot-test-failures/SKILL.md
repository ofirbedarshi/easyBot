---
name: business-bot-test-failures
description: >-
  Diagnoses and fixes failed Business Bot AI tests (semantic correctness and
  UX judges) by inspecting evidence, classifying root cause, fixing the
  underlying contract/prompt/test/setup, and verifying generalization. Use when
  a Business Bot check fails, a customer-facing reply is judged FAIL/REVIEW,
  UX bot dims fail, or the user asks to debug/fix Business Bot test failures
  or flaky bot judges — not for Builder-only failures or bare “run e2e” loops.
---

# Business Bot test failures

Diagnose **Business Bot** semantic / UX failures before changing product code.
Do not assume the bot or the judge is wrong without evidence.

**Out of scope here:** Builder-only interview failures; bare suite orchestration.
For run / re-run commands and failed-scope rules, also follow
`.cursor/skills/e2e-fix-loop/SKILL.md`. For judge overrides / rescue gates,
follow `.cursor/rules/no-judge-patches.mdc`.

Vocabulary: **Business Bot** = customer-facing bot; **Builder** = owner interview;
**Tester** = test-only actor. Prefer these names over ambiguous “bot”.

## Preconditions

- Prefer a failing artifact from the run under discussion (`data/test-results/latest.json`
  or the stamped file the suite printed). Do not “fix” from a vague FAIL name alone.
- If calibration failed, semantic/UX results may be `REVIEW` / `unreliable` — fix
  calibration before changing Business Bot behavior for those checks
  (`npm run judge:calib`; see e2e-fix-loop).

## Workflow (required order)

Copy and track:

```
- [ ] 1. Inspect evidence (no code changes yet)
- [ ] 2. Classify failure (A/B/C/D; multiple OK)
- [ ] 3. Fix underlying cause
- [ ] 4. Keep scenarios in tests (prompt example bar)
- [ ] 5. Verify generalization
- [ ] 6. Report
```

### 1. Inspect the evidence before changing anything

Gather all of the following. Stop and say what is missing if a piece cannot be found.

| Evidence | Where to get it |
|---|---|
| Customer message + relevant history | Results entry `question` / `turnRefs`; `transcript` in `data/test-results/*.json`; suite console log |
| Exact approved business facts for that run | Judge payload used `approvedConfig` / profile at judge time — recover from the check’s seed in `scripts/e2e-*.js` / `src/adaptiveRunner.js` / fixture, or profile path used by that suite. Do **not** use a later edit of `data/business-profile.json` unless it is proven to be the same snapshot |
| Generated system prompt | `buildCustomerSystemPrompt(profile)` in `src/customerPrompt.js` (Flowise injects this via `src/flowise.js`). Ambiguity suite may already log a prompt; otherwise rebuild from the **same** approved facts |
| Bot response | Results entry `outputText` / console `reply=` |
| Test expectation | Check name → `expectHint` (and any deterministic asserts) in the suite script |
| Judge instructions | Semantic: `SYSTEM_JUDGE` + payload note in `src/judge.js`. UX: `SYSTEM_UX` in `src/judgeUx.js`. Note `JUDGE_MODEL` vs `OPENAI_MODEL` |
| Failure explanation | Entry `judge.rationale`, dimension notes, `criticalFailure`, UX `score` / dim notes |

Separate **factual** failures (`judgeSemantic`, stage `business_bot_answer`) from **UX**
failures (`judgeUx`, channel `business_bot`). Same reply can fail both for different reasons.

Do not edit prompts, judges, or tests until this table is filled for the failing case.

### 2. Classify the failure

Assign one or more:

| Code | Meaning |
|---|---|
| **A** | Product/prompt contract is missing, ambiguous, or contradictory |
| **B** | The bot violated an already clear contract |
| **C** | The test or judge expects behavior the contract does not require, or penalizes behavior it allows |
| **D** | The test setup, state, or facts supplied to the bot are incorrect |

Multiple causes may apply. Do not assume the bot or judge is wrong without evidence.

Contract sources (priority for Business Bot): closed-world rules in
`src/customerPrompt.js` → approved facts for that run → semantic rubric in
`src/judge.js` → UX rubric in `src/judgeUx.js` → the check’s `expectHint`.
If these disagree, that disagreement is part of the classification (often A and/or C).

### 3. Fix the underlying cause

- **A:** Clarify the smallest reusable principle that covers the failure (usually
  `src/customerPrompt.js`, sometimes a shared helper). Prefer one general rule over
  a laundry list.
- **B:** Improve instruction clarity, priority, or structure. Do not automatically
  add a scenario-specific example.
- **C:** Align the test/judge with the intended contract. Never weaken a valid
  requirement just to get a pass. Prefer rubric / calibration / `expectHint`
  clarity; do not add silent rescue gates (see no-judge-patches).
- **D:** Fix the setup or implementation (wrong seed profile, stale Flowise sync,
  wrong profile path, missing approve, bad fixture, etc.).

If intended behavior is genuinely unclear, identify the product decision instead of
silently inventing it. Ask the user before choosing.

### 4. Keep concrete scenarios primarily in regression tests

Do not add business-specific examples, keywords, customer names, prices, or
special-case branches to the production prompt merely because one test failed.

A prompt example is allowed only when a general rule remains insufficient and the
example teaches a reusable distinction. Explain why it is needed in the report.

Put concrete scenarios in `scripts/e2e-ambiguity.js`, `scripts/e2e-workflow.js`,
adaptive fixtures, or judge calibration — not as one-off production prompt forks.

### 5. Verify generalization

1. Re-run the failing case (use e2e-fix-loop failed-scope rules; do not skip
   earlier checks in a shared chat/profile suite).
2. Run relevant existing regressions that exercise the same principle.
3. Test materially different scenarios exercising the same principle, including a
   case where the bot **SHOULD** answer directly (not only gap/redirect cases).
4. For suspected **judge** instability, compare judgments on the **SAME saved
   response** (fixed `outputText` + same approved facts / question / expectHint).
   Regenerating the bot response does not isolate judge instability.
5. Do not retry until green and report only the passing run. If you re-ran and
   saw intermittent PASS/FAIL, report the instability and the saved-response
   comparison — do not pretend a single lucky PASS was the fix.

### 6. Report

Include:

- Failure classification (A/B/C/D) and the evidence that supports it
- General principle involved
- What changed and why (and why any prompt example was justified, if added)
- Validation results (commands, pass/fail) and remaining uncertainty

## Evidence quick map

| Artifact | Path / symbol |
|---|---|
| Latest run JSON | `data/test-results/latest.json` |
| Results viewer | app `/results` (served from results files) |
| Business Bot system prompt builder | `buildCustomerSystemPrompt` — `src/customerPrompt.js` |
| Semantic judge | `judgeSemantic` — `src/judge.js` |
| UX judge | `judgeUx` — `src/judgeUx.js` |
| Suite commands | `npm run e2e`, `e2e:ambiguity`, `e2e:adaptive` — see e2e-fix-loop |

## Anti-patterns

- Patching the judge with keyword rescues or forced PASS (forbidden without explicit user approval)
- Adding a production prompt example that only matches one failed fixture name/price
- Changing `expectHint` so a wrong reply passes
- Setting `JUDGE_MODE=stub` to hide a real failure
- Fixing UX by teaching factual lies, or fixing facts by ignoring UX contract when both failed
