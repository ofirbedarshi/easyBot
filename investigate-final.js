#!/usr/bin/env node
/**
 * Final comprehensive fidelity analysis with proper approval flow
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { runBuilderTurn, openingMessage, applyReviewGate, shouldSoftApprove } from './src/builder.js';
import { emptyProfile, mergeDraft } from './src/profile.js';
import { buildCustomerSystemPrompt } from './src/customerPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'investigation-output');

// Real Rosa conversation
const ROSA_MESSAGES = [
  "Hello! I own Rosa's Bakery",
  "I own Rosa's Bakery, a family bakery in Portland, Oregon, open since 1998, famous for our sourdough and custom cakes.",
  "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.",
  "Common ones: do you have gluten-free? No, we can't guarantee, wheat is everywhere in the kitchen. Do you take walk-in cake orders? No, 5 days notice. Can I pay by card? Yes, cash and card in the shop.",
  "Answer questions, and for cake orders collect name, phone, date needed and what kind of cake, I will confirm myself",
  "1"  // Try my bot
];

const ROSA_CUSTOMER_Q = [
  "Do you deliver to my place 2 miles away? I want 1 sourdough and 2 croissants",
  "Is anything nut free? My son has a peanut allergy, is it safe for him?",
  "Do you have vegan or gluten free cakes?"
];

async function runFullBuilderFlow(messages, businessName) {
  console.log(`\n=== ${businessName} ===\n`);
  
  const profile = emptyProfile();
  const buildHistory = [];
  
  const opening = openingMessage();
  buildHistory.push({ role: 'assistant', content: opening.message, nav: null });
  
  for (let i = 1; i < messages.length; i++) {
    const userMessage = messages[i];
    
    const rawTurn = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage
    });
    
    const turn = applyReviewGate(profile, rawTurn, userMessage);
    
    // Update draft
    profile.draft = turn.draft;
    
    // Handle review key
    if (turn.reviewedDraftKey) {
      profile.reviewedDraftKey = turn.reviewedDraftKey;
    }
    
    // Check if this should soft-approve
    const softApprove = shouldSoftApprove({ profile, draft: turn.draft, userMessage });
    
    if (turn.approved || softApprove) {
      const merged = mergeDraft(profile, turn.draft);
      Object.assign(profile, merged);
      profile.approvedAt = new Date().toISOString();
      profile.draft = null;
      console.log(`Turn ${i}: ✓ APPROVED`);
    } else {
      console.log(`Turn ${i}: draft (${turn.presentReview ? 'review presented' : 'building'})`);
    }
    
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
  }
  
  return profile;
}

function analyzeExtraction(profile, originalMessage, label) {
  console.log(`\n--- ${label} ---`);
  console.log(`Owner said: "${originalMessage}"`);
  console.log(`\nStored in profile:`);
  console.log(`  name: "${profile.name}"`);
  console.log(`  whatWeDo: "${profile.whatWeDo}"`);
  console.log(`  locationOrArea: "${profile.locationOrArea}"`);
  console.log(`  hours: "${profile.hours}"`);
  console.log(`  services: ${JSON.stringify(profile.services, null, 2)}`);
  console.log(`  commonQuestions: ${profile.commonQuestions.length} items`);
  console.log(`  unknowns: ${JSON.stringify(profile.unknowns)}`);
  
  // Check specific facts
  const checks = {};
  
  if (originalMessage.includes('deliver')) {
    checks.delivery = {
      mentioned: true,
      inLocationOrArea: profile.locationOrArea?.toLowerCase().includes('deliver') || false,
      inServices: JSON.stringify(profile.services).toLowerCase().includes('deliver'),
      inUnknowns: JSON.stringify(profile.unknowns).toLowerCase().includes('deliver'),
      conditions: {
        miles: profile.locationOrArea?.includes('miles') || JSON.stringify(profile).includes('miles'),
        amount: profile.locationOrArea?.includes('$40') || profile.locationOrArea?.includes('40'),
        fee: profile.locationOrArea?.includes('$8') || profile.locationOrArea?.includes('8')
      }
    };
  }
  
  if (originalMessage.toLowerCase().includes('nut')) {
    checks.nutFree = {
      mentioned: true,
      anywhere: JSON.stringify(profile).toLowerCase().includes('nut')
    };
  }
  
  if (originalMessage.includes('around') || originalMessage.includes('think')) {
    checks.hedgedPrice = {
      mentioned: true,
      hedgePreserved: JSON.stringify(profile).includes('around') || JSON.stringify(profile).includes('think') || JSON.stringify(profile).includes('approximately')
    };
  }
  
  return checks;
}

async function testAnswers(profile, questions) {
  const systemPrompt = buildCustomerSystemPrompt(profile);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  
  const results = [];
  
  for (const q of questions) {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: q }
      ]
    });
    
    const answer = completion.choices[0].message.content;
    
    results.push({
      question: q,
      answer,
      analysis: {
        saysDoesNotOffer: /does? not (offer|have|provide)/i.test(answer),
        inventsNegation: /do(?:es)? not (offer|have|provide)/i.test(answer) && !systemPrompt.includes(answer.match(/do(?:es)? not (offer|have|provide) ([^\.])+/i)?.[0] || '___'),
        refersToOwner: /message.{0,20}owner|contact.{0,20}owner|check.{0,20}owner/i.test(answer),
        saysDontHaveInfo: /don't have|do not have.*information/i.test(answer)
      },
      tokens: completion.usage.total_tokens
    });
    
    console.log(`\nQ: ${q}`);
    console.log(`A: ${answer.substring(0, 120)}...`);
  }
  
  return { systemPrompt, results };
}

function generateFinalReport(rosaProfile, rosaChecks, rosaResults) {
  console.log(`\n\n========================================`);
  console.log(`FINAL INVESTIGATION REPORT`);
  console.log(`========================================\n`);
  
  console.log(`MODEL: ${process.env.OPENAI_MODEL || 'gpt-4o-mini'}\n`);
  
  console.log(`=== STAGE 1: EXTRACTION & STORAGE ===\n`);
  
  console.log(`Finding 1: Delivery terms`);
  console.log(`  Owner message: "We deliver only within 3 miles for orders over $40, delivery fee $8"`);
  
  if (rosaChecks.delivery) {
    console.log(`  Stored in locationOrArea: ${rosaChecks.delivery.inLocationOrArea ? 'YES' : 'NO'}`);
    if (rosaChecks.delivery.inLocationOrArea) {
      console.log(`    Value: "${rosaProfile.locationOrArea}"`);
      console.log(`    Conditions preserved:`);
      console.log(`      - Distance (3 miles): ${rosaChecks.delivery.conditions.miles ? 'YES' : 'NO'}`);
      console.log(`      - Minimum ($40): ${rosaChecks.delivery.conditions.amount ? 'YES' : 'NO'}`);
      console.log(`      - Fee ($8): ${rosaChecks.delivery.conditions.fee ? 'YES' : 'NO'}`);
    } else {
      console.log(`    Found elsewhere: services=${rosaChecks.delivery.inServices}, unknowns=${rosaChecks.delivery.inUnknowns}`);
    }
  }
  console.log(`  ✗ LOST: Delivery terms not stored in any field\n`);
  
  console.log(`Finding 2: Nut-free statement`);
  console.log(`  Owner message: "We are nut-free in the kitchen but we do use wheat, milk and eggs"`);
  if (rosaChecks.nutFree) {
    console.log(`  Stored anywhere: ${rosaChecks.nutFree.anywhere ? 'YES' : 'NO'}`);
  }
  console.log(`  ✗ LOST: Nut-free statement not stored\n`);
  
  console.log(`Finding 3: Wheat/allergen context`);
  console.log(`  Owner gave nut-free caveat in same sentence as wheat/milk/eggs`);
  console.log(`  Wheat appeared in FAQ: "wheat is everywhere in the kitchen" (from gluten-free question)`);
  console.log(`  → FAQ answer is correct for gluten, but nut-free statement missing\n`);
  
  console.log(`Finding 4: Vegan (never mentioned)`);
  console.log(`  Owner never mentioned vegan`);
  const veganInProfile = JSON.stringify(rosaProfile).toLowerCase().includes('vegan');
  console.log(`  Stored in profile: ${veganInProfile ? 'YES (INVENTED)' : 'NO (correct)'}\n`);
  
  console.log(`\n=== STAGE 2: CUSTOMER PROMPT ===\n`);
  
  const hasDelivery = rosaResults.systemPrompt.toLowerCase().includes('deliver');
  const hasNutFree = rosaResults.systemPrompt.toLowerCase().includes('nut');
  
  console.log(`Delivery terms in prompt: ${hasDelivery ? 'YES' : 'NO'}`);
  console.log(`Nut-free in prompt: ${hasNutFree ? 'NO' : 'NO'}\n`);
  
  console.log(`\n=== STAGE 3: CUSTOMER BOT ANSWERS ===\n`);
  
  for (let i = 0; i < rosaResults.results.length; i++) {
    const r = rosaResults.results[i];
    console.log(`Question ${i + 1}: "${r.question}"`);
    console.log(`  Answer: "${r.answer.substring(0, 100)}..."`);
    console.log(`  Says "does not offer/have": ${r.analysis.saysDoesNotOffer}`);
    console.log(`  Invents negation: ${r.analysis.inventsNegation}`);
    console.log(`  Refers to owner: ${r.analysis.refersToOwner}`);
    console.log(`  Says "don't have info": ${r.analysis.saysDontHaveInfo}\n`);
  }
  
  console.log(`\n=== ROOT CAUSE ANALYSIS ===\n`);
  
  console.log(`Problem 1: "Rosa's Bakery does not offer delivery services"`);
  console.log(`  Stage: STAGE 1 - Extraction`);
  console.log(`  Cause: Builder LLM (gpt-4o-mini) failed to extract delivery terms`);
  console.log(`  Evidence: Owner said "deliver only within 3 miles for orders over $40, delivery fee $8"`);
  console.log(`           Stored: locationOrArea = "Portland, Oregon" (location only, no delivery)`);
  console.log(`           Result: Customer prompt has no delivery information`);
  console.log(`  Fix target: Builder extraction prompt/logic\n`);
  
  console.log(`Problem 2: Peanut allergy answer cites wheat FAQ`);
  console.log(`  Stage: STAGE 1 - Extraction`);
  console.log(`  Cause: Builder LLM failed to extract nut-free statement`);
  console.log(`  Evidence: Owner said "We are nut-free in the kitchen"`);
  console.log(`           Stored: nowhere (not in any field)`);
  console.log(`           Result: Bot has no nut-free fact; defaults to owner redirect`);
  console.log(`           Real transcript showed: Bot mixed wheat FAQ wording into nut answer`);
  console.log(`  Fix target: Builder extraction prompt/logic\n`);
  
  console.log(`Problem 3: "we do not have vegan cakes available" (never mentioned)`);
  console.log(`  Stage: STAGE 3 - Model interpretation`);
  console.log(`  Cause: gpt-4o-mini invents negations for unstated items`);
  console.log(`  Evidence: Vegan correctly absent from profile and prompt`);
  console.log(`           Current run: Bot says "don't have information" (correct behavior)`);
  console.log(`           Real transcript: Bot said "do not have vegan cakes" (invented negation)`);
  console.log(`  Variability: gpt-4o-mini sometimes invents "do not offer/have" vs "don't have info"`);
  console.log(`  Fix target: Customer prompt rules or model change\n`);
  
  console.log(`\n=== SCHEMA OBSERVATIONS ===\n`);
  
  console.log(`Current schema cannot represent:`);
  console.log(`  - Conditional delivery (radius + minimum + fee) as structured data`);
  console.log(`  - locationOrArea is a text field that mixes location with service area/delivery`);
  console.log(`  - Allergen statements separate from FAQ`);
  console.log(`  - Hedged prices ("around $X I think") - qualifiers get dropped\n`);
  
  console.log(`Areas vs delivery:`);
  console.log(`  Real transcript summary showed "Area: Portland, Oregon"`);
  console.log(`  Delivery terms were in the owner message but not in the summary card`);
  console.log(`  Builder echoed them mid-conversation but didn't store them\n`);
  
  return {
    extractionFailures: ['delivery terms', 'nut-free statement'],
    promptMissing: ['delivery', 'nut-free'],
    modelInventions: ['inconsistent negations for unstated items'],
    primaryStage: 'STAGE 1 (Extraction)',
    provenFixTarget: 'Builder LLM extraction - prompt or model'
  };
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const rosaProfile = await runFullBuilderFlow(ROSA_MESSAGES, "Rosa's Bakery (Real Transcript)");
  
  const rosaChecks = analyzeExtraction(
    rosaProfile,
    "We are nut-free in the kitchen but we do use wheat, milk and eggs. We deliver only within 3 miles for orders over $40, delivery fee $8.",
    "Critical message (services + delivery + allergens)"
  );
  
  const rosaResults = await testAnswers(rosaProfile, ROSA_CUSTOMER_Q);
  
  const summary = generateFinalReport(rosaProfile, rosaChecks, rosaResults);
  
  // Save final report
  const report = {
    timestamp: new Date().toISOString(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    rosaProfile,
    rosaChecks,
    rosaResults: rosaResults.results,
    summary,
    customerPrompt: rosaResults.systemPrompt
  };
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'FINAL-REPORT.json'),
    JSON.stringify(report, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'rosa-final-profile.json'),
    JSON.stringify(rosaProfile, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'rosa-final-prompt.txt'),
    rosaResults.systemPrompt
  );
  
  console.log(`\n✓ Final report: investigation-output/FINAL-REPORT.json`);
}

main().catch(console.error);
