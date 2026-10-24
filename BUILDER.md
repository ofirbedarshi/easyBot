# How the Builder works

Describes the Builder as implemented on 2026-10-24. Questioning is model-driven. The application has no fixed question list. Prompt text tells the model what to do; it does not guarantee the model will do it. Only the application checks below are enforced.

## What it does and produces

The Builder interviews the business owner in chat and fills a draft business profile. The first line is fixed application text: it frames the Builder as a new teammate learning how the business handles inquiries, invites the owner to say what they do and what they want the customer bot to achieve, and mentions a summary to approve and `/test`. Later replies come from the model (`OPENAI_MODEL`, otherwise `gpt-4o-mini`).

The draft can hold: business name, what the business does, **ownerGoal** (desired outcome for the customer bot), services (name, price, notes), hours, location or service area, common customer questions (FAQ), information the bot should collect from the customer (intake), explicit unknowns, and tone. Unknown text fields are stored as null. `ownerGoal` stays null until the owner clarifies an outcome — the app never invents a goal. `commonQuestions` is an array of `{ question, answer }` objects: `question` is what customers ask; `answer` is the owner’s explanation the Business Bot may tell customers. Legacy bare strings are normalized on load/merge to `{ question, answer: "" }`. Only FAQ items with a non-empty `answer` are injected into the Flowise customer prompt as approved facts. `informationToCollect` uses a different convention: **null** means the owner has not been asked yet; **[]** means the owner said collect nothing; a non-empty array lists the items. Each turn saves that draft. Live approved fields change only when the model marks the turn approved and the minimum below is met. Approval writes the profile (with `approvedAt`) and syncs a Flowise chatflow whose customer prompt is built from those approved fields: approved business facts (identity, services, hours, location, FAQ answers), explicit unknowns, intake whitelist, and — separately — `ownerGoal` as conversational direction only (not a customer-facing fact source). There is no approved language field; the Business Bot prompt tells the model to match the customer’s language as a behavior setting.

**Demo scope (prompt):** the customer bot may answer from approved facts, clarify needs, collect listed intake in chat, and suggest the customer message the owner directly. It cannot book calendars, take payments, sync a CRM, or save/deliver an inquiry. An approved fact may describe a business process (for example that the owner confirms bookings), but that does not prove the bot saved details, sent a message, completed a handoff, or made a booking — those claims need an actual successful operation, which this demo does not perform. The system does **not** persist or deliver customer inquiries to the owner — only in-chat collect + redirect wording.

## What it asks

Nothing in code is labeled mandatory, optional, or conditional except the intake gate below. The prompt tells the model to start with the business and desired outcome (not a feature checklist), help vague goals without inventing `ownerGoal`, absorb one-message dumps, allow mid-setup direction changes, and for unsupported requests clearly refuse and offer an in-scope alternative. It also discovers topics **when relevant** (partial information is fine):

- What the business does
- Owner goal / desired outcome for the bot (`ownerGoal`)
- Services and offerings
- Prices, if the owner has them, and how a price applies when that matters (per unit versus flat or per booking)
- Opening hours or availability
- Location or service area
- Common customer questions (FAQ: each entry is a customer question plus the owner’s answer; the Business Bot may use those answers as approved facts)
- Information the bot should collect from the customer (intake: name, phone, preferred day/time, and similar; the Business Bot asks for these in chat)
- Preferred tone

The prompt tells the model to keep FAQ items in `commonQuestions` as `{ question, answer }` (full answer text when the owner explained it — not topic titles alone) and intake items in `informationToCollect`, and not to mix them. It also tells the model to clarify ambiguities that would change a customer answer: pricing basis or units, discounts, what a service area covers, hours edge cases, cancellation or refund policy, and booking or availability rules. It says capacity or group size does not settle how price scales. Whether any of these questions actually appear depends on the model and the conversation. **Unverified:** that the model always stores the full owner answer in `commonQuestions[].answer` rather than a truncated paraphrase, always leaves `ownerGoal` null until clarified, always refuses unsupported capabilities cleanly, and which clarification questions it asks in a given interview.

Application checks (enforced):

1. **Approval minimum** — `hasEnoughForFirstBot` is true when there is a name or a description of what they do, and there is at least one service or that same description. A description alone can pass. A name with no description and no service cannot. Hours, location, prices, common questions, tone, unknowns, `ownerGoal`, and a non-empty intake list are not required by this check.
2. **Intake answered before review** — if the model sets ready for review or approved while `informationToCollect` is not an array (still null / unanswered), the app refuses approval, does not append the approve summary, and appends a fixed question asking whether the customer bot should collect anything (and what, or none). Empty array is enough to pass this gate.

Seeded or hand-written profiles that omit `informationToCollect` are treated as nothing to collect when building the Flowise customer prompt; they do not go through the interview gate.

## Follow-ups and “enough”

The prompt tells the model to ask one or two questions at a time, adapt them to what was already said, and not repeat answered questions. The application does not count questions or pick the next one. It does send the current draft and a hint: either enough may already exist for a first bot, or basics are still missing, or intake is still unanswered.

The prompt tells the model to set ready for review once there is identity plus at least one offering or a clear description **and** `informationToCollect` is an array, then show a short summary of known facts (including `ownerGoal` when set) and explicit unknowns and ask the owner to approve, correct, or say “approve”. Code does not turn that hint into ready-for-review by itself. If the model does set ready for review and does not mark the turn approved, and its message does not already contain “approve”, the app appends a fixed summary via `formatSummary` plus a line to reply **approve** or correct something. The summary always includes an **Owner goal** line (`(not set)` when null). FAQ entries without an answer are shown as not recorded yet. When the profile is already approved and the pending draft differs from live fields, the summary shows **Live approved (active customer bot)** and **Pending (not live until you approve)** blocks so draft edits are not mistaken for the active bot.

## Unknowns, contradictions, and corrections

The prompt tells the model not to invent facts (including not inventing `ownerGoal`). If the owner says something is undecided, unknown, or “not sure yet”, the model is told to put a clear statement in `unknowns` and keep the known parts in the normal fields. Null means a text field is unknown. The prompt tells it to notice contradictions and ambiguous spots gently.

On a correction or a later clarification, the prompt tells the model to update the draft immediately, drop resolved unknowns, show what changed, and ask for approval again. Code does not detect contradictions, unknowns, or corrections. On approval it copies non-empty text fields (including `ownerGoal`) and replaces services, common questions, information to collect, and unknowns only when the draft includes those arrays. A null or blank text field does not clear a value already stored. An omitted array leaves the previous list in place. A null `informationToCollect` in the draft does not clear a previously settled array.

If the model reply is not valid JSON, the app keeps the previous draft and does not approve.

## Review, `/test`, `/end`, and later edits

The owner reviews the model’s message and, when the app appends it, the fixed summary. The prompt tells the model to set approved when the owner says “approve”, “looks good”, or “yes” after a summary. Code does not read those words. It approves when the model sets approved, the identity/offering minimum above is met, and `informationToCollect` is an array, then syncs Flowise. If the model sets approved before that minimum, the app refuses, keeps the draft unapproved, and forces the review summary (or the intake question if intake is still unanswered). There is no code requirement for a separate review turn before the approving turn.

`/test`, `/end`, and `/reset` are exact chat commands handled by the app, not the model. `/test` needs `approvedAt`, a chatflow id, and `flowiseSyncOk` (set only after Flowise create/update succeeds for that approval). It switches to TEST mode, starts a new customer conversation, and sends messages to Flowise. TEST chat does not change the Builder transcript or the approved profile. `/end` switches back to BUILD and invites updates or another `/test`. It does not clear the approved profile. `/reset` wipes the saved profile and the chats and shows the opening line again.

A later edit in BUILD is another interview turn. The prompt tells the model to update the draft, show the change, and leave it unapproved until the owner confirms. The pending draft is saved immediately; the live fields and the Flowise bot stay as last approved until a later turn is marked approved and syncs.

**Flowise sync (enforced):** On approval the app pings Flowise (short timeout) and tries create/update. If Flowise is up, sync runs in that turn and `flowiseSyncOk` becomes true. If Flowise is down, cold-starting, or the sync errors (e.g. Render 502 HTML), the app still saves approved facts locally, sets `flowiseSyncPending` + `flowiseSyncRequestedAt`, kicks a wake ping, and tells the owner sync usually takes 1–2 minutes — it does **not** put full error HTML into the chat history. A background Flowise sync worker (same process gate as the WhatsApp inbound worker) polls pending profiles, retries sync when ping succeeds, then WhatsApp-notifies “ready — type /test” (and appends that line to Builder history). If still down after ~5 minutes (`FLOWISE_SYNC_MAX_WAIT_MS`), it notifies once that sync gave up and clears `flowiseSyncPending`; the owner can say **approve** again later. While pending, `/test` replies that sync is still in progress. Flowise error strings stored in replies are truncated so they cannot blow the next Builder context window.

**Browser / local e2e:** profile file on disk; session transcript in memory (file-backed sessions). **WhatsApp:** each sender has isolated session + profile + inbound queue in Supabase (`easybot_*` tables). The Twilio webhook validates `X-Twilio-Signature`, enqueues by `MessageSid`, ACKs quickly, and a durable worker processes messages in order per sender. **Unverified:** that the model always waits for confirmation, preserves every unknown, stores full FAQ answers (not truncated paraphrases), leaves `ownerGoal` unset until clarified, splits FAQ vs intake correctly without the gate, or treats “yes” only as approval after a summary.
