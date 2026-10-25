# Investigation Summary: Business Fact Fidelity

**Status:** INVESTIGATION COMPLETE (no code changes per scope)

---

## Root Cause: PROVEN

**Builder LLM (gpt-4o-mini) extraction failure at STAGE 1**

Owner explicitly provides facts → Builder acknowledges them → Builder does NOT store them → Customer bot has no information

---

## Facts Lost During Extraction

### 1. Conditional Delivery Policies ❌
**Owner said (Rosa's Bakery, BOTH builds):**
```
"We deliver only within 3 miles for orders over $40, delivery fee $8"
```

**Stored in profile:**
```json
{
  "locationOrArea": "Portland, Oregon"
}
```
**Result:** Location only, NO delivery terms (no radius, no $40 minimum, no $8 fee)

---

### 2. Allergen/Kitchen Statements ❌
**Owner said:**
```
"We are nut-free in the kitchen but we do use wheat, milk and eggs"
```

**Stored in profile:**
- NOT in `whatWeDo`
- NOT in `services`
- NOT in `commonQuestions`
- NOT anywhere

**Verification:** `grep -i "nut" build1-profile.json` → NO MATCHES

---

### 3. What DID Get Extracted ✓
- Services with prices: ✓
- Hours: ✓
- Location (without delivery): ✓
- FAQ Q&A pairs: ✓
- Intake fields: ✓

---

## Problem Examples → Stages

| Problem | Stage | Evidence |
|---------|-------|----------|
| Rosa's "does not offer delivery" | **Stage 1** | Delivery terms never stored → prompt has no info → bot guesses |
| Nut allergy mixed with wheat FAQ | **Stage 1** | Nut-free never stored → only wheat FAQ present |
| Nut allergy answer INVERTED | **Stage 1 + 3** | No nut-free fact → model hallucinates opposite |
| Vegan cakes "do not have" (never mentioned) | **Stage 3** | gpt-4o-mini sometimes invents negations (inconsistent) |
| "around $45 I think" → "$45" | **Stage 1** | Hedge qualifiers dropped |

---

## Timing Hypothesis: REJECTED

**Tested:** Same facts provided during different interview phases
- Build 1: Services phase (in-step)
- Build 2: Goal phase (out-of-step)

**Result:** IDENTICAL extraction in both builds → failure is NOT step-dependent

---

## Schema Observations

Current schema has **no natural home** for:
1. Conditional delivery (radius + minimum + fee)
   - `locationOrArea` used for location only
   - Too complex for simple text field
   
2. Allergen/kitchen statements
   - Not a service, not FAQ Q&A, not `whatWeDo`
   
3. Distinction between "not mentioned" vs "explicitly doesn't have"
   - Both appear as absence → model must guess

---

## Fix Proposal

### Priority 1: Builder Extraction Prompt
**Add explicit instructions to capture:**

1. **Delivery policies** → store in:
   - `locationOrArea` as "Location: [X]. Delivery: [full terms]", OR
   - Add FAQ entry: Q: "Do you deliver?" A: "[full terms]", OR
   - Store structured `delivery` object (requires schema change)

2. **Allergen/kitchen statements** → store in:
   - `whatWeDo` field, OR
   - Create FAQ entry with owner's exact words

3. **Preserve qualifiers:**
   - "around X", "approximately", "I think"
   - "start at", "from X to Y"
   - "only within X", "for orders over Y"

### Priority 2: Customer Prompt Strengthening
**Enhanced "never invent" rule:**
> When a detail is not in APPROVED BUSINESS FACTS:
> - Say "I don't have that information"
> - NEVER say "we do not offer/have" or any negation
> - Exception: when FAQ explicitly says "no", use that answer

### Priority 3: Test Model Upgrade (Builder Only)
- Try gpt-4o for Builder extraction on same test cases
- Measure if extraction improves
- Cost: ~7x for Builder turns only (customer bot stays gpt-4o-mini)
- **No spend approved yet** — measure first, then decide

---

## Verification Plan

### New Business Test
Owner provides:
- ✓ Conditional delivery (radius + minimum)
- ✓ Allergen statement
- ✓ Hedged price
- ✓ Unstated items

Verify:
1. Delivery terms in profile with conditions intact
2. Allergen statement present
3. Customer bot cites delivery conditions correctly
4. Unstated item → "don't have info" (not "do not have")

### Regression: What Works Today
- Simple prices/hours → still extracted ✓
- FAQ Q&A → still stored ✓
- External actions blocked ✓

---

## Measured Costs

**Current (gpt-4o-mini for Builder + Customer Bot):**
- Builder conversation: ~$0.012 per build
- Customer answer (3 runs): ~$0.008

**If upgraded to gpt-4o for Builder only:**
- Builder conversation: ~$0.08 per build (7x increase)
- Customer answers: unchanged

**Model upgrade:** NOT recommended until prompt enhancement is tested

---

## Artifacts Generated

Location: `/workspace/investigation-output/`

**Reports:**
- `INVESTIGATION-REPORT.md` — Full detailed findings (this file)
- `COMPARATIVE-REPORT.json` — Turn-by-turn comparison data

**Profiles (Stored JSON):**
- `build1-profile.json` — Rosa Build 1
- `build2-profile.json` — Rosa Build 2 (identical extraction)
- `luna-profile.json` — Luna's Pottery Studio test

**Customer Prompts:**
- `rosa-final-prompt.txt` — Full system message
- Delivery: ❌ NOT present
- Nut-free: ❌ NOT present

**Ground Truth:**
- Real WhatsApp transcripts (2 Rosa builds) provided by user
- Reproduced exactly with same owner messages

---

## Key Evidence Summary

```bash
# Delivery terms check
$ jq '.draft.locationOrArea' build1-profile.json
"Portland, Oregon"  # ← Only location, no delivery

# Nut-free check  
$ grep -i "nut" build1-profile.json
# (no matches)  # ← Never stored

# Services check
$ jq '.draft.services | length' build1-profile.json
3  # ← Services ARE extracted

# FAQ check
$ jq '.draft.commonQuestions | length' build1-profile.json  
3  # ← FAQ IS extracted
```

**Conclusion:** Extraction works for standard fields (services, FAQ, hours) but fails for edge-case facts (delivery policies, allergen statements)

---

## Next Steps (Outside Investigation Scope)

1. **Implement Builder prompt enhancement** (Priority 1 fix)
2. **Add extraction tests** for delivery + allergen patterns
3. **Run verification plan** on new test business
4. **Measure before/after** extraction success rate
5. **Consider model upgrade** only if prompt enhancement insufficient

---

**Investigation complete. No changes pushed to main. All findings captured in artifacts.**
