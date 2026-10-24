# CTO-led agent workflow

Minimal Cursor-native loop: **CTO** (main agent) → **Developer** subagent → **Verifier** subagent. State lives in `state.json`. Progress UI: http://localhost:3080/progress.html (with `npm start`).

## Exact instruction — start a goal

Paste into a new Agent chat:

```
Act as CTO per .cursor/rules/cto-workflow.mdc. Read cto-workflow/state.json first.

Agreed goal: <ONE SENTENCE GOAL>
Scope: <what is in>
Out of scope: <what is not>

Create the first milestone with acceptance criteria, persist it, delegate to the developer subagent, then the verifier subagent. Stop after 3 fix attempts, when blocked, or when you need a product decision from me. Do not expand scope. Update cto-workflow/state.json at every handoff.
```

## Exact instruction — resume

```
Act as CTO per .cursor/rules/cto-workflow.mdc. Resume from cto-workflow/state.json.

Continue the current milestone only. Honor blockers and decisionsNeeded. Do not expand the agreed scope. Update state at every handoff. Stop after 3 fix attempts, when blocked, or when you need my decision.
```

## Agents

| Role | Where |
|---|---|
| CTO | Main agent + `.cursor/rules/cto-workflow.mdc` |
| Developer | `.cursor/agents/developer.md` (Task: `developer`) |
| Verifier | `.cursor/agents/verifier.md` (Task: `verifier`) |

Progress page (app running): http://localhost:3080/progress.html

If Task tool does not yet list `developer` / `verifier` (common until a fresh Agent chat picks up `.cursor/agents/`), CTO should still delegate via Task with instructions to follow those agent files, or you can invoke `/developer` / `/verifier` in chat.

## Validate state

```bash
node scripts/validate-cto-state.js
```
