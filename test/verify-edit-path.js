#!/usr/bin/env node
/**
 * Verification: Edit path - add fact and change price without losing existing facts
 */

import { runBuilderTurn, applyReviewGate } from '../src/builder.js';
import { emptyProfile, mergeDraft, draftReviewKey } from '../src/profile.js';

// Start with approved profile
const startProfile = {
  ...emptyProfile(),
  name: 'Test Shop',
  services: [{ name: 'Service A', price: '$50', notes: null }],
  hours: 'Mon-Fri 9-5',
  otherFacts: ['We require 48 hours notice for cancellations'],
  informationToCollect: ['name', 'phone'],
  approvedAt: new Date().toISOString()
};

async function testEdit() {
  console.log('=== EDIT PATH TEST ===\n');
  console.log('Starting profile:');
  console.log(`  Services: ${JSON.stringify(startProfile.services)}`);
  console.log(`  Other facts: ${JSON.stringify(startProfile.otherFacts)}\n`);
  
  const profile = { ...startProfile };
  const buildHistory = [];
  
  // Edit: change price and add new fact
  const editMessage = 'Change Service A to $60, and also we now have free parking available';
  
  const rawTurn = await runBuilderTurn({
    buildHistory,
    profile,
    userMessage: editMessage
  });
  
  const turn = applyReviewGate(profile, rawTurn, editMessage);
  
  console.log('After edit:');
  console.log(`  Services: ${JSON.stringify(turn.draft.services)}`);
  console.log(`  Other facts: ${JSON.stringify(turn.draft.otherFacts)}\n`);
  
  // Check that:
  // 1. Price changed
  const priceChanged = turn.draft.services[0]?.price === '$60';
  console.log(priceChanged ? '✓ Price updated to $60' : '✗ Price not updated');
  
  // 2. New fact added
  const hasParking = turn.draft.otherFacts?.some(f => f.toLowerCase().includes('parking'));
  console.log(hasParking ? '✓ New fact (parking) added' : '✗ New fact not added');
  
  // 3. Old fact preserved
  const hasCancellation = turn.draft.otherFacts?.some(f => f.toLowerCase().includes('cancellation'));
  console.log(hasCancellation ? '✓ Existing fact (cancellation) preserved' : '✗ Existing fact lost');
  
  // 4. Hours preserved
  const hoursPreserved = turn.draft.hours === startProfile.hours;
  console.log(hoursPreserved ? '✓ Hours unchanged and preserved' : '✗ Hours lost');
  
  const allPassed = priceChanged && hasParking && hasCancellation && hoursPreserved;
  
  console.log('\n' + (allPassed ? '✓ EDIT PATH TEST PASSED' : '✗ EDIT PATH TEST FAILED'));
  
  return { passed: allPassed, tokens: rawTurn.usage?.total_tokens || 0 };
}

async function main() {
  const result = await testEdit();
  console.log(`\nTokens: ${result.tokens}`);
  console.log(`Cost: $${((result.tokens / 1000000) * 0.15).toFixed(4)}`);
  process.exit(result.passed ? 0 : 1);
}

main().catch(console.error);
