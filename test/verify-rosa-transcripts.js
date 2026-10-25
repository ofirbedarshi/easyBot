#!/usr/bin/env node
/**
 * Verification: Re-run both Rosa transcripts end-to-end
 * Verify delivery terms and nut-free statement are stored and used correctly
 */

import { runBuilderTurn, openingMessage, applyReviewGate, shouldSoftApprove } from '../src/builder.js';
import { emptyProfile, mergeDraft, draftReviewKey } from '../src/profile.js';
import { buildCustomerSystemPrompt } from '../src/customerPrompt.js';
import OpenAI from 'openai';

// Rosa Build 1
const ROSA_BUILD1 = [
  "Hello! I own Rosa's Bakery",
  "I own Rosa's Bakery, a family bakery in Portland, Oregon, open since 1998, famous for our sourdough and custom cakes.",
  "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.",
  "Common ones: do you have gluten-free? No, we can't guarantee, wheat is everywhere in the kitchen. Do you take walk-in cake orders? No, 5 days notice. Can I pay by card? Yes, cash and card in the shop.",
  "Answer questions, and for cake orders collect name, phone, date needed and what kind of cake, I will confirm myself",
  "1"
];

// Rosa Build 2 (rebuild - same messages during goal phase)
const ROSA_BUILD2 = [
  "hello",
  "I own Rosa's Bakery, a family bakery in Portland, Oregon, open since 1998, famous for our sourdough and custom cakes.",
  "Sourdough loaf is $9, croissant $4.50, custom cakes start at $65 and need 5 days notice. We are nut-free in the kitchen but we do use wheat, milk and eggs. Open Tue-Sun 7am-3pm, closed Monday. We deliver only within 3 miles for orders over $40, delivery fee $8.",
  "Common ones: do you have gluten-free? No, we can't guarantee, wheat is everywhere in the kitchen. Do you take walk-in cake orders? No, 5 days notice. Can I pay by card? Yes, cash and card in the shop.",
  "Answer questions, and for cake orders collect name, phone, date needed and what kind of cake, I will confirm myself",
  "1"
];

const DELIVERY_QUESTION = "I want 5 sourdough loaves, that's 45 dollars. I live 2 miles away. Can you deliver it?";
const NUT_QUESTION = "Is your kitchen nut-free? My son has a peanut allergy.";

async function runBuild(messages, buildName) {
  console.log(`\n=== ${buildName} ===`);
  
  const profile = emptyProfile();
  const buildHistory = [];
  
  const opening = openingMessage();
  buildHistory.push({ role: 'assistant', content: opening.message, nav: null });
  
  let tokenCount = 0;
  
  for (let i = 1; i < messages.length; i++) {
    const userMessage = messages[i];
    
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
    
    // Check if this turn should approve
    // Message "1" when a review is already pending means "Try my bot"
    const reviewWasPending = profile.reviewedDraftKey && 
                            profile.reviewedDraftKey === draftReviewKey(profile, turn.draft);
    const softApprove = shouldSoftApprove({ profile, draft: turn.draft, userMessage }) ||
                        (userMessage === '1' && reviewWasPending);
    
    if (turn.approved || softApprove) {
      const merged = mergeDraft(profile, turn.draft);
      Object.assign(profile, merged);
      profile.approvedAt = new Date().toISOString();
      profile.draft = null;
      console.log(`  ✓ Approved after turn ${i}`);
    }
    
    buildHistory.push({ role: 'user', content: userMessage });
    buildHistory.push({ role: 'assistant', content: turn.message });
  }
  
  return { profile, tokenCount };
}

async function testCustomerBot(profile, question) {
  const systemPrompt = buildCustomerSystemPrompt(profile);
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  
  const completion = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question }
    ]
  });
  
  return {
    answer: completion.choices[0].message.content,
    tokens: completion.usage.total_tokens
  };
}

function checkProfile(profile, buildName) {
  console.log(`\nChecking ${buildName} profile:`);
  
  // Check delivery terms
  const hasDelivery = profile.otherFacts?.some(f => f.toLowerCase().includes('deliver'));
  const deliveryFact = profile.otherFacts?.find(f => f.toLowerCase().includes('deliver'));
  
  if (hasDelivery) {
    console.log('  ✓ Delivery terms stored in otherFacts');
    console.log(`    Value: "${deliveryFact}"`);
    
    // Check conditions
    const has3Miles = deliveryFact?.includes('3 miles');
    const has40 = deliveryFact?.includes('40') || deliveryFact?.includes('$40');
    const has8Fee = deliveryFact?.includes('8') || deliveryFact?.includes('$8');
    
    if (has3Miles && has40 && has8Fee) {
      console.log('  ✓ All delivery conditions preserved');
    } else {
      console.log('  ✗ Some delivery conditions missing:');
      console.log(`    - 3 miles: ${has3Miles}`);
      console.log(`    - $40 minimum: ${has40}`);
      console.log(`    - $8 fee: ${has8Fee}`);
    }
  } else {
    console.log('  ✗ Delivery terms NOT stored');
  }
  
  // Check nut-free
  const hasNutFree = profile.otherFacts?.some(f => f.toLowerCase().includes('nut'));
  const nutFact = profile.otherFacts?.find(f => f.toLowerCase().includes('nut'));
  
  if (hasNutFree) {
    console.log('  ✓ Nut-free statement stored in otherFacts');
    console.log(`    Value: "${nutFact}"`);
  } else {
    console.log('  ✗ Nut-free statement NOT stored');
  }
  
  // Check custom cakes qualifier
  const cakeService = profile.services?.find(s => s.name?.toLowerCase().includes('cake'));
  if (cakeService) {
    const hasStartAt = cakeService.price?.includes('start') || cakeService.notes?.includes('start');
    const hasDaysNotice = cakeService.notes?.includes('days') || cakeService.notes?.includes('notice');
    
    console.log('  Custom cakes service:');
    console.log(`    Price: "${cakeService.price}"`);
    console.log(`    Notes: "${cakeService.notes || '(none)'}"`);
    console.log(`    Has "start at": ${hasStartAt}`);
    console.log(`    Has "days notice": ${hasDaysNotice}`);
    
    if (hasStartAt && hasDaysNotice) {
      console.log('  ✓ Custom cakes qualifiers preserved');
    } else {
      console.log('  ✗ Some qualifiers missing');
    }
  }
  
  return { hasDelivery, hasNutFree };
}

function checkAnswers(deliveryAnswer, nutAnswer) {
  console.log('\nChecking customer bot answers:');
  
  // Check delivery answer
  console.log(`  Delivery question answer: "${deliveryAnswer.substring(0, 100)}..."`);
  
  const deliveryHasConditions = deliveryAnswer.includes('3 miles') || 
                                 (deliveryAnswer.includes('40') && deliveryAnswer.includes('deliver'));
  const deliveryDenies = /does not offer|cannot|can't|don't offer/i.test(deliveryAnswer) &&
                         !deliveryAnswer.includes('3 miles');
  
  if (deliveryHasConditions) {
    console.log('  ✓ Delivery answer cites conditions');
  } else if (deliveryDenies) {
    console.log('  ✗ Delivery answer incorrectly denies service');
  } else {
    console.log('  ~ Delivery answer defers to owner (acceptable if facts present)');
  }
  
  // Check nut answer
  console.log(`  Nut-free question answer: "${nutAnswer.substring(0, 100)}..."`);
  
  const nutCitesFactCorrectly = /nut-free/i.test(nutAnswer) && !/can't guarantee.*nut-free/i.test(nutAnswer);
  const nutInverts = /can't guarantee.*nut-free|not nut-free/i.test(nutAnswer);
  const nutMixesWheat = /wheat/i.test(nutAnswer) && /nut/i.test(nutAnswer);
  
  if (nutCitesFactCorrectly) {
    console.log('  ✓ Nut answer cites nut-free correctly');
  } else if (nutInverts) {
    console.log('  ✗ Nut answer inverts the fact');
  } else if (nutMixesWheat) {
    console.log('  ✗ Nut answer mixes wheat FAQ');
  } else {
    console.log('  ~ Nut answer defers to owner (acceptable if facts present)');
  }
}

async function main() {
  console.log('========================================');
  console.log('ROSA TRANSCRIPT VERIFICATION');
  console.log('========================================');
  
  let totalTokens = 0;
  
  // Run Build 1
  const build1 = await runBuild(ROSA_BUILD1, "Rosa Build 1 (services phase)");
  totalTokens += build1.tokenCount;
  
  const build1Checks = checkProfile(build1.profile, "Build 1");
  
  // Test customer bot
  const build1Delivery = await testCustomerBot(build1.profile, DELIVERY_QUESTION);
  totalTokens += build1Delivery.tokens;
  
  const build1Nut = await testCustomerBot(build1.profile, NUT_QUESTION);
  totalTokens += build1Nut.tokens;
  
  checkAnswers(build1Delivery.answer, build1Nut.answer);
  
  console.log('\n' + '='.repeat(40));
  
  // Run Build 2
  const build2 = await runBuild(ROSA_BUILD2, "Rosa Build 2 (goal phase)");
  totalTokens += build2.tokenCount;
  
  const build2Checks = checkProfile(build2.profile, "Build 2");
  
  // Test customer bot
  const build2Delivery = await testCustomerBot(build2.profile, DELIVERY_QUESTION);
  totalTokens += build2Delivery.tokens;
  
  const build2Nut = await testCustomerBot(build2.profile, NUT_QUESTION);
  totalTokens += build2Nut.tokens;
  
  checkAnswers(build2Delivery.answer, build2Nut.answer);
  
  // Summary
  console.log('\n' + '='.repeat(40));
  console.log('SUMMARY');
  console.log('='.repeat(40));
  
  const bothHaveDelivery = build1Checks.hasDelivery && build2Checks.hasDelivery;
  const bothHaveNutFree = build1Checks.hasNutFree && build2Checks.hasNutFree;
  
  if (bothHaveDelivery && bothHaveNutFree) {
    console.log('\n✓ SUCCESS: Both builds captured delivery and nut-free facts');
  } else {
    console.log('\n✗ FAILURE: Facts still missing:');
    if (!bothHaveDelivery) console.log('  - Delivery terms');
    if (!bothHaveNutFree) console.log('  - Nut-free statement');
  }
  
  const costPer1M = 0.15; // gpt-4o-mini input
  const estimatedCost = (totalTokens / 1000000) * costPer1M;
  console.log(`\nTotal tokens: ${totalTokens}`);
  console.log(`Estimated cost: $${estimatedCost.toFixed(4)}`);
}

main().catch(console.error);
