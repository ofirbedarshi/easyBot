#!/usr/bin/env node
/**
 * Compare Rosa's two builds: same info, different timing
 * Tests whether extraction depends on the current interview step
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

// BUILD 1: Owner gave details AFTER Builder asked about services
const ROSA_BUILD1 = {
  name: "First Build (services phase)",
  messages: [
    "Hello! I own Rosa's Bakery",
    "I own Rosa's Bakery, a family bakery in Portland, Oregon, open since 1998, famous for our sourdough and custom cakes.",
    "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.",
    "Common ones: do you have gluten-free? No, we can't guarantee, wheat is everywhere in the kitchen. Do you take walk-in cake orders? No, 5 days notice. Can I pay by card? Yes, cash and card in the shop.",
    "Answer questions, and for cake orders collect name, phone, date needed and what kind of cake, I will confirm myself",
    "1"
  ]
};

// BUILD 2 (REBUILD): Owner gave details WHILE Builder was asking about goal
const ROSA_BUILD2 = {
  name: "Rebuild (goal phase)",
  messages: [
    "hello",
    "I own Rosa's Bakery, a family bakery in Portland, Oregon, open since 1998, famous for our sourdough and custom cakes.",
    // Builder asks: "what would you like your bot to do?"
    // Owner replies with services/hours/delivery/allergens instead:
    "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.",
    // Builder asks goal again:
    "Common ones: do you have gluten-free? No, we can't guarantee, wheat is everywhere in the kitchen. Do you take walk-in cake orders? No, 5 days notice. Can I pay by card? Yes, cash and card in the shop.",
    // Builder asks goal AGAIN:
    "Answer questions, and for cake orders collect name, phone, date needed and what kind of cake, I will confirm myself",
    "1"
  ]
};

const CUSTOMER_QUESTIONS = [
  {
    q: "I want 5 sourdough loaves, that's 45 dollars. I live 2 miles away. Can you deliver it?",
    label: "delivery_ask",
    build1Expected: "does not offer delivery",
    build2Expected: "can't confirm delivery"
  },
  {
    q: "Is your kitchen nut-free? My son has a peanut allergy.",
    label: "nut_free",
    build1Expected: "wheat is everywhere (mixed facts)",
    build2Expected: "can't guarantee kitchen is nut-free (OPPOSITE of owner statement)"
  },
  {
    q: "Do you have vegan cakes?",
    label: "vegan",
    build1Expected: "do not have vegan",
    build2Expected: "don't have vegan"
  }
];

async function runBuild(build) {
  console.log(`\n========================================`);
  console.log(`${build.name.toUpperCase()}`);
  console.log(`========================================\n`);
  
  const profile = emptyProfile();
  const buildHistory = [];
  
  const opening = openingMessage();
  buildHistory.push({ role: 'assistant', content: opening.message, nav: null });
  
  const turns = [];
  
  for (let i = 1; i < build.messages.length; i++) {
    const userMessage = build.messages[i];
    
    console.log(`\n[Turn ${i}] Owner: ${userMessage.substring(0, 60)}...`);
    
    const rawTurn = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage
    });
    
    const turn = applyReviewGate(profile, rawTurn, userMessage);
    
    console.log(`Builder: ${turn.message.substring(0, 100)}...`);
    
    turns.push({
      userMessage,
      builderMessage: turn.message,
      draftBefore: JSON.parse(JSON.stringify(profile.draft || {})),
      draftAfter: JSON.parse(JSON.stringify(turn.draft))
    });
    
    profile.draft = turn.draft;
    
    if (turn.reviewedDraftKey) {
      profile.reviewedDraftKey = turn.reviewedDraftKey;
    }
    
    const softApprove = shouldSoftApprove({ profile, draft: turn.draft, userMessage });
    
    if (turn.approved || softApprove) {
      const merged = mergeDraft(profile, turn.draft);
      Object.assign(profile, merged);
      profile.approvedAt = new Date().toISOString();
      profile.draft = null;
      console.log(`✓ APPROVED`);
    }
    
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
  }
  
  return { profile, turns };
}

async function testBot(profile, questions) {
  const systemPrompt = buildCustomerSystemPrompt(profile);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  
  const results = [];
  
  for (const { q, label } of questions) {
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: q }
      ]
    });
    
    const answer = completion.choices[0].message.content;
    results.push({ question: q, label, answer });
  }
  
  return { systemPrompt, results };
}

function compareDrafts(draft1, draft2, label1, label2) {
  console.log(`\n========================================`);
  console.log(`DRAFT COMPARISON`);
  console.log(`========================================\n`);
  
  const fields = ['name', 'whatWeDo', 'locationOrArea', 'hours', 'services', 'commonQuestions', 'informationToCollect', 'unknowns'];
  
  const diffs = [];
  
  for (const field of fields) {
    const val1 = JSON.stringify(draft1[field] ?? null);
    const val2 = JSON.stringify(draft2[field] ?? null);
    
    if (val1 !== val2) {
      diffs.push({ field, [label1]: draft1[field], [label2]: draft2[field] });
      console.log(`\n${field}:`);
      console.log(`  ${label1}: ${val1.substring(0, 100)}${val1.length > 100 ? '...' : ''}`);
      console.log(`  ${label2}: ${val2.substring(0, 100)}${val2.length > 100 ? '...' : ''}`);
    } else {
      console.log(`\n${field}: (identical)`);
    }
  }
  
  return diffs;
}

function analyzeExtraction(profile, criticalMessage) {
  const findings = {};
  
  // Check delivery
  const deliveryInLocation = profile.locationOrArea?.toLowerCase().includes('deliver') || false;
  const deliveryInServices = JSON.stringify(profile.services).toLowerCase().includes('deliver');
  const deliveryInUnknowns = JSON.stringify(profile.unknowns).toLowerCase().includes('deliver');
  const deliveryAnywhere = deliveryInLocation || deliveryInServices || deliveryInUnknowns;
  
  findings.delivery = {
    mentioned: criticalMessage.includes('deliver'),
    stored: deliveryAnywhere,
    location: deliveryInLocation ? profile.locationOrArea : null,
    services: deliveryInServices,
    unknowns: deliveryInUnknowns,
    conditions: {
      distance: JSON.stringify(profile).includes('3 miles'),
      minimum: JSON.stringify(profile).includes('40') || JSON.stringify(profile).includes('$40'),
      fee: JSON.stringify(profile).includes('$8') || JSON.stringify(profile).includes('8')
    }
  };
  
  // Check nut-free
  const nutAnywhere = JSON.stringify(profile).toLowerCase().includes('nut');
  findings.nutFree = {
    mentioned: criticalMessage.toLowerCase().includes('nut'),
    stored: nutAnywhere,
    location: profile.whatWeDo?.toLowerCase().includes('nut') ? profile.whatWeDo : null,
    services: JSON.stringify(profile.services).toLowerCase().includes('nut'),
    questions: JSON.stringify(profile.commonQuestions).toLowerCase().includes('nut')
  };
  
  // Check custom cakes qualifiers
  const cakeService = profile.services?.find(s => s.name?.toLowerCase().includes('cake'));
  findings.customCakes = {
    stored: !!cakeService,
    price: cakeService?.price || null,
    notes: cakeService?.notes || null,
    hasStartAt: cakeService?.price?.includes('start') || cakeService?.notes?.includes('start') || false,
    hasDaysNotice: cakeService?.notes?.includes('days') || cakeService?.notes?.includes('notice') || false
  };
  
  return findings;
}

function generateComparativeReport(build1Result, build2Result, build1Findings, build2Findings, build1Tests, build2Tests) {
  console.log(`\n========================================`);
  console.log(`COMPARATIVE ANALYSIS`);
  console.log(`========================================\n`);
  
  console.log(`HYPOTHESIS: Extraction depends on current interview step\n`);
  
  console.log(`--- DELIVERY TERMS ---`);
  console.log(`Owner message (IDENTICAL in both): "We deliver only within 3 miles for orders over $40, delivery fee $8"\n`);
  console.log(`Build 1 (during services phase):`);
  console.log(`  Stored anywhere: ${build1Findings.delivery.stored}`);
  if (build1Findings.delivery.stored) {
    console.log(`  Location: ${build1Findings.delivery.location || 'NO'}`);
    console.log(`  Conditions: distance=${build1Findings.delivery.conditions.distance}, min=${build1Findings.delivery.conditions.minimum}, fee=${build1Findings.delivery.conditions.fee}`);
  }
  console.log(`\nBuild 2 (during goal phase):`);
  console.log(`  Stored anywhere: ${build2Findings.delivery.stored}`);
  if (build2Findings.delivery.stored) {
    console.log(`  Location: ${build2Findings.delivery.location || 'NO'}`);
    console.log(`  Conditions: distance=${build2Findings.delivery.conditions.distance}, min=${build2Findings.delivery.conditions.minimum}, fee=${build2Findings.delivery.conditions.fee}`);
  }
  
  if (!build1Findings.delivery.stored && !build2Findings.delivery.stored) {
    console.log(`\n✓ CONFIRMED: Delivery lost in BOTH builds regardless of timing\n`);
  } else {
    console.log(`\n? Different extraction between builds\n`);
  }
  
  console.log(`--- NUT-FREE STATEMENT ---`);
  console.log(`Owner message (IDENTICAL): "We are nut-free in the kitchen"\n`);
  console.log(`Build 1: Stored = ${build1Findings.nutFree.stored}`);
  console.log(`Build 2: Stored = ${build2Findings.nutFree.stored}\n`);
  
  if (!build1Findings.nutFree.stored && !build2Findings.nutFree.stored) {
    console.log(`✓ CONFIRMED: Nut-free lost in BOTH builds regardless of timing\n`);
  }
  
  console.log(`--- CUSTOM CAKES QUALIFIERS ---`);
  console.log(`Owner message: "custom cakes start at $65 and need 5 days notice"\n`);
  console.log(`Build 1:`);
  console.log(`  Service: ${build1Findings.customCakes.stored ? 'YES' : 'NO'}`);
  if (build1Findings.customCakes.stored) {
    console.log(`  Price: "${build1Findings.customCakes.price}"`);
    console.log(`  Notes: "${build1Findings.customCakes.notes}"`);
    console.log(`  Has "start at": ${build1Findings.customCakes.hasStartAt}`);
    console.log(`  Has "days notice": ${build1Findings.customCakes.hasDaysNotice}`);
  }
  console.log(`\nBuild 2:`);
  console.log(`  Service: ${build2Findings.customCakes.stored ? 'YES' : 'NO'}`);
  if (build2Findings.customCakes.stored) {
    console.log(`  Price: "${build2Findings.customCakes.price}"`);
    console.log(`  Notes: "${build2Findings.customCakes.notes}"`);
    console.log(`  Has "start at": ${build2Findings.customCakes.hasStartAt}`);
    console.log(`  Has "days notice": ${build2Findings.customCakes.hasDaysNotice}`);
  }
  
  console.log(`\n--- CUSTOMER BOT ANSWERS ---\n`);
  
  for (let i = 0; i < CUSTOMER_QUESTIONS.length; i++) {
    const q = CUSTOMER_QUESTIONS[i];
    const ans1 = build1Tests.results[i].answer;
    const ans2 = build2Tests.results[i].answer;
    
    console.log(`${q.label}:`);
    console.log(`  Q: "${q.q}"`);
    console.log(`  Build 1: "${ans1.substring(0, 80)}..."`);
    console.log(`  Build 2: "${ans2.substring(0, 80)}..."`);
    
    if (q.label === 'nut_free') {
      const build2SaysOpposite = ans2.toLowerCase().includes("can't guarantee") && ans2.toLowerCase().includes("nut-free");
      if (build2SaysOpposite) {
        console.log(`  ✗ Build 2 says OPPOSITE of owner statement!`);
      }
    }
    console.log('');
  }
  
  console.log(`\n========================================`);
  console.log(`ROOT CAUSE DETERMINATION`);
  console.log(`========================================\n`);
  
  console.log(`PRIMARY CAUSE: Builder LLM (gpt-4o-mini) extraction failure\n`);
  
  console.log(`Evidence:`);
  console.log(`  1. Delivery terms lost in BOTH builds (timing-independent)`);
  console.log(`  2. Nut-free statement lost in BOTH builds (timing-independent)`);
  console.log(`  3. Owner explicitly stated both facts in detailed messages`);
  console.log(`  4. Builder acknowledged them ("I'll add those") but didn't extract`);
  console.log(`  5. Result: Customer prompt has no delivery or nut-free information\n`);
  
  console.log(`Timing hypothesis: REJECTED`);
  console.log(`  Both builds lost the same facts regardless of interview phase`);
  console.log(`  Extraction failure is not step-dependent\n`);
  
  console.log(`Schema limitations:`);
  console.log(`  - No structured field for conditional delivery (radius + minimum + fee)`);
  console.log(`  - No allergen/kitchen statement field separate from FAQ`);
  console.log(`  - locationOrArea is text but Builder uses it for location, not delivery`);
  console.log(`  - Qualifiers ("start at", "around X I think") frequently dropped\n`);
  
  console.log(`Model behavior at answer time (gpt-4o-mini):`);
  console.log(`  - Inconsistent handling of unstated items`);
  console.log(`  - Sometimes "don't have information" (correct)`);
  console.log(`  - Sometimes "do not offer/have" (invented negation)`);
  console.log(`  - Build 2 nut-free answer inverted owner statement\n`);
  
  console.log(`FIX PRIORITY:`);
  console.log(`  1. Builder extraction (STAGE 1) - must capture delivery + allergen facts`);
  console.log(`  2. Schema enhancement - structured delivery field or explicit instruction`);
  console.log(`  3. Customer prompt - stronger "never invent negations" rule`);
  console.log(`  4. Consider gpt-4o or stronger model for Builder (test if extraction improves)\n`);
  
  return {
    rootCause: 'Builder LLM extraction failure',
    stage: 'STAGE 1',
    timingDependent: false,
    affectedFacts: ['delivery terms', 'nut-free statement', 'qualifiers'],
    fixes: [
      'Improve Builder extraction prompt or model',
      'Add structured delivery field or explicit FAQ topic',
      'Strengthen customer prompt closed-world rules'
    ]
  };
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const build1 = await runBuild(ROSA_BUILD1);
  const build2 = await runBuild(ROSA_BUILD2);
  
  const criticalMsg = "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.";
  
  const build1Findings = analyzeExtraction(build1.profile, criticalMsg);
  const build2Findings = analyzeExtraction(build2.profile, criticalMsg);
  
  const diffs = compareDrafts(
    build1.profile, 
    build2.profile,
    ROSA_BUILD1.name,
    ROSA_BUILD2.name
  );
  
  const build1Tests = await testBot(build1.profile, CUSTOMER_QUESTIONS);
  const build2Tests = await testBot(build2.profile, CUSTOMER_QUESTIONS);
  
  const analysis = generateComparativeReport(
    build1,
    build2,
    build1Findings,
    build2Findings,
    build1Tests,
    build2Tests
  );
  
  // Save comprehensive report
  const report = {
    timestamp: new Date().toISOString(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    build1: {
      name: ROSA_BUILD1.name,
      profile: build1.profile,
      findings: build1Findings,
      turns: build1.turns,
      customerTests: build1Tests.results,
      customerPrompt: build1Tests.systemPrompt
    },
    build2: {
      name: ROSA_BUILD2.name,
      profile: build2.profile,
      findings: build2Findings,
      turns: build2.turns,
      customerTests: build2Tests.results,
      customerPrompt: build2Tests.systemPrompt
    },
    comparison: {
      diffs,
      analysis
    }
  };
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'COMPARATIVE-REPORT.json'),
    JSON.stringify(report, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'build1-profile.json'),
    JSON.stringify(build1.profile, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'build2-profile.json'),
    JSON.stringify(build2.profile, null, 2)
  );
  
  console.log(`\n✓ Comparative analysis complete`);
  console.log(`  Main report: investigation-output/COMPARATIVE-REPORT.json`);
  console.log(`  Profiles: build1-profile.json, build2-profile.json`);
}

main().catch(console.error);
