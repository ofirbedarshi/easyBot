/**
 * Test: Natural edit phrased without change keywords
 * 
 * Owner: "the wash is $60 now"
 * Expected: Service updated (not duplicated), new price stored
 */
import dotenv from 'dotenv';
import { runBuilderTurn, openingMessage } from '../src/builder.js';
import { emptyProfile, mergeDraft } from '../src/profile.js';

dotenv.config();

console.log('Testing natural price edit without change keywords...\n');

async function testNaturalEdit() {
  let profile = emptyProfile();
  let buildHistory = [];
  
  const opening = openingMessage();
  buildHistory.push({ role: 'assistant', content: opening.message, nav: null });
  
  // Turn 1: Initial business description
  console.log('Turn 1: Owner describes business with service');
  const userMessage1 = 'I run a car wash. We offer a basic wash for $50.';
  
  const turn1 = await runBuilderTurn({
    buildHistory,
    profile,
    userMessage: userMessage1
  });
  
  buildHistory.push({ role: 'user', content: userMessage1 });
  buildHistory.push({ role: 'assistant', content: turn1.message, nav: turn1.nav });
  profile = mergeDraft(profile, turn1.draft);
  
  console.log('Draft after turn 1:');
  console.log('  Services:', JSON.stringify(profile.services, null, 2));
  console.log('  Model response:', turn1.message.substring(0, 100) + '...');
  console.log('  Usage:', turn1.usage);
  
  if (!profile.services || profile.services.length === 0) {
    console.error('✗ FAILED: No services extracted in turn 1');
    process.exit(1);
  }
  
  const service1 = profile.services.find(s => s.name && s.name.toLowerCase().includes('wash'));
  if (!service1 || !service1.price || !service1.price.includes('50')) {
    console.error('✗ FAILED: Initial wash service not correctly extracted');
    console.error('  Got services:', profile.services);
    process.exit(1);
  }
  
  console.log('✓ Turn 1 succeeded: wash service extracted with $50 price\n');
  
  // Turn 2: Natural price update without change keywords
  console.log('Turn 2: Owner updates price naturally');
  const userMessage2 = 'the wash is $60 now';
  
  const turn2 = await runBuilderTurn({
    buildHistory,
    profile,
    userMessage: userMessage2
  });
  
  buildHistory.push({ role: 'user', content: userMessage2 });
  buildHistory.push({ role: 'assistant', content: turn2.message, nav: turn2.nav });
  const draft2 = turn2.draft;
  
  console.log('Draft after turn 2:');
  console.log('  Services:', JSON.stringify(draft2.services, null, 2));
  console.log('  Model response:', turn2.message.substring(0, 100) + '...');
  console.log('  Usage:', turn2.usage);
  console.log('  Total tokens:', turn1.usage.total_tokens + turn2.usage.total_tokens);
  console.log('  Estimated cost:', ((turn1.usage.total_tokens + turn2.usage.total_tokens) * 0.00015 / 1000).toFixed(4), 'cents');
  
  // Check that:
  // 1. There's still only one wash service (no duplicate)
  // 2. The price is updated to $60
  const washServices = draft2.services.filter(s => 
    s.name && s.name.toLowerCase().includes('wash')
  );
  
  if (washServices.length !== 1) {
    console.error('✗ FAILED: Expected exactly 1 wash service, got', washServices.length);
    console.error('  Services:', draft2.services);
    process.exit(1);
  }
  
  if (!washServices[0].price || !washServices[0].price.includes('60')) {
    console.error('✗ FAILED: Price not updated to $60');
    console.error('  Got price:', washServices[0].price);
    process.exit(1);
  }
  
  console.log('✓ Turn 2 succeeded: price updated, no duplicate\n');
  profile = mergeDraft(profile, draft2);
  let tokens = turn1.usage.total_tokens + turn2.usage.total_tokens;

  const say = async (text) => {
    const t = await runBuilderTurn({ buildHistory, profile, userMessage: text });
    buildHistory.push({ role: 'user', content: text });
    buildHistory.push({ role: 'assistant', content: t.message, nav: t.nav });
    profile = mergeDraft(profile, t.draft);
    tokens += t.usage.total_tokens;
    return t;
  };

  console.log('Turn 3: Owner leaves weekend hours undecided');
  await say("We're open weekdays 8am-6pm. Not sure yet whether we'll open on weekends.");
  console.log('  Unknowns:', profile.unknowns, '| Hours:', profile.hours);
  if (!profile.unknowns.some((u) => /weekend/i.test(u))) {
    console.error('✗ FAILED: weekend unknown not recorded');
    process.exit(1);
  }

  console.log('Turn 4: Owner resolves it');
  await say("We'll be open Saturdays 9am-1pm too, closed Sundays.");
  console.log('  Unknowns:', profile.unknowns, '| Hours:', profile.hours, '| otherFacts:', profile.otherFacts);
  const stillUnknown = profile.unknowns.some((u) => /weekend|saturday|sunday/i.test(u));
  const services = profile.services.filter((s) => /wash/i.test(s.name));
  console.log('  Total tokens (4 turns):', tokens);
  if (stillUnknown) {
    console.error('✗ FAILED: resolved unknown came back');
    process.exit(1);
  }
  if (!/sat/i.test(profile.hours || '') && !profile.otherFacts.some((f) => /sat/i.test(f))) {
    console.error('✗ FAILED: Saturday hours not stored');
    process.exit(1);
  }
  if (services.length !== 1 || !services[0].price.includes('60')) {
    console.error('✗ FAILED: earlier price edit not kept', services);
    process.exit(1);
  }
  console.log('✓ Resolved unknown removed, earlier edit kept\n');
  console.log('✓ Natural edit test PASSED');
}

testNaturalEdit().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
