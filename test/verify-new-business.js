#!/usr/bin/env node
/**
 * Verification: New fictional business (non-bakery domain) with off-schema facts
 */

import { runBuilderTurn, openingMessage, applyReviewGate, shouldSoftApprove } from '../src/builder.js';
import { emptyProfile, mergeDraft, draftReviewKey } from '../src/profile.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import OpenAI from 'openai';

// Luna's Auto Detailing - automotive service business
const MESSAGES = [
  "hi",
  "I'm Mike, I run Luna's Auto Detailing. We do car detailing - basic wash is $30, full detail is $120.",
  "We only work on sedans and SUVs, no trucks over 8 feet. Mobile service available within 15 miles, add $25 travel fee. We use eco-friendly products, completely biodegradable. Appointments require 24 hours notice.",
  "Open Mon-Sat 8am-6pm",
  "Common question: do you do interiors? Yes, full detail includes interior deep clean.",
  "Answer questions and collect their name, phone, vehicle type",
  "looks good"
];

const TEST_QUESTIONS = [
  {
    q: "I have a pickup truck, can you detail it?",
    label: "vehicle_restriction",
    shouldMention: ["sedan", "SUV", "no trucks over 8 feet"]
  },
  {
    q: "Can you come to my house 20 miles away?",
    label: "mobile_service_range",
    shouldMention: ["15 miles", "travel"]
  },
  {
    q: "What kind of products do you use?",
    label: "eco_products",
    shouldMention: ["eco-friendly", "biodegradable"]
  },
  {
    q: "Can I book for tomorrow morning?",
    label: "notice_requirement",
    shouldMention: ["24 hours", "notice"]
  }
];

async function runBuild() {
  console.log('=== Luna\'s Auto Detailing (fictional business) ===\n');
  
  const profile = emptyProfile();
  const buildHistory = [];
  
  const opening = openingMessage();
  buildHistory.push({ role: 'assistant', content: opening.message, nav: null });
  
  let tokenCount = 0;
  
  for (let i = 1; i < MESSAGES.length; i++) {
    const userMessage = MESSAGES[i];
    
    const rawTurn = await runBuilderTurn({
      buildHistory,
      profile,
      userMessage
    });
    
    tokenCount += rawTurn.usage?.total_tokens || 0;
    
    const turn = applyReviewGate(profile, rawTurn, userMessage);
    
    profile.draft = turn.draft;
    
    if (turn.reviewedDraftKey) {
      profile.reviewedDraftKey = turn.reviewedDraftKey;
    }
    
    const reviewWasPending = profile.reviewedDraftKey && 
                            profile.reviewedDraftKey === draftReviewKey(profile, turn.draft);
    const softApprove = shouldSoftApprove({ profile, draft: turn.draft, userMessage}) ||
                        (userMessage === 'looks good' && reviewWasPending);
    
    if (turn.approved || softApprove) {
      const merged = mergeDraft(profile, turn.draft);
      Object.assign(profile, merged);
      profile.approvedAt = new Date().toISOString();
      profile.draft = null;
      console.log(`✓ Approved after turn ${i}\n`);
    }
    
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
  }
  
  return { profile, tokenCount };
}

function checkProfile(profile) {
  console.log('Checking stored facts:\n');
  
  const expectedFacts = [
    { name: "Vehicle restrictions", keywords: ["sedan", "SUV", "truck"] },
    { name: "Mobile service range", keywords: ["15 miles", "travel", "mobile"] },
    { name: "Eco-friendly products", keywords: ["eco", "biodegradable"] },
    { name: "24-hour notice requirement", keywords: ["24 hour", "notice", "appointment"] }
  ];
  
  let allFound = true;
  
  for (const expected of expectedFacts) {
    const found = profile.otherFacts?.some(f => 
      expected.keywords.some(kw => f.toLowerCase().includes(kw.toLowerCase()))
    );
    
    if (found) {
      const fact = profile.otherFacts.find(f => 
        expected.keywords.some(kw => f.toLowerCase().includes(kw.toLowerCase()))
      );
      console.log(`✓ ${expected.name}`);
      console.log(`  Stored as: "${fact}"\n`);
    } else {
      console.log(`✗ ${expected.name} NOT FOUND\n`);
      allFound = false;
    }
  }
  
  return { allFound, factCount: profile.otherFacts?.length || 0 };
}

async function testAnswers(profile) {
  console.log('Testing customer bot answers:\n');
  
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const systemPrompt = buildCustomerSystemPrompt(profile);
  
  let tokenCount = 0;
  let allCorrect = true;
  
  for (const { q, label, shouldMention } of TEST_QUESTIONS) {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: q }
      ]
    });
    
    const answer = completion.choices[0].message.content;
    tokenCount += completion.usage.total_tokens;
    
    console.log(`${label}:`);
    console.log(`  Q: "${q}"`);
    console.log(`  A: "${answer.substring(0, 100)}..."`);
    
    const mentioned = shouldMention.filter(term => 
      answer.toLowerCase().includes(term.toLowerCase())
    );
    
    if (mentioned.length > 0) {
      console.log(`  ✓ Cites: ${mentioned.join(', ')}\n`);
    } else {
      console.log(`  ✗ Missing expected terms: ${shouldMention.join(', ')}\n`);
      allCorrect = false;
    }
  }
  
  return { allCorrect, tokenCount };
}

async function main() {
  console.log('========================================');
  console.log('NEW FICTIONAL BUSINESS VERIFICATION');
  console.log('========================================\n');
  
  const build = await runBuild();
  const profileCheck = checkProfile(build.profile);
  const answerTests = await testAnswers(build.profile);
  
  const totalTokens = build.tokenCount + answerTests.tokenCount;
  const cost = (totalTokens / 1000000) * 0.15;
  
  console.log('========================================');
  console.log('SUMMARY');
  console.log('========================================\n');
  
  if (profileCheck.allFound) {
    console.log('✓ All off-schema facts captured');
  } else {
    console.log('✗ Some facts missing');
  }
  
  console.log(`  otherFacts count: ${profileCheck.factCount}`);
  
  if (answerTests.allCorrect) {
    console.log('✓ Customer bot cites facts correctly\n');
  } else {
    console.log('✗ Some answers missing expected facts\n');
  }
  
  console.log(`Total tokens: ${totalTokens}`);
  console.log(`Estimated cost: $${cost.toFixed(4)}`);
}

main().catch(console.error);
