#!/usr/bin/env node
/**
 * Reproduce the ACTUAL Rosa's Bakery conversation from 2026-10-25 WhatsApp transcript.
 * Trace where delivery terms and nut-free statement get lost or distorted.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { runBuilderTurn, openingMessage, applyReviewGate } from './src/builder.js';
import { emptyProfile, mergeDraft } from './src/profile.js';
import { buildCustomerSystemPrompt } from './src/customerPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, 'investigation-output');

// EXACT owner messages from the real transcript
const ROSA_REAL_MESSAGES = [
  // Wake (discarded by app)
  "Hello! I own Rosa's Bakery, a family bakery in Portland, Oregon, we've been there since 1998 and everybody loves our sourdough",
  
  // After opening
  "I own Rosa's Bakery, a family bakery in Portland, Oregon, open since 1998, famous for our sourdough and custom cakes.",
  
  // Services with delivery terms and nut-free statement
  "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.",
  
  // FAQ
  "Common ones: do you have gluten-free? No, we can't guarantee, wheat is everywhere in the kitchen. Do you take walk-in cake orders? No, 5 days notice. Can I pay by card? Yes, cash and card in the shop.",
  
  // Goal + intake
  "Answer questions, and for cake orders collect name, phone, date needed and what kind of cake, I will confirm myself",
  
  // Approve
  "1"
];

// Customer questions from the real transcript
const ROSA_CUSTOMER_QUESTIONS = [
  {
    q: "Do you deliver to my place 2 miles away? I want 1 sourdough and 2 croissants",
    label: "delivery_2_miles_$18",
    expectedIssue: "Should say delivery available (within 3 miles, order needs to be $40+, $8 fee). Bot said 'does not offer delivery services'"
  },
  {
    q: "Is anything nut free? My son has a peanut allergy, is it safe for him?",
    label: "peanut_allergy",
    expectedIssue: "Should cite nut-free kitchen + owner confirmation for safety. Bot mixed it with wheat FAQ wording"
  },
  {
    q: "Do you have vegan or gluten free cakes?",
    label: "vegan_gluten_free",
    expectedIssue: "Gluten-free is in FAQ (no). Vegan never mentioned - should say unknown. Bot said 'we do not have vegan cakes available'"
  }
];

async function reproduceRosaConversation() {
  console.log('=== REPRODUCING ROSA\'S REAL CONVERSATION ===\n');
  
  const profile = emptyProfile();
  const buildHistory = [];
  
  // Opening (first message discarded, triggers fixed welcome)
  const opening = openingMessage();
  buildHistory.push({ role: 'assistant', content: opening.message, nav: null });
  
  const stages = [];
  
  for (let i = 1; i < ROSA_REAL_MESSAGES.length; i++) {
    const userMessage = ROSA_REAL_MESSAGES[i];
    console.log(`\n[OWNER ${i}]: ${userMessage.substring(0, 80)}...`);
    
    const rawTurn = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage
    });
    
    const turn = applyReviewGate(profile, rawTurn, userMessage);
    
    console.log(`[BUILDER]: ${turn.message.substring(0, 120)}...`);
    
    // Update profile
    profile.draft = turn.draft;
    if (turn.presentReview) {
      profile.reviewedDraftKey = turn.reviewedDraftKey;
    }
    
    if (turn.approved) {
      const merged = mergeDraft(profile, turn.draft);
      Object.assign(profile, merged);
      profile.approvedAt = new Date().toISOString();
      profile.draft = null;
      console.log('✓ APPROVED\n');
    }
    
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
    
    stages.push({
      turn: i,
      userMessage,
      builderMessage: turn.message,
      draft: JSON.parse(JSON.stringify(turn.draft)),
      approved: turn.approved,
      reviewPresented: turn.presentReview
    });
  }
  
  return { profile, stages, buildHistory };
}

function analyzeFactStorage(profile, ownerMessages) {
  console.log('\n=== FACT STORAGE ANALYSIS ===\n');
  
  const findings = [];
  
  // The critical message with delivery and nut-free
  const criticalMsg = ownerMessages[2];
  console.log('Critical owner message:');
  console.log(`  "${criticalMsg}"\n`);
  
  // Check what got stored
  console.log('Stored profile fields:');
  console.log(`  name: "${profile.name}"`);
  console.log(`  whatWeDo: "${profile.whatWeDo}"`);
  console.log(`  locationOrArea: "${profile.locationOrArea}"`);
  console.log(`  hours: "${profile.hours}"`);
  console.log(`  services: ${JSON.stringify(profile.services, null, 2)}`);
  console.log(`  unknowns: ${JSON.stringify(profile.unknowns)}`);
  console.log(`  commonQuestions: ${profile.commonQuestions.length} items\n`);
  
  findings.push({
    topic: 'Delivery terms',
    ownerSaid: 'We deliver only within 3 miles for orders over $40, delivery fee $8',
    foundIn: {
      name: profile.name?.includes('deliver') || false,
      whatWeDo: profile.whatWeDo?.includes('deliver') || false,
      locationOrArea: profile.locationOrArea?.includes('deliver') || profile.locationOrArea?.includes('3 miles') || false,
      hours: profile.hours?.includes('deliver') || false,
      services: JSON.stringify(profile.services).includes('deliver'),
      unknowns: JSON.stringify(profile.unknowns).includes('deliver'),
      commonQuestions: JSON.stringify(profile.commonQuestions).includes('deliver')
    },
    analysis: 'Trace where "deliver only within 3 miles for orders over $40, delivery fee $8" ended up'
  });
  
  findings.push({
    topic: 'Nut-free statement',
    ownerSaid: 'We are nut-free in the kitchen but we do use wheat, milk and eggs',
    foundIn: {
      name: profile.name?.includes('nut') || false,
      whatWeDo: profile.whatWeDo?.includes('nut') || false,
      services: JSON.stringify(profile.services).toLowerCase().includes('nut'),
      unknowns: JSON.stringify(profile.unknowns).toLowerCase().includes('nut'),
      commonQuestions: JSON.stringify(profile.commonQuestions).toLowerCase().includes('nut')
    },
    analysis: 'Trace where "nut-free in the kitchen" statement ended up'
  });
  
  findings.push({
    topic: 'Vegan cakes (never mentioned)',
    ownerSaid: '(never mentioned vegan)',
    foundIn: {
      services: JSON.stringify(profile.services).toLowerCase().includes('vegan'),
      unknowns: JSON.stringify(profile.unknowns).toLowerCase().includes('vegan'),
      commonQuestions: JSON.stringify(profile.commonQuestions).toLowerCase().includes('vegan')
    },
    analysis: 'Should be absent everywhere - was it invented as a negation?'
  });
  
  return findings;
}

function analyzeCustomerPrompt(systemPrompt) {
  console.log('\n=== CUSTOMER PROMPT ANALYSIS ===\n');
  
  const sections = {
    facts: systemPrompt.match(/=== APPROVED BUSINESS FACTS ===[\s\S]*?EXPLICIT UNKNOWNS/)?.[0] || '(not found)',
    unknowns: systemPrompt.match(/EXPLICIT UNKNOWNS[\s\S]*?INFORMATION TO COLLECT/)?.[0] || '(not found)',
    collect: systemPrompt.match(/INFORMATION TO COLLECT[\s\S]*?=== BOT OBJECTIVE ===/)?.[0] || '(not found)'
  };
  
  console.log('Does customer prompt contain:');
  console.log(`  "deliver" or "delivery": ${/deliver/i.test(systemPrompt)}`);
  console.log(`  "3 miles": ${/3 miles/i.test(systemPrompt)}`);
  console.log(`  "$40" or "40": ${/\$?40/.test(systemPrompt)}`);
  console.log(`  "nut-free" or "nut free": ${/nut[- ]free/i.test(systemPrompt)}`);
  console.log(`  "wheat is everywhere": ${/wheat is everywhere/i.test(systemPrompt)}`);
  console.log(`  "vegan": ${/vegan/i.test(systemPrompt)}\n`);
  
  const findings = [];
  
  findings.push({
    topic: 'Delivery in APPROVED BUSINESS FACTS',
    present: /deliver/i.test(sections.facts),
    details: sections.facts.includes('deliver') ? 
      sections.facts.match(/.*deliver.*/i)?.[0] : 
      'NOT FOUND'
  });
  
  findings.push({
    topic: 'Nut-free in APPROVED BUSINESS FACTS',
    present: /nut/i.test(sections.facts),
    details: sections.facts.toLowerCase().includes('nut') ?
      sections.facts.match(/.*nut.*/i)?.[0] :
      'NOT FOUND'
  });
  
  findings.push({
    topic: 'Delivery in UNKNOWNS',
    present: /deliver/i.test(sections.unknowns),
    details: sections.unknowns.includes('deliver') ?
      sections.unknowns.match(/.*deliver.*/i)?.[0] :
      'NOT FOUND'
  });
  
  return { sections, findings };
}

async function testCustomerBot(profile, questions) {
  console.log('\n=== CUSTOMER BOT TESTING ===\n');
  
  const systemPrompt = buildCustomerSystemPrompt(profile);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  
  const results = [];
  
  for (const { q, label, expectedIssue } of questions) {
    console.log(`\nQuestion (${label}):`);
    console.log(`  Customer: "${q}"`);
    console.log(`  Expected issue: ${expectedIssue}\n`);
    
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: q }
    ];
    
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      messages
    });
    
    const answer = completion.choices[0].message.content;
    console.log(`  Bot answer: "${answer}"\n`);
    
    results.push({
      question: q,
      label,
      expectedIssue,
      answer,
      tokens: completion.usage
    });
  }
  
  return { systemPrompt, results };
}

function generateReport(profile, stages, storageFindings, promptAnalysis, customerResults) {
  console.log('\n========================================');
  console.log('FINAL DIAGNOSTIC REPORT');
  console.log('========================================\n');
  
  console.log('STAGE 1: EXTRACTION & STORAGE\n');
  
  for (const finding of storageFindings) {
    console.log(`${finding.topic}:`);
    console.log(`  Owner said: "${finding.ownerSaid}"`);
    console.log(`  Found in fields:`);
    for (const [field, present] of Object.entries(finding.foundIn)) {
      if (present) {
        console.log(`    ✓ ${field}`);
        // Show the actual value
        if (field === 'locationOrArea') {
          console.log(`      Value: "${profile.locationOrArea}"`);
        } else if (field === 'unknowns') {
          console.log(`      Value: ${JSON.stringify(profile.unknowns)}`);
        }
      } else {
        console.log(`    ✗ ${field}`);
      }
    }
    console.log('');
  }
  
  console.log('STAGE 2: CUSTOMER PROMPT\n');
  
  for (const finding of promptAnalysis.findings) {
    console.log(`${finding.topic}: ${finding.present ? '✓ PRESENT' : '✗ MISSING'}`);
    if (finding.present) {
      console.log(`  Details: ${finding.details}`);
    }
    console.log('');
  }
  
  console.log('STAGE 3: CUSTOMER BOT ANSWERS\n');
  
  for (const result of customerResults.results) {
    console.log(`${result.label}:`);
    console.log(`  Expected issue: ${result.expectedIssue}`);
    console.log(`  Actual answer: "${result.answer.substring(0, 150)}..."`);
    console.log(`  Verified: ${result.answer.toLowerCase().includes('does not offer') ? '✓ Issue reproduced' : '? Different behavior'}`);
    console.log('');
  }
  
  console.log('ROOT CAUSE MAPPING:\n');
  
  const rootCauses = [];
  
  // Delivery
  const deliveryInStorage = storageFindings[0].foundIn.locationOrArea || 
                           storageFindings[0].foundIn.unknowns ||
                           storageFindings[0].foundIn.services;
  const deliveryInPrompt = promptAnalysis.findings[0].present;
  
  if (!deliveryInStorage) {
    rootCauses.push({
      problem: "Rosa's delivery denied (2 miles, $18 order)",
      stage: 'STAGE 1: Extraction',
      cause: 'Delivery terms lost during Builder extraction - not stored in any field',
      evidence: 'Owner said "deliver only within 3 miles for orders over $40, delivery fee $8" but profile has no delivery info'
    });
  } else if (!deliveryInPrompt) {
    rootCauses.push({
      problem: "Rosa's delivery denied",
      stage: 'STAGE 2: Prompt building',
      cause: 'Delivery terms stored but not included in customer prompt',
      evidence: `Stored in ${Object.entries(storageFindings[0].foundIn).filter(([k,v]) => v).map(([k]) => k).join(', ')} but missing from APPROVED BUSINESS FACTS`
    });
  } else {
    rootCauses.push({
      problem: "Rosa's delivery denied",
      stage: 'STAGE 3: Model interpretation',
      cause: 'Delivery terms in prompt but model says "does not offer delivery"',
      evidence: 'Prompt contains delivery info but gpt-4o-mini invents denial'
    });
  }
  
  // Nut-free / peanut allergy
  const nutInStorage = storageFindings[1].foundIn.commonQuestions ||
                       storageFindings[1].foundIn.unknowns ||
                       storageFindings[1].foundIn.whatWeDo;
  const nutInPrompt = promptAnalysis.findings[1].present;
  
  if (!nutInStorage) {
    rootCauses.push({
      problem: 'Peanut allergy answer mixes wheat fact',
      stage: 'STAGE 1: Extraction',
      cause: 'Nut-free statement lost during extraction',
      evidence: 'Owner said "nut-free in the kitchen" but not stored anywhere'
    });
  } else if (!nutInPrompt) {
    rootCauses.push({
      problem: 'Peanut allergy answer mixes wheat fact',
      stage: 'STAGE 2: Prompt building',
      cause: 'Nut-free stored but not in customer prompt',
      evidence: 'Model has no nut-free fact to cite, reuses wheat FAQ instead'
    });
  }
  
  // Vegan (never mentioned)
  const veganInStorage = storageFindings[2].foundIn.commonQuestions ||
                        storageFindings[2].foundIn.unknowns;
  
  if (veganInStorage) {
    rootCauses.push({
      problem: 'Vegan cakes invented as denial',
      stage: 'STAGE 1: Extraction',
      cause: 'Builder invented "no vegan" despite never being mentioned',
      evidence: 'Vegan appears in stored profile but owner never said it'
    });
  } else {
    rootCauses.push({
      problem: 'Vegan cakes invented as denial',
      stage: 'STAGE 3: Model interpretation',
      cause: 'gpt-4o-mini invents "we do not have vegan cakes" for unstated item',
      evidence: 'Vegan absent from profile and prompt (correct), but model says "do not have"'
    });
  }
  
  for (const rc of rootCauses) {
    console.log(`Problem: ${rc.problem}`);
    console.log(`  Stage: ${rc.stage}`);
    console.log(`  Cause: ${rc.cause}`);
    console.log(`  Evidence: ${rc.evidence}\n`);
  }
  
  return rootCauses;
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  
  const result = await reproduceRosaConversation();
  
  const storageFindings = analyzeFactStorage(result.profile, ROSA_REAL_MESSAGES);
  
  const promptAnalysis = analyzeCustomerPrompt(buildCustomerSystemPrompt(result.profile));
  
  const customerResults = await testCustomerBot(result.profile, ROSA_CUSTOMER_QUESTIONS);
  
  const rootCauses = generateReport(
    result.profile,
    result.stages,
    storageFindings,
    promptAnalysis,
    customerResults
  );
  
  // Save artifacts
  const report = {
    timestamp: new Date().toISOString(),
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    ownerMessages: ROSA_REAL_MESSAGES,
    profile: result.profile,
    stages: result.stages,
    storageFindings,
    promptAnalysis: promptAnalysis.findings,
    customerResults: customerResults.results,
    rootCauses
  };
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'rosa-real-report.json'),
    JSON.stringify(report, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'rosa-real-profile.json'),
    JSON.stringify(result.profile, null, 2)
  );
  
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'rosa-real-customer-prompt.txt'),
    customerResults.systemPrompt
  );
  
  console.log(`\n✓ Rosa real conversation analysis complete`);
  console.log(`  Artifacts: investigation-output/rosa-real-*`);
}

main().catch(console.error);
