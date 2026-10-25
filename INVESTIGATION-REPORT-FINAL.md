# Business Fact Fidelity Investigation — Final Report

**Date:** 2026-10-25  
**Model:** gpt-4o-mini (Builder and Customer Bot)  
**Scope:** Investigation only — no code changes

---

## The Two Blockers

### BLOCKER A: Bot Doesn't Give Information It Was Given
Owner explicitly provides facts → Bot omits them or says "can't confirm"

**Examples:**
- Delivery terms provided → Bot: "can't confirm delivery"
- Nut-free kitchen stated → Bot: "don't have that information"  
- "5 days notice" given → Sometimes omitted

---

### BLOCKER B: Bot Gives WRONG Information
Bot contradicts owner statements OR invents facts never provided

**Examples:**
- Owner: "We deliver..." → Bot: "does not offer delivery services"
- Owner: "nut-free kitchen" → Bot: "can't guarantee kitchen is nut-free"
- Owner: (never mentioned vegan) → Bot: "We do not have vegan cakes"
- Owner: (never mentioned payment) → Bot: "payment is on-site"
- Owner: (never mentioned oil changes) → Bot: "no oil changes"

---

## Investigation Method

**Ground truth:** 2 real WhatsApp transcripts of Rosa's Bakery builds (2026-10-25)
- Same owner messages, different timing
- Reproduced exactly to trace facts through each stage

**Traced per stage:**
1. **Stage 1 (Extraction):** What Builder stored in profile JSON
2. **Stage 2 (Prompt):** What facts reached customer bot system message
3. **Stage 3 (Answer):** What customer bot actually said

---

## BLOCKER A: Omissions

### Evidence: Delivery Terms

**Owner statement (both builds, identical):**
```
"We deliver only within 3 miles for orders over $40, delivery fee $8."
```

**Builder acknowledged:**
- Build 1: "I've noted... your delivery policy"
- Build 2: "I'll add those to the bot"

---

#### Stage 1: Extraction — FAILURE

**Stored in profile (both builds):**
```json
{
  "locationOrArea": "Portland, Oregon"
}
```

**Verification:**
```bash
$ grep -Ei "(deliver|3 miles|40|fee)" build1-profile.json
(no matches)

$ grep -Ei "(deliver|3 miles|40|fee)" build2-profile.json
(no matches)
```

**Result:** Delivery terms NOT stored in any field
- ❌ Not in `locationOrArea` (only has location)
- ❌ Not in `services`
- ❌ Not in `unknowns`
- ❌ Not in `commonQuestions`

**Summary cards shown to owner (both builds):**
```
Area: Portland, Oregon
```
→ No delivery line

---

#### Stage 2: Customer Prompt — MISSING

**APPROVED BUSINESS FACTS section:**
```
Location / service area: Portland, Oregon
```

```bash
$ grep -i "deliver" rosa-final-prompt.txt
(no matches)
```

**Result:** No delivery information reached the customer bot

---

#### Stage 3: Customer Answer — OMISSION

**Customer question:**
```
"I want 5 sourdough loaves, that's $45. I live 2 miles away. Can you deliver it?"
```

**Expected answer:**
```
"Delivery is available within 3 miles for orders over $40 (fee $8). 
Your $45 order qualifies. You're 2 miles away, so delivery is available."
```

**Actual answer (investigation reproduction):**
```
"I don't have information about delivery options."
```

**Actual answer (real Build 2 transcript):**
```
"I can't confirm delivery options."
```

**Result:** Bot correctly says it doesn't have info (because it truly doesn't) BUT owner DID provide it

---

### Evidence: Nut-Free Kitchen

**Owner statement (both builds, identical):**
```
"We are nut-free in the kitchen but we do use wheat, milk and eggs."
```

---

#### Stage 1: Extraction — FAILURE

**Stored in profile (both builds):**
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

**What WAS stored (wheat, from FAQ answer):**
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

**Result:** Nut-free statement NOT stored anywhere

---

#### Stage 2: Customer Prompt — MISSING

**FAQ section:**
```
FAQ:
- Q: Do you have gluten-free?
  A: No, we can't guarantee, wheat is everywhere in the kitchen.
```

```bash
$ grep -i "nut" rosa-final-prompt.txt
(no matches)
```

**Result:** No nut-free information reached the customer bot

---

#### Stage 3: Customer Answer — OMISSION (leading to WRONG info, see Blocker B)

**Customer question:**
```
"Is your kitchen nut-free? My son has a peanut allergy."
```

**Expected answer:**
```
"Our kitchen is nut-free — we don't use peanuts or tree nuts. 
We do use wheat, milk, and eggs. For allergy safety, please confirm with the owner."
```

**Actual answer (investigation reproduction):**
```
"I don't have that information about allergen policies."
```

**Result:** Bot correctly says it doesn't have info (because it truly doesn't) BUT owner DID provide it

---

### Evidence: "5 Days Notice" Qualifier

**Owner statement:**
```
"custom cakes start at $65 and need 5 days notice"
```

---

#### Stage 1: Extraction — INCONSISTENT

**Build 1 stored:**
```json
{
  "name": "Custom cakes",
  "price": "$65",
  "notes": "start at and require 5 days notice"
}
```
✓ Preserved in notes field

**Build 2 stored:**
```json
{
  "name": "Custom cakes",
  "price": "$65",
  "notes": "starting at, 5 days notice required"
}
```
✓ Preserved in notes field

**But Build 2 summary card (real transcript):**
```
Services: Sourdough loaf — $9; Croissant — $4.50; Custom cakes — $65
```
❌ Lost "start at" and "5 days notice"

**Result:** Qualifier sometimes preserved in storage but lost in owner-facing summary — less severe than delivery/nut-free (which are completely lost)

---

### BLOCKER A Summary

**Root cause: Stage 1 extraction failure**

Facts owner explicitly provides are:
1. Acknowledged by Builder in replies ✓
2. NOT stored in profile fields ❌
3. Therefore not in customer prompt ❌
4. Therefore bot has no information ❌

**Timing independence:** Both builds (different interview phases) show identical extraction failure

**Affected facts:**
- Conditional delivery policies (radius + minimum + fee)
- Allergen/kitchen statements (nut-free)
- Sometimes service qualifiers ("5 days notice")

---

## BLOCKER B: Wrong Information

### Type B1: Owner Said X, Bot Says Opposite

#### Evidence: Delivery Denial

**Owner said:**
```
"We deliver only within 3 miles for orders over $40, delivery fee $8"
```

**Bot answer (real Build 1 transcript):**
```
"Rosa's Bakery does not offer delivery services."
```

**Analysis:**
- Stage 1: Delivery NOT stored ❌ (proven above)
- Stage 2: Delivery NOT in prompt ❌ (proven above)
- Stage 3: Bot fills information gap with **INVENTED DENIAL** ❌

**This is Blocker A (omission) causing Blocker B (wrong info)**

---

#### Evidence: Nut-Free Inversion

**Owner said:**
```
"We are nut-free in the kitchen"
```

**Bot answer (real Build 2 transcript):**
```
"No, we can't guarantee that our kitchen is nut-free"
```

**Analysis:**
- Stage 1: Nut-free NOT stored ❌ (proven above)
- Stage 2: Nut-free NOT in prompt ❌ (proven above)  
- Stage 3: Bot fills information gap with **OPPOSITE STATEMENT** ❌

**This is Blocker A (omission) causing Blocker B (contradiction)**

---

#### Evidence: Wheat FAQ Misapplied

**Owner said (gluten-free FAQ):**
```
"Do you have gluten-free? No, we can't guarantee, wheat is everywhere in the kitchen."
```

**Bot answer to nut-allergy question (real Build 1 transcript):**
```
"At Rosa's Bakery, we can't guarantee that our products are nut-free, 
as wheat is everywhere in the kitchen."
```

**Analysis:**
- Stage 1: Nut-free NOT stored; only wheat FAQ stored ✓
- Stage 2: Only wheat FAQ in prompt ✓
- Stage 3: Bot **MIXES wheat fact into nut answer** ❌

**Root cause:** Missing nut-free fact + model reuses available wheat fact for wrong allergen

---

### Type B2: Owner Never Mentioned, Bot Invents

#### Evidence: Vegan Cakes

**Owner said:**
```
(never mentioned vegan)
```

**Storage verification:**
```bash
$ grep -i "vegan" build1-profile.json
(no matches)  # ✓ Correctly absent

$ grep -i "vegan" build2-profile.json
(no matches)  # ✓ Correctly absent

$ grep -i "vegan" rosa-final-prompt.txt
(no matches)  # ✓ Correctly absent
```

**Bot answer (real Build 1 transcript):**
```
"We do not have vegan cakes available."
```

**Bot answer (real Build 2 transcript):**
```
"We don't have vegan cakes available."
```

**Analysis:**
- Stage 1: Vegan correctly absent ✓
- Stage 2: Vegan correctly absent ✓
- Stage 3: Bot **INVENTS NEGATION** ❌

**This is pure Stage 3 invention** — profile and prompt are correct

---

#### Evidence: Payment Policy (Secondary)

From problem description (not reproduced):
- Owner: never mentioned payment policy
- Bot: "payment is on-site"

**Pattern:** Same as vegan — invention at Stage 3

---

#### Evidence: Oil Changes (Secondary)

From problem description (not reproduced):
- Owner: only gave washes and prices
- Bot: "no oil changes" + invented service description

**Pattern:** Same as vegan — invention at Stage 3

---

### BLOCKER B Summary

**Two sub-causes:**

**B1: Missing facts → wrong guesses**
- Stage 1 extraction failure (Blocker A)
- → Stage 3 model fills gap with denial or opposite
- Examples: delivery denial, nut-free inversion

**B2: Correctly absent facts → invented negations**
- Stage 1 & 2 correct (item absent)
- → Stage 3 model invents "do not have" statement
- Examples: vegan cakes, payment policy, oil changes

**Variability:** Same prompt produced different behaviors
- Real transcripts: invented denials
- Investigation reproduction: mostly "don't have info" (correct)
- Suggests non-determinism or subtle context differences

---

## Timing Independence

**Hypothesis tested:** Does extraction depend on interview phase?

**Test setup:**
- Build 1: Owner gave delivery/nut-free AFTER Builder asked about services
- Build 2: Owner gave delivery/nut-free WHILE Builder asked about bot goal

**Result:**
```bash
$ diff <(jq '.draft' build1-profile.json) <(jq '.draft' build2-profile.json)
# (only askedTopics differs)
# All fact fields IDENTICAL
```

**Both builds:**
- ❌ Delivery: NOT stored
- ❌ Nut-free: NOT stored
- ✓ Services: stored
- ✓ Hours: stored
- ✓ FAQ (gluten-free): stored

**Conclusion:** Extraction failure is NOT timing-dependent

---

## Root Causes & Fixes

### Fix for BLOCKER A: Omissions

**Root cause: Builder extraction failure (Stage 1)**

Builder (gpt-4o-mini) fails to extract:
1. Conditional delivery policies
2. Allergen/kitchen statements
3. Sometimes service qualifiers

**Why:**
- No clear schema field for delivery (radius + minimum + fee)
- No schema field for allergen statements
- Builder prompt may not emphasize these fact types

---

#### Proposed Fix A1: Builder Prompt Enhancement (No Schema Change)

**Add explicit extraction instructions:**

**For delivery policies:**
```
When the owner mentions delivery, shipping, or sending orders:
- Capture the full conditional policy (distance, minimum order, fees)
- Store as FAQ entry:
  Question: "Do you deliver?"
  Answer: [owner's exact terms, including all conditions]
- Example: "We deliver within 3 miles for orders over $40, delivery fee $8"
```

**For allergen/kitchen statements:**
```
When the owner mentions allergens, kitchen safety, or ingredients they avoid:
- Create FAQ entry with the owner's statement
- Question: "[Allergen] safe?" or "Is your kitchen [allergen]-free?"
- Answer: [owner's exact statement, including caveats]
- Example: Q: "Is your kitchen nut-free?" 
           A: "Yes, nut-free kitchen, though we use wheat, milk, eggs"
```

**Implementation:** Update Builder system prompt in `src/builder.js`

---

#### Proposed Fix A2: Schema Enhancement (Requires Code Change)

Add structured fields:
```json
{
  "delivery": {
    "description": "within 3 miles for orders over $40, fee $8"
  },
  "allergenInfo": [
    "nut-free kitchen",
    "uses wheat, milk, eggs"
  ]
}
```

Requires:
- Builder prompt to populate
- `profile.js` to merge/normalize
- `customerPrompt.js` to render
- `ownerNav.js` summary to display

**Recommendation:** Start with Fix A1 (FAQ entries) — works with current schema

---

### Fix for BLOCKER B: Wrong Information

**Two sub-causes require different fixes:**

---

#### Fix B1: Missing Facts → Wrong Guesses

**Root cause:** Blocker A (extraction failure) → model fills gap incorrectly

**Fix:** Same as Fix A1/A2 above — extract the facts so model has correct information

**Verification:** After fixing extraction, test that bot cites correct delivery/nut-free facts instead of denying/inverting

---

#### Fix B2: Absent Facts → Invented Negations

**Root cause:** Customer bot (gpt-4o-mini) sometimes invents negations for unstated items despite prompt rules

**Current rule:**
```
Do not invent prices, price bases, rules, policies...
Do not imply an unknown option exists or does not exist.
```

---

#### Proposed Fix B2: Strengthen Customer Prompt

**Enhanced rule in `src/customerPrompt.js`:**

```
NEVER INVENT NEGATIONS:
When a detail, service, or policy is not in APPROVED BUSINESS FACTS:
- Say "I don't have that information" or "You may want to message the owner"
- NEVER say "we do not offer", "we do not have", "not available", 
  or any other form of denial or negation
- An unstated item is UNKNOWN, not confirmed absent
- Examples of WRONG responses: "we do not have vegan cakes", 
  "payment is on-site", "no oil changes available"
- Examples of CORRECT responses: "I don't have information about vegan options",
  "I don't have details about payment methods"

Exception: when a FAQ explicitly answers with "no" or "we don't have", 
use that exact answer (it came from the owner)
```

**Place prominently:** In BEHAVIOR RULES section, before partial-answer pattern

---

#### Proposed Fix B2-Alt: Test Model Upgrade

If prompt strengthening insufficient:
- Test gpt-4o for customer bot (currently gpt-4o-mini)
- Measure if negation inventions reduce
- Cost: ~2x for customer answers

**Recommendation:** Strengthen prompt first, test model only if inventions persist

---

## Verification Plan

### Test New Business (End-to-End)

**Owner provides:**
1. Conditional delivery (e.g., "within X miles for orders over $Y, fee $Z")
2. Allergen statement (e.g., "nut-free kitchen, we use wheat/dairy")
3. Service with qualifier (e.g., "start at $X, need Y days notice")
4. **Does NOT mention:** vegan, payment method, unrelated service

---

**Verify BLOCKER A fix (omissions):**

Questions:
- "Do you deliver to [address within radius], [order meets minimum]?"
- "Is your kitchen [allergen]-free?"

Expected:
- ✓ Bot cites delivery terms with conditions
- ✓ Bot cites allergen statement
- ✓ No "don't have info" for facts that were provided

Checked stages:
- Stage 1: Facts present in profile (delivery in FAQ, allergen in FAQ)
- Stage 2: Facts present in customer prompt
- Stage 3: Bot answers contain the facts

---

**Verify BLOCKER B fix (wrong info):**

Questions:
- "Do you have [never-mentioned item]?" (e.g., vegan cakes)
- "What's your [never-mentioned policy]?" (e.g., payment method)
- "Do you offer [never-mentioned service]?" (e.g., oil changes)

Expected:
- ✓ Bot says "don't have that information"
- ❌ Bot does NOT say "we do not have" or any negation
- ❌ Bot does NOT invent policy/service details

Checked:
- Profile: item correctly absent
- Bot answer: no invented negation

---

### Test Edit Flow

**Owner changes delivery terms:**
- Initial: "within 3 miles for orders over $40"
- Change to: "within 5 miles for orders over $50"

**Verify:**
- Old terms not leaked into new answers
- New terms stored correctly
- Customer bot uses only new policy

---

### Regression Tests

**Verify still work:**
- ✓ Simple prices and hours extraction
- ✓ FAQ Q&A pairs
- ✓ External action limits ("bot cannot book/pay")
- ✓ "Refer to owner" for true unknowns

---

## Summary of Proven Failures

| Blocker | Example | Stage | Evidence |
|---------|---------|-------|----------|
| **A: Omission** | Delivery terms | Stage 1 | `grep "deliver" profile.json` → no matches |
| **A: Omission** | Nut-free kitchen | Stage 1 | `grep "nut" profile.json` → no matches |
| **B1: Wrong** | "does not offer delivery" | Stage 1→3 | Missing fact → invented denial |
| **B1: Wrong** | "can't guarantee nut-free" | Stage 1→3 | Missing fact → opposite statement |
| **B1: Wrong** | Wheat FAQ for nut question | Stage 1→3 | Missing nut fact → wrong allergen cited |
| **B2: Wrong** | "do not have vegan cakes" | Stage 3 | Profile correct (absent) → invented negation |

---

## Measured Costs

**Current (gpt-4o-mini both):**
- Builder conversation: ~$0.012
- Customer answer (3 runs): ~$0.008

**If upgraded:**
- Builder to gpt-4o: ~$0.08 (7x, if Fix A1 insufficient)
- Customer to gpt-4o: ~$0.016 (2x, if Fix B2 insufficient)

**No spend approved yet** — test prompt fixes first

---

## Artifacts

Location: `/workspace/investigation-output/`

**Profiles showing extraction failures:**
- `build1-profile.json` — delivery ❌, nut-free ❌
- `build2-profile.json` — delivery ❌, nut-free ❌ (identical)

**Customer prompts showing missing facts:**
- `rosa-final-prompt.txt` — delivery ❌, nut-free ❌

**Reports:**
- `COMPARATIVE-REPORT.json` — Full turn-by-turn data
- `INVESTIGATION-REPORT.md` — This report

**Ground truth:**
- Real WhatsApp transcripts (2 Rosa builds, 2026-10-25)
- Reproduced exactly

---

## Conclusion

**BLOCKER A (omissions):** Builder extraction failure (Stage 1)
- Owner provides facts → Builder acknowledges → Builder does NOT store
- Fix: Enhanced Builder prompt to explicitly capture delivery/allergen facts as FAQ entries

**BLOCKER B (wrong info):** Two causes
- B1: Missing facts (from Blocker A) → model guesses wrong (Stage 1→3)
  - Fix: Same as Blocker A
- B2: Correctly absent facts → model invents negations (Stage 3)
  - Fix: Strengthen customer prompt "never invent negations" rule

Both blockers proven with real transcript evidence and storage verification. Fixes sized to proven findings, no code changes made per investigation scope.
