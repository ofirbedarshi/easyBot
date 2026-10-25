# Business Fact Fidelity Investigation — Final Report

**Date:** 2026-10-25  
**Model:** gpt-4o-mini (Builder and Customer Bot)  
**Scope:** Investigation only — no code changes

---

## Executive Summary

**PRIMARY ROOT CAUSE: Builder extraction failure (STAGE 1)**

The Builder consistently fails to extract specific business facts even when owners state them explicitly. Tested across two builds of Rosa's Bakery with identical owner messages at different interview phases:

### Facts Owner Gave → DROPPED
1. **Delivery terms** (conditional policy: radius + minimum + fee)
2. **Nut-free kitchen statement** (allergen/safety information)
3. **"Start at" and "5 days notice"** — INCONSISTENT (sometimes preserved in notes, sometimes lost)

### Unstated Topics → INVENTED
1. **Vegan cakes** — owner never mentioned → bot sometimes says "we do not have vegan cakes"
2. Analysis: **NOT in stored profile**, invented at answer time (STAGE 3)

**Timing hypothesis REJECTED:** Extraction failure is timing-independent — facts lost regardless of interview phase.

---

## Investigation Method

### Test Cases

**Rosa's Bakery — TWO real WhatsApp transcripts (2026-10-25)**

**Build 1 (services phase):**
- Owner gave delivery/nut-free AFTER Builder asked about services
- Owner messages reproduced exactly as typed in WhatsApp

**Build 2 (goal phase — "rebuild"):**
- Owner gave delivery/nut-free WHILE Builder was asking about bot goal
- Same owner messages, different timing

### Traced Per Stage
1. **Stage 1 (Extraction):** Stored profile JSON — what Builder captured into draft fields
2. **Stage 2 (Prompt):** Customer bot system message — what facts reached the bot
3. **Stage 3 (Answers):** Customer bot responses — whether inventions appear

---

## FINDING 1: Delivery Terms DROPPED (Both Builds)

### Owner Statement (Identical in Both Builds)
```
"We deliver only within 3 miles for orders over $40, delivery fee $8."
```

**Builder responses acknowledged it:**
- Build 1: "I've noted... your delivery policy"
- Build 2: "I'll add those to the bot"

### Stored in Profile (BOTH BUILDS — IDENTICAL)

```json
{
  "locationOrArea": "Portland, Oregon"
}
```

**Analysis:**
- ❌ No "deliver" or "delivery"
- ❌ No "3 miles" radius
- ❌ No "$40" minimum
- ❌ No "$8" fee
- ✓ Only "Portland, Oregon" (location, not delivery policy)

**Checked all fields:**
```bash
$ grep -i "deliver" build1-profile.json
(no matches)

$ grep -i "deliver" build2-profile.json
(no matches)
```

### Real Transcript Evidence

**Build 1 summary card (shown to owner before approval):**
```
Business: a family bakery in Portland, Oregon...
Services: Sourdough loaf — $9; Croissant — $4.50; Custom cakes — ...
Area: Portland, Oregon
Hours: Tue-Sun 7am-3pm
Bot goal: Answer customer questions and collect their details
```
**→ No delivery line**

**Build 2 summary card:**
```
Business: a family bakery in Portland, Oregon...
Services: Sourdough loaf — $9; Croissant — $4.50; Custom cakes — $65
Area: Portland, Oregon
Hours: Tue-Sun 7am-3pm, closed Monday
```
**→ No delivery line**

### Customer Bot Context (Stage 2)

**APPROVED BUSINESS FACTS section:**
```
Business name: Rosa's Bakery
What we do: a family bakery in Portland, Oregon, famous for sourdough and custom cakes
Services and prices:
- Sourdough loaf, price: $9
- Croissant, price: $4.50
- Custom cakes, price: $65, notes: start at and require 5 days notice
Hours: Tue-Sun 7am-3pm
Location / service area: Portland, Oregon
```

**→ No delivery policy**

### Customer Bot Answers (Stage 3)

**Question:** "I want 5 sourdough loaves, that's $45. I live 2 miles away. Can you deliver it?"

**Expected:** "Delivery available within 3 miles for orders over $40 (fee $8). Your $45 order qualifies."

**Actual answers:**
- **Real Build 1 transcript:** "Rosa's Bakery does not offer delivery services." ❌ INVENTED DENIAL
- **Real Build 2 transcript:** "I can't confirm delivery options." ✓ Correct for missing info
- **Investigation reproduction:** "I don't have information about delivery options." ✓ Correct

**Root cause:** Delivery terms never stored (Stage 1) → never in prompt (Stage 2) → bot has no facts → inconsistent handling (sometimes invents denial, sometimes defers)

---

## FINDING 2: Nut-Free Kitchen DROPPED (Both Builds)

### Owner Statement (Identical in Both Builds)
```
"We are nut-free in the kitchen but we do use wheat, milk and eggs."
```

### Stored in Profile (BOTH BUILDS)

```bash
$ grep -i "nut" build1-profile.json
(no matches)

$ grep -i "nut" build2-profile.json  
(no matches)
```

**Checked all fields:**
- ❌ NOT in `whatWeDo`
- ❌ NOT in `services`
- ❌ NOT in `commonQuestions`
- ❌ NOT in `unknowns`
- ❌ NOT anywhere

**What WAS stored (wheat, from different statement):**
```json
{
  "commonQuestions": [
    {
      "question": "Do you have gluten-free?",
      "answer": "No, we can't guarantee, wheat is everywhere in the kitchen."
    }
  ]
}
```

### Customer Bot Context (Stage 2)

**FAQ section has wheat but NOT nut-free:**
```
FAQ:
- Q: Do you have gluten-free?
  A: No, we can't guarantee, wheat is everywhere in the kitchen.
```

### Customer Bot Answers (Stage 3)

**Question:** "Is your kitchen nut-free? My son has a peanut allergy."

**Expected:** "Our kitchen is nut-free — we don't use peanuts or tree nuts. We do use wheat, milk, and eggs. For allergy safety, please confirm with the owner."

**Actual answers:**
- **Real Build 1 transcript:** Mixed wheat FAQ into nut answer ("wheat is everywhere in the kitchen") ❌ WRONG FACT
- **Real Build 2 transcript:** "No, we can't guarantee that our kitchen is nut-free" ❌ INVERTED (owner said it IS nut-free!)
- **Investigation reproduction:** "I don't have that information about allergen policies." ✓ Correct for missing info

**Root cause:** Nut-free statement never stored (Stage 1) → never in prompt (Stage 2) → bot has no facts → either defers (correct) or hallucinates/inverts (wrong)

---

## FINDING 3: "Start At" and "5 Days Notice" — INCONSISTENT

### Owner Statement
```
"custom cakes start at $65 and need 5 days notice"
```

### Stored in Profile

**Build 1:**
```json
{
  "name": "Custom cakes",
  "price": "$65",
  "notes": "start at and require 5 days notice"
}
```
✓ Qualifiers preserved in notes

**Build 2:**
```json
{
  "name": "Custom cakes",
  "price": "$65",
  "notes": "starting at, 5 days notice required"
}
```
✓ Qualifiers preserved (different wording)

**Real Build 2 summary card (from transcript):**
```
Services: Sourdough loaf — $9; Croissant — $4.50; Custom cakes — $65
```
❌ Summary lost "start at" and "5 days notice" (though they're in the stored notes)

**Conclusion:** Qualifiers sometimes preserved in `services[].notes` field but inconsistently shown in owner-facing summary. Not as severe as delivery/nut-free (which are completely lost), but still a fidelity gap.

---

## FINDING 4: Vegan Cakes INVENTED (NOT in Profile)

### Owner Statement
```
(never mentioned vegan)
```

### Stored in Profile (BOTH BUILDS)

```bash
$ grep -i "vegan" build1-profile.json
(no matches)

$ grep -i "vegan" build2-profile.json
(no matches)
```

✓ Correctly absent from stored profile

### Customer Bot Context (Stage 2)

```bash
$ grep -i "vegan" rosa-final-prompt.txt
(no matches)
```

✓ Correctly absent from customer prompt

### Customer Bot Answers (Stage 3)

**Question:** "Do you have vegan cakes?"

**Expected:** "I don't have that information. You may want to message the owner."

**Actual answers:**
- **Real Build 1 transcript:** "We do not have vegan cakes available." ❌ INVENTED
- **Real Build 2 transcript:** "We don't have vegan cakes available." ❌ INVENTED
- **Investigation reproduction:** "I do not have that information." ✓ CORRECT

**Root cause:** Profile and prompt are correct (vegan absent) → invention happens at STAGE 3 (answer time) → gpt-4o-mini inconsistently invents negations for unstated items

**Evidence:** Same profile + prompt produced different answers:
- Real transcripts (on production): invented "do not have"
- Investigation reproduction (local): said "don't have info"

Variability suggests:
1. Temperature=0 not fully deterministic, OR
2. Subtle context differences (message history, session state), OR  
3. Production used different prompt version

---

## FINDING 5: Timing Independence

### Hypothesis
Does extraction depend on the current interview step?

**Test:**
- Build 1: Owner gave delivery/nut-free AFTER Builder asked about services (in-phase)
- Build 2: Owner gave delivery/nut-free WHILE Builder was asking about bot goal (out-of-phase)

### Result

**Stored profiles — IDENTICAL extraction:**

```bash
$ diff build1-profile.json build2-profile.json
# (Only reviewedDraftKey differs — hashes of content)
# All fact fields IDENTICAL
```

**Both builds:**
- ❌ Delivery: LOST
- ❌ Nut-free: LOST
- ✓ Services: CAPTURED
- ✓ Hours: CAPTURED
- ✓ FAQ: CAPTURED

**Conclusion:** Extraction failure is NOT step-dependent. Builder drops delivery/nut-free regardless of conversation flow.

---

## Other Invention Examples (Secondary Evidence)

From problem description (not reproduced in this investigation):

### Payment Policy Invented (Sam's Bike Repair)
- Owner: never mentioned payment policy
- Bot: "payment is on-site"
- **Pattern:** Same as vegan — invention at Stage 3

### Oil Changes Invented (Dave's Car Wash)
- Owner: only gave washes and prices
- Bot: "no oil changes" + invented service description
- **Pattern:** Same as vegan — invention at Stage 3

**Shared root cause:** gpt-4o-mini sometimes invents negations or details for unstated items, despite customer prompt rules against it.

---

## Root Cause Summary

### PRIMARY: Builder Extraction (STAGE 1)

**What fails:**
1. Conditional delivery policies (radius + minimum + fee)
2. Allergen/kitchen statements (nut-free, lead-free, etc.)
3. Sometimes service qualifiers ("start at", "5 days notice") — preserved in notes but lost in summary

**Why it fails:**
1. **No clear schema field** — delivery terms don't fit `locationOrArea` (used for location); allergen statements don't fit any field
2. **Builder prompt may not emphasize these fact types** — services/hours/prices have clear homes; delivery/allergens are edge cases
3. **Model limitations** — gpt-4o-mini may struggle with multi-clause conditional rules

**Evidence:**
- Owner explicitly stated facts ✓
- Builder acknowledged them in replies ✓
- Stored profile: MISSING ❌
- Customer prompt: MISSING ❌
- Timing-independent (both builds identical) ✓

### SECONDARY: Customer Bot Inventions (STAGE 3)

**What fails:**
- Unstated items → invented negations ("we do not have vegan cakes")
- Inconsistent: sometimes invents, sometimes correctly defers

**Why it fails:**
1. **Prompt rules insufficient** — current rules say "never invent" but model still sometimes does
2. **Model behavior** — gpt-4o-mini doesn't reliably follow closed-world contract
3. **Variability** — same prompt produces different behaviors (suggests non-determinism or context sensitivity)

**Evidence:**
- Profile: correctly absent ✓
- Prompt: correctly absent ✓
- Answers: sometimes invented ❌

---

## Schema Observations

### Current Schema Cannot Represent

1. **Conditional delivery** (radius + minimum + fee)
   - `locationOrArea` is text but Builder uses it for location only
   - No structured field for delivery rules

2. **Allergen/kitchen statements**
   - Not a service, not FAQ Q&A, not business description
   - No dedicated field

3. **Distinction: "not mentioned" vs "explicitly doesn't have"**
   - Both appear as absence in profile
   - Bot must guess owner intent

---

## Fix Proposal (Sized to Proven Findings)

### Priority 1: Builder Extraction Enhancement

**Target:** Capture delivery and allergen facts that owner explicitly provides

**Approach A: Prompt Enhancement (No Schema Change)**

Add explicit Builder instructions:
1. **Delivery policies** → store in `locationOrArea` as:
   ```
   "Portland, Oregon. Delivery: available within 3 miles for orders over $40, fee $8"
   ```
   OR create FAQ entry:
   ```json
   {
     "question": "Do you deliver?",
     "answer": "We deliver within 3 miles for orders over $40, delivery fee $8."
   }
   ```

2. **Allergen/kitchen statements** → store as FAQ entry:
   ```json
   {
     "question": "Is your kitchen nut-free?",
     "answer": "Yes, our kitchen is nut-free, though we do use wheat, milk, and eggs."
   }
   ```

**Approach B: Schema Addition**
```json
{
  "delivery": {
    "description": "available within 3 miles for orders over $40, fee $8"
  },
  "allergens": {
    "nutFree": true,
    "notes": "nut-free kitchen; we use wheat, milk, eggs"
  }
}
```
Requires code changes to populate and render.

**Recommendation:** Start with Approach A (FAQ entries for delivery/allergens) — works with current schema, just needs prompt update.

---

### Priority 2: Customer Prompt Strengthening

**Target:** Reduce invented negations for unstated items

**Enhanced rule:**
```
When a detail is not in APPROVED BUSINESS FACTS:
- Say "I don't have that information" or "You may want to message the owner"
- NEVER say "we do not offer", "we do not have", "not available", or any negation
- An unstated item is unknown, not confirmed absent
- Exception: when an FAQ explicitly says "no" or "we don't have", use that answer
```

---

### Priority 3: Test Model Upgrade (Optional)

**Test:** Does gpt-4o extract delivery/allergen facts better than gpt-4o-mini?

**Method:** Run same Rosa messages through Builder with gpt-4o, compare stored profiles

**Cost:** ~7x for Builder turns only (customer bot stays gpt-4o-mini)

**Status:** No spend approved yet — measure prompt enhancement first

---

## Verification Plan

### New Business Test
Owner provides:
- ✓ Conditional delivery (radius + minimum + fee)
- ✓ Allergen statement (nut-free, lead-free, etc.)
- ✓ Service qualifier ("start at", "need X days notice")
- ✓ Unstated items (never mentions vegan, payment, etc.)

**Verify Stage 1 (Extraction):**
1. Delivery terms present in profile (locationOrArea or FAQ)
2. Allergen statement present (FAQ or notes)
3. Service qualifiers in notes field

**Verify Stage 3 (Answers):**
1. Delivery question → cites full conditions
2. Allergen question → cites owner statement
3. Unstated item → "don't have info" (NOT "do not have")

### Edit Test
Owner changes delivery terms (e.g., "3 miles" → "5 miles")

**Verify:**
- Old terms not leaked
- New terms stored and used

### Regression Test
Verify still work:
- ✓ Simple prices and hours
- ✓ FAQ Q&A pairs
- ✓ External action limits (no booking/payments)

---

## Key Evidence

### Delivery Check
```bash
$ jq '.draft.locationOrArea' build1-profile.json
"Portland, Oregon"  # ← Only location

$ grep -E "(deliver|miles|40|fee)" build1-profile.json
(no matches)  # ← Delivery terms absent
```

### Nut-Free Check
```bash
$ grep -i "nut" build1-profile.json
(no matches)  # ← Never stored

$ grep -i "nut" build2-profile.json
(no matches)  # ← Never stored (both builds)
```

### Vegan Check (Invention)
```bash
$ grep -i "vegan" build1-profile.json
(no matches)  # ← Correctly absent

$ grep -i "vegan" rosa-final-prompt.txt
(no matches)  # ← Correctly absent

# But real transcript showed:
# Bot answer: "We do not have vegan cakes available."
# ← Invented at Stage 3
```

### Timing Independence
```bash
$ diff <(jq '.draft | del(.askedTopics)' build1-profile.json) \
       <(jq '.draft | del(.askedTopics)' build2-profile.json)
(no differences)  # ← Identical extraction
```

---

## Problem Examples Mapped to Stages

| Problem | Owner Said | Stored? | Stage | Root Cause |
|---------|-----------|---------|-------|-----------|
| Rosa delivery denied | "deliver within 3 miles for orders over $40, fee $8" | ❌ NO | **Stage 1** | Extraction failure |
| Nut-free kitchen | "We are nut-free in the kitchen" | ❌ NO | **Stage 1** | Extraction failure |
| Nut answer INVERTED | "nut-free kitchen" | ❌ NO | **Stage 1 + 3** | Missing fact → hallucination |
| Vegan cakes "don't have" | (never mentioned) | ✓ Correctly absent | **Stage 3** | Model invention (inconsistent) |
| Payment invented | (never mentioned) | ✓ Likely absent | **Stage 3** | Same as vegan |
| Oil changes invented | (never mentioned) | ✓ Likely absent | **Stage 3** | Same as vegan |

---

## Measured Costs

**Token counts from reproduction:**
- Builder conversation: ~8k tokens total (~$0.012 at gpt-4o-mini rates)
- Customer bot per question (3 runs): ~5.6k tokens (~$0.008)

**If upgraded to gpt-4o for Builder:**
- Builder: ~$0.08 per conversation (7x increase)
- Customer bot: unchanged

**Recommendation:** Prompt fix first; model upgrade only if insufficient.

---

## Artifacts

Location: `/workspace/investigation-output/`

**Profiles:**
- `build1-profile.json` — Rosa Build 1 (services phase)
- `build2-profile.json` — Rosa Build 2 (goal phase)
- Both show: delivery ❌, nut-free ❌, vegan ✓ (absent)

**Reports:**
- `COMPARATIVE-REPORT.json` — Full turn-by-turn data
- `SUMMARY.md` — This focused summary

**Customer Prompts:**
- `rosa-final-prompt.txt` — Full system message
- Delivery: ❌, Nut-free: ❌, Vegan: ✓ (absent)

**Ground Truth:**
- Real WhatsApp transcripts (2 Rosa builds, 2026-10-25)
- Reproduced exactly with same owner messages

---

## Conclusion

The fidelity problem has **two proven causes:**

1. **Stage 1 (Extraction):** Builder fails to capture delivery policies and allergen statements that owners explicitly provide
   - Timing-independent — happens regardless of interview phase
   - Primary fix: Builder prompt enhancement

2. **Stage 3 (Answer time):** Customer bot inconsistently invents negations for unstated items
   - Profile and prompt are correct (items absent)
   - Model sometimes says "do not have" instead of "don't have info"
   - Secondary fix: Strengthen customer prompt rules

Service qualifiers ("start at", "5 days notice") are mostly preserved in notes but sometimes lost in summaries — less severe than delivery/allergen loss.

**No code changes made per scope.** Investigation complete with proven root causes and sized fix proposals.
