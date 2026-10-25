# Business Fact Fidelity Investigation Report
## easyBot Builder → Customer Bot

**Date:** 2026-10-25  
**Model:** gpt-4o-mini (Builder and Customer Bot)  
**Scope:** Investigation only — no code changes

---

## Executive Summary

**PRIMARY ROOT CAUSE: Builder LLM extraction failure (STAGE 1)**

The Builder (gpt-4o-mini) consistently fails to extract specific types of business facts even when owners provide them explicitly:
1. **Conditional delivery policies** (radius + minimum + fee) - LOST
2. **Allergen/kitchen statements** (nut-free, lead-free) - LOST  
3. **Hedged prices and qualifiers** ("around $X I think", "start at") - INCONSISTENT

Facts lost at extraction never reach the customer prompt, causing the customer bot to either invent denials or defer to the owner.

---

## Investigation Method

### Test Cases
1. **Rosa's Bakery (Real WhatsApp transcript, Build 1)**  
   Owner provided delivery + nut-free during services phase

2. **Rosa's Bakery Rebuild (Real WhatsApp transcript, Build 2)**  
   Owner provided same info during goal phase (out of expected step)

3. **Luna's Pottery Studio (Synthetic test)**  
   Conditional delivery, hedged price, allergen statement with caveat

### Traced Artifacts Per Stage
- **Stage 1:** Stored profile JSON (draft fields)
- **Stage 2:** Customer bot system prompt  
- **Stage 3:** Customer bot answers (3 runs per question)

---

## Findings by Stage

### STAGE 1: Extraction & Storage

#### Rosa's Bakery — Critical Message
```
Owner said: "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. 
We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. 
We deliver only within 3 miles for orders over $40, delivery fee $8."
```

#### What Got Stored (Build 1 & Build 2 — IDENTICAL)
```json
{
  "services": [
    {"name": "Sourdough loaf", "price": "$9"},
    {"name": "Croissant", "price": "$4.50"},
    {"name": "Custom cakes", "price": "$65", "notes": "start at and require 5 days notice"}
  ],
  "hours": "Tue-Sun 7am-3pm",
  "locationOrArea": "Portland, Oregon",
  "commonQuestions": [
    {
      "question": "Do you have gluten-free?",
      "answer": "No, we can't guarantee, wheat is everywhere in the kitchen."
    }
  ],
  "unknowns": []
}
```

#### What Got LOST
- **Delivery terms**: "deliver only within 3 miles for orders over $40, delivery fee $8"  
  - Not in `locationOrArea` (only has "Portland, Oregon")
  - Not in `services`
  - Not in `unknowns`
  - Not anywhere in the stored profile

- **Nut-free statement**: "We are nut-free in the kitchen"
  - Not in `whatWeDo`
  - Not in `services`
  - Not in `commonQuestions`
  - Not anywhere in the stored profile

#### Real Transcript Evidence
- Build 1 Builder response: acknowledged delivery ("deliver within 3 miles for orders over $40 with an $8 delivery fee")
- Build 1 Summary card: NO delivery line, NO nut-free line
- Build 2 Builder response: "I'll add those to the bot"
- Build 2 Summary card: "Custom cakes — $65" (lost "start at" and "5 days notice")

**Observation:** Builder acknowledges facts in its reply but fails to store them in draft fields.

---

### STAGE 2: Customer Prompt Construction

Because delivery and nut-free were never stored, they never reached the customer prompt.

#### Customer Prompt APPROVED BUSINESS FACTS Section
```
Business name: Rosa's Bakery
What we do: a family bakery in Portland, Oregon, famous for sourdough and custom cakes
Services and prices:
- Sourdough loaf, price: $9
- Croissant, price: $4.50
- Custom cakes, price: $65, notes: start at and require 5 days notice
Hours: Tue-Sun 7am-3pm
Location / service area: Portland, Oregon
FAQ:
- Q: Do you have gluten-free?
  A: No, we can't guarantee, wheat is everywhere in the kitchen.
(... payment and walk-in FAQs)
```

**Missing facts:**
- Delivery policy (radius, minimum, fee)
- Nut-free kitchen statement

---

### STAGE 3: Customer Bot Answers

#### Question 1: Delivery (2 miles, $18 order — condition NOT met)
**Owner said:** "deliver only within 3 miles for orders over $40, delivery fee $8"  
**Customer asked:** "Do you deliver to my place 2 miles away? I want 1 sourdough and 2 croissants"

**Expected answer:** "Delivery is available within 3 miles for orders over $40 (delivery fee $8). Your order ($18) doesn't meet the $40 minimum."

**Actual answers:**
- Real Build 1 transcript: "Rosa's Bakery does not offer delivery services." (INVENTED DENIAL)
- Real Build 2 transcript: "I can't confirm delivery options." (correct behavior for missing info)
- Investigation reproduction: "I don't have information about delivery options." (correct)

**Root cause:** Delivery terms never reached customer prompt → model has no facts → inconsistent handling (sometimes invents "does not offer", sometimes says "don't know")

---

#### Question 2: Nut-free / Peanut Allergy
**Owner said:** "We are nut-free in the kitchen"  
**Customer asked:** "Is anything nut free? My son has a peanut allergy, is it safe for him?"

**Expected answer:** "Our kitchen is nut-free — we don't use peanuts or tree nuts. We do use wheat, milk, and eggs. For allergy safety, please confirm with the owner."

**Actual answers:**
- Real Build 1 transcript: Mixed wheat FAQ wording ("wheat is everywhere in the kitchen") into nut answer
- Real Build 2 transcript: "No, we can't guarantee that our kitchen is nut-free" (OPPOSITE of owner statement!)
- Investigation reproduction: "I don't have that information about allergen policies."

**Root cause:** Nut-free statement never reached customer prompt → model has no facts → either defers to owner (correct for missing info) or inverts the fact (hallucination)

---

#### Question 3: Vegan Cakes (Never Mentioned)
**Owner said:** (nothing about vegan)  
**Customer asked:** "Do you have vegan cakes?"

**Expected answer:** "I don't have that information. You may want to message the owner directly."

**Actual answers:**
- Real Build 1 transcript: "We don't have vegan cakes available." (INVENTED DENIAL)
- Real Build 2 transcript: "We don't have vegan cakes available." (INVENTED DENIAL)
- Investigation reproduction: "I do not have that information." (CORRECT)

**Root cause:** Model sometimes invents negations for unstated items. Variability suggests temperature=0 is not fully deterministic or there are subtle prompt differences.

---

## Timing Hypothesis: REJECTED

**Tested:** Does extraction depend on the current interview step?  
**Result:** NO — both builds lost the same facts regardless of timing

- Build 1: Owner gave delivery/nut-free AFTER Builder asked about services (in-phase)
- Build 2: Owner gave delivery/nut-free WHILE Builder was asking about goal (out-of-phase)
- **Both profiles:** IDENTICAL extraction — delivery LOST, nut-free LOST

**Conclusion:** Extraction failure is NOT step-dependent. Builder drops certain fact types regardless of conversation flow.

---

## Schema Observations

### Current Schema Limitations

1. **No structured delivery field**
   - `locationOrArea` is a text field that mixes location with service area
   - Builder consistently uses it for location only ("Portland, Oregon")
   - Conditional delivery (radius + minimum + fee) has no natural home

2. **No allergen/kitchen statement field**
   - Allergen info doesn't fit `whatWeDo`, `services`, or `unknowns`
   - FAQ is for customer questions, not proactive statements
   - "Nut-free kitchen" is a business characteristic, not a Q&A pair

3. **Qualifiers frequently dropped**
   - "around $45 I think" → "$45" (hedge lost)
   - "start at $65" → sometimes "$65" (qualifier lost)
   - "5 days notice" → sometimes lost from notes

### Representation Gap: "Not Provided" vs "Does Not Exist"

Current schema cannot distinguish:
- **Unknown/not provided:** Owner never mentioned vegan cakes → should say "don't have info"
- **Explicitly absent:** Owner said "we don't have gluten-free" → should say "can't guarantee"

Both appear as absence in the profile, leaving the model to guess intent.

---

## Problem Examples Mapped to Stages

| Problem Example | Stage | Proven/Likely | Root Cause |
|---|---|---|---|
| Rosa's delivery denied (2 mi, $18) | Stage 1 | **PROVEN** | Delivery terms never extracted into profile |
| Vegan cakes "we do not have" (never mentioned) | Stage 3 | **PROVEN** | Model invents negation for unstated item (variability) |
| Nut-free mixed with wheat FAQ | Stage 1 | **PROVEN** | Nut-free statement never extracted; only wheat FAQ present |
| "around $20 I think" → firm $20 (Luna) | Stage 1 | **LIKELY** | Hedge dropped during extraction |
| Payment policy invented (Sam's Bike) | Stage 3 | **LIKELY** | Model invents for unstated policy (same as vegan) |
| Service description invented (Dave's Car Wash) | Stage 3 | **LIKELY** | Model invents for unstated service (same pattern) |

---

## Root Cause Summary

### PRIMARY: Builder Extraction (STAGE 1)
**Evidence:**
- Owner explicitly stated delivery terms and nut-free in detailed messages
- Builder acknowledged them in replies ("I'll add those", echoed terms)
- Stored profile: MISSING both facts
- Customer prompt: MISSING both facts
- Result: Customer bot has no information to work with

**Why extraction fails:**
1. **No clear target field** — conditional delivery and allergen statements don't map cleanly to existing schema
2. **Builder prompt may not emphasize these fact types** — services, hours, prices are well-structured; delivery/allergens are edge cases
3. **Model (gpt-4o-mini) limits** — may struggle with complex conditional rules or multi-clause facts

### SECONDARY: Customer Bot Model Behavior (STAGE 3)
**Evidence:**
- Inconsistent handling of missing facts:
  - Sometimes: "I don't have that information" (CORRECT)
  - Sometimes: "We do not offer/have [X]" (INVENTED DENIAL)
- Real transcript showed inverted fact: "can't guarantee nut-free" when owner said "nut-free kitchen"

**Why variability:**
1. **Prompt rules may be insufficient** — current customer prompt says "do not invent" but model still sometimes does
2. **Temperature=0 not fully deterministic** — or subtle context differences
3. **gpt-4o-mini may not reliably follow closed-world contract** under ambiguity

---

## Fix Proposal (Sized to Proven Findings)

### 1. Builder Extraction (HIGH PRIORITY)

**Target:** Capture delivery terms and allergen/kitchen statements

**Option A: Enhance Builder Prompt**
- Add explicit extraction instructions for:
  - Delivery policies (radius, minimum, fee) → store in `locationOrArea` as "Location: [X]. Delivery: [full terms]"
  - OR store in `unknowns` if too complex, OR add to FAQ as Q: "Do you deliver?" A: "[full terms]"
- Allergen/kitchen statements → store in `whatWeDo` or create a dedicated FAQ entry

**Option B: Structured Schema Addition**
```json
{
  "delivery": {
    "available": true,
    "radius": "3 miles",
    "minimumOrder": "$40",
    "fee": "$8",
    "notes": "orders over $40 only"
  },
  "allergenInfo": {
    "nutFree": true,
    "notes": "nut-free kitchen but we use wheat, milk, eggs"
  }
}
```
Requires prompt + code changes to populate and render these fields.

**Option C: Test Stronger Model for Builder**
- Run same Rosa conversation with `gpt-4o` or `gpt-4o-2024-08-06`
- Measure if extraction improves without prompt changes
- Token cost: ~2x for Builder turns only (customer bot stays gpt-4o-mini)

**Recommended:** Start with Option A (prompt enhancement) + targeted test of Option C on a few real examples.

---

### 2. Customer Prompt Strengthening (MEDIUM PRIORITY)

**Target:** Reduce invented negations for unstated items

**Current rule:**
> "Do not invent... Do not imply an unknown option exists or does not exist."

**Enhanced rule:**
> "When a detail is not in APPROVED BUSINESS FACTS:
> - Say 'I don't have that information' or 'You may want to message the owner'
> - NEVER say 'we do not offer', 'we do not have', 'not available', or any other negation
> - An unstated item is unknown, not confirmed absent
> - Exception: when an FAQ explicitly answers the question with 'no' or 'we don't have', use that answer"

**Test:** Reproduce vegan/payment/service-description questions to verify reduction in invented denials.

---

### 3. Verification Plan

#### New Business (End-to-End)
1. Owner provides:
   - Conditional delivery (radius + minimum)
   - Allergen statement (nut-free, lead-free, etc.)
   - Hedged price ("around $X" or "starting at $Y")
   - Unstated items (no vegan, no payment policy mentioned)

2. Verify stored profile:
   - Delivery terms present in some field with conditions intact
   - Allergen statement present
   - Hedge qualifier preserved

3. Verify customer bot answers:
   - Delivery question: cites conditions correctly
   - Allergen question: cites owner statement + suggests owner confirmation
   - Unstated item: says "don't have info", NOT "do not offer"
   - Hedged price: preserves uncertainty ("around", "starting at")

#### Editing Existing Business
1. Owner adds delivery terms to existing business
2. Owner changes conditional policy (e.g., radius 3→5 miles)
3. Verify:
   - Old version not leaked into new answers
   - Conditions updated in stored profile
   - Customer bot uses only new policy

#### Regression Tests (What Works Today)
1. Simple prices and hours → still extracted correctly
2. FAQ Q&A pairs → still stored and used
3. "Refer to owner" behavior → still present for true unknowns
4. No medical diagnosis (physio example) → still blocked

---

## Measured Quality & Cost

### Token Counts (Reproduction Runs)

**Builder turns (per conversation):**
- Rosa Build 1: ~6 turns, total ~8k tokens (prompt + completion)
- Estimated cost: $0.012 at gpt-4o-mini rates

**Customer bot answers (per question, temp=0):**
- Avg prompt: ~1800 tokens (full system message)
- Avg completion: ~80 tokens
- 3 runs per question: ~5.6k tokens total
- Estimated cost: $0.008 per 3-run question

**Model upgrade cost (Builder only gpt-4o):**
- Builder turns: 8k tokens → ~$0.08 (input $5/1M, output $15/1M)
- **Cost increase: ~7x for Builder turns**
- Customer bot stays gpt-4o-mini: no change

**Recommendation:** Prompt fix first; model upgrade only if extraction doesn't improve.

---

## Remaining Unknowns

1. **Production Flowise/Supabase state**
   - Investigation used local reproduction; real builds went through Render/Flowise
   - Unlikely to affect extraction (that's pre-sync), but worth noting

2. **Builder prompt version in production**
   - Investigation used current `src/builder.js` prompt
   - Real transcripts from 2026-10-25 may have used a different version
   - Real transcripts showed different qualifier handling ("$65" vs "$65 + notes")

3. **Other hedge/condition patterns**
   - Tested: "around X I think", "start at", "within X miles for orders over Y"
   - Untested: "about", "roughly", "up to", "from X to Y", "minimum X, maximum Y"

4. **Frequency of vegan/payment inventions**
   - Investigation reproduction mostly said "don't have info" (correct)
   - Real transcripts said "do not have" (invented denial)
   - Suggests variability — may depend on subtle prompt state or model non-determinism

---

## Appendix: Captured Artifacts

All artifacts saved to `investigation-output/`:

### Profiles
- `build1-profile.json` — Rosa Build 1 (services phase)
- `build2-profile.json` — Rosa Build 2 (goal phase)
- `luna-profile.json` — Luna's Pottery Studio (synthetic test)

### Customer Prompts
- `rosa-final-prompt.txt` — Full system message sent to customer bot
- `luna-customer-prompt.txt`

### Reports
- `COMPARATIVE-REPORT.json` — Full turn-by-turn comparison
- `FINAL-REPORT.json` — Single-build analysis with token counts
- `full-report.json` — Original three-business investigation

---

## Conclusion

The fidelity problem is **primarily a Builder extraction issue (STAGE 1)**. Facts that owners explicitly provide — delivery terms, allergen statements, hedged prices — are acknowledged by the Builder but not stored in the profile. Without these facts in storage, the customer prompt cannot include them, leaving the customer bot to guess (sometimes incorrectly).

**No extra spend is approved**, but the investigation provides measured token counts for any model upgrade tests. The recommended fix is **Builder prompt enhancement** to explicitly capture delivery policies and allergen/kitchen statements into existing or FAQ fields, preserving conditions and caveats verbatim.

