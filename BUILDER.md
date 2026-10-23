# How the Builder works

Describes the Builder as implemented on 2026-10-23. Questioning is model-driven. The application has no fixed question list. Prompt text tells the model what to do; it does not guarantee the model will do it. Only the application checks below are enforced.

## What it does and produces

The Builder interviews the business owner in chat and fills a draft business profile. The first line is fixed application text: it invites the owner to say what they do, says follow-ups will come, and mentions a summary to approve and `/test`. Later replies come from the model (`OPENAI_MODEL`, otherwise `gpt-4o-mini`).

The draft can hold: business name, what the business does, services (name, price, notes), hours, location or service area, common customer questions (FAQ), information the bot should collect from the customer (intake), explicit unknowns, and tone. Unknown text fields are stored as null. `informationToCollect` uses a different convention: **null** means the owner has not been asked yet; **[]** means the owner said collect nothing; a non-empty array lists the items. Each turn saves that draft. Live approved fields change only when the model marks the turn approved and the minimum below is met. Approval writes `data/business-profile.json` (with `approvedAt`) and syncs a Flowise chatflow whose customer prompt is built from those approved fields, including unknowns and intake items.

## What it asks

Nothing in code is labeled mandatory, optional, or conditional except the intake gate below. The prompt tells the model to discover topics **when relevant**, and that partial information is fine. It lists:

- What the business does
- Services and offerings
- Prices, if the owner has them, and how a price applies when that matters (per unit versus flat or per booking)
- Opening hours or availability
- Location or service area
- Common customer questions (FAQ: questions customers ask the business; the Business Bot answers these from approved facts)
- Information the bot should collect from the customer (intake: name, phone, preferred day/time, and similar; the Business Bot asks for these in chat)
- Preferred tone

The prompt tells the model to keep FAQ items in `commonQuestions` and intake items in `informationToCollect`, and not to mix them. It also tells the model to clarify ambiguities that would change a customer answer: pricing basis or units, discounts, what a service area covers, hours edge cases, cancellation or refund policy, and booking or availability rules. It says capacity or group size does not settle how price scales. Whether any of these questions actually appear depends on the model and the conversation. **Unverified:** which of these the model asks in a given interview.

Application checks (enforced):

1. **Approval minimum** — `hasEnoughForFirstBot` is true when there is a name or a description of what they do, and there is at least one service or that same description. A description alone can pass. A name with no description and no service cannot. Hours, location, prices, common questions, tone, unknowns, and a non-empty intake list are not required by this check.
2. **Intake answered before review** — if the model sets ready for review or approved while `informationToCollect` is not an array (still null / unanswered), the app refuses approval, does not append the approve summary, and appends a fixed question asking whether the customer bot should collect anything (and what, or none). Empty array is enough to pass this gate.

Seeded or hand-written profiles that omit `informationToCollect` are treated as nothing to collect when building the Flowise customer prompt; they do not go through the interview gate.

## Follow-ups and “enough”

The prompt tells the model to ask one or two questions at a time, adapt them to what was already said, and not repeat answered questions. The application does not count questions or pick the next one. It does send the current draft and a hint: either enough may already exist for a first bot, or basics are still missing, or intake is still unanswered.

The prompt tells the model to set ready for review once there is identity plus at least one offering or a clear description **and** `informationToCollect` is an array, then show a short summary of known facts and explicit unknowns and ask the owner to approve, correct, or say “approve”. Code does not turn that hint into ready-for-review by itself. If the model does set ready for review and does not mark the turn approved, and its message does not already contain “approve”, the app appends a fixed summary (name, what they do, services, hours, location, tone, common questions, information to collect, unknowns) plus a line to reply **approve** or correct something.

## Unknowns, contradictions, and corrections

The prompt tells the model not to invent facts. If the owner says something is undecided, unknown, or “not sure yet”, the model is told to put a clear statement in `unknowns` and keep the known parts in the normal fields. Null means a text field is unknown. The prompt tells it to notice contradictions and ambiguous spots gently.

On a correction or a later clarification, the prompt tells the model to update the draft immediately, drop resolved unknowns, show what changed, and ask for approval again. Code does not detect contradictions, unknowns, or corrections. On approval it copies non-empty text fields and replaces services, common questions, information to collect, and unknowns only when the draft includes those arrays. A null or blank text field does not clear a value already stored. An omitted array leaves the previous list in place. A null `informationToCollect` in the draft does not clear a previously settled array.

If the model reply is not valid JSON, the app keeps the previous draft and does not approve.

## Review, `/test`, `/end`, and later edits

The owner reviews the model’s message and, when the app appends it, the fixed summary. The prompt tells the model to set approved when the owner says “approve”, “looks good”, or “yes” after a summary. Code does not read those words. It approves when the model sets approved, the identity/offering minimum above is met, and `informationToCollect` is an array, then syncs Flowise. If the model sets approved before that minimum, the app refuses, keeps the draft unapproved, and forces the review summary (or the intake question if intake is still unanswered). There is no code requirement for a separate review turn before the approving turn.

`/test`, `/end`, and `/reset` are exact chat commands handled by the app, not the model. `/test` needs both `approvedAt` and a chatflow id. It switches to TEST mode, starts a new customer conversation, and sends messages to Flowise. TEST chat does not change the Builder transcript or the approved profile. `/end` switches back to BUILD and invites updates or another `/test`. It does not clear the approved profile. `/reset` wipes the saved profile and the in-memory chats and shows the opening line again.

A later edit in BUILD is another interview turn. The prompt tells the model to update the draft, show the change, and leave it unapproved until the owner confirms. The pending draft is saved immediately; the live fields and the Flowise bot stay as last approved until a later turn is marked approved and syncs. If that sync fails, the new facts are still saved as approved locally. `/test` then uses the previous chatflow when one exists, and is blocked when none exists.

Chat transcript is memory in the running server. The profile file, including the latest draft, is what remains after a restart. **Unverified:** that the model always waits for confirmation, preserves every unknown, splits FAQ vs intake correctly without the gate, or treats “yes” only as approval after a summary.
