# CTO workflow state schema (v1)

File: `cto-workflow/state.json`

| Field | Meaning |
|---|---|
| `version` | Schema version; currently `1` |
| `updatedAt` | ISO timestamp of last handoff write |
| `goal` | Agreed goal: `id`, `title`, `description`, `status` (`active` \| `completed` \| `blocked` \| `paused`), `agreedScope`, `outOfScope` |
| `milestones[]` | Ordered plan |
| `milestones[].acceptanceCriteria` | String list; Verifier checks each |
| `milestones[].status` | `pending` \| `in_progress` \| `implemented` \| `verified` \| `failed` \| `blocked` |
| `milestones[].fixAttempts` / `maxFixAttempts` | Fix loop; stop at max (default 3) |
| `milestones[].implementation` | Developer claim: `complete`, `completedAt`, `summary`, `checksRun[]`, `remainingIssues[]` |
| `milestones[].verification` | Independent: `independent`, `verdict` (`pass` \| `fail` \| `blocked` \| `needs_decision` \| null), `verifiedAt`, `evidence[]`, `failedChecks[]`, `notes` |
| `currentMilestoneId` | Active milestone or null |
| `agents` | `cto` / `developer` / `verifier`: `{ status, activity }` — `status` is `idle` \| `working` \| `waiting` |
| `blockers[]` | `{ id, at, message, milestoneId? }` |
| `decisionsNeeded[]` | `{ id, at, question, milestoneId? }` |
| `activity[]` | Newest last: `{ at, actor, type, message, milestoneId? }` |
| `stale` | `{ interrupted, reason }` — honest interrupted / abandoned work |

**Rule:** `implemented` ≠ `verified`. Only Verifier sets `verified` after independent evidence.
