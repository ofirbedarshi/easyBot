import { strict as assert } from 'assert';
import { preserveFacts } from '../src/builder.js';

console.log('Testing fact preservation logic...\n');

// Test 1: Facts dropped without owner request should be restored
{
  const currentDraft = {
    name: 'Test Business',
    services: [
      { name: 'Service A', price: '$10', notes: null },
      { name: 'Service B', price: '$20', notes: 'with extras' }
    ],
    otherFacts: ['Delivery within 5 miles', 'Nut-free kitchen'],
    unknowns: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [
      { name: 'Service A', price: '$10', notes: null }
      // Service B missing - model forgot it
    ],
    otherFacts: ['Delivery within 5 miles'],
    // nut-free fact missing - model forgot it
    unknowns: []
  };

  const userMessage = 'Do you offer gift wrapping?'; // No change request

  const result = preserveFacts(newDraft, currentDraft, userMessage);

  assert.equal(result.services.length, 2, 'Should restore missing service');
  assert.equal(result.services[1].name, 'Service B');
  assert.equal(result.services[1].notes, 'with extras');
  assert.equal(result.otherFacts.length, 2, 'Should restore missing otherFact');
  assert.ok(result.otherFacts.includes('Nut-free kitchen'));
  
  console.log('✓ Test 1: Dropped facts restored');
}

// Test 2: Owner explicitly changes price - should NOT restore old value
{
  const currentDraft = {
    name: 'Test Business',
    services: [{ name: 'Service A', price: '$10', notes: null }],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [{ name: 'Service A', price: '$15', notes: null }],
    otherFacts: []
  };

  const userMessage = 'Actually, change the price to $15';

  const result = preserveFacts(newDraft, currentDraft, userMessage);

  assert.equal(result.services[0].price, '$15', 'Should keep new price when owner requested change');
  
  console.log('✓ Test 2: Explicit change preserved');
}

// Test 3: Owner explicitly deletes a fact - should NOT restore
{
  const currentDraft = {
    name: 'Test Business',
    services: [
      { name: 'Service A', price: '$10', notes: null },
      { name: 'Service B', price: '$20', notes: null }
    ],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [{ name: 'Service A', price: '$10', notes: null }],
    otherFacts: []
  };

  const userMessage = 'Remove Service B, we don\'t offer that anymore';

  const result = preserveFacts(newDraft, currentDraft, userMessage);

  assert.equal(result.services.length, 1, 'Should not restore explicitly deleted service');
  assert.equal(result.services[0].name, 'Service A');
  
  console.log('✓ Test 3: Explicit deletion preserved');
}

// Test 4: New facts added - should keep both old and new
{
  const currentDraft = {
    name: 'Test Business',
    services: [],
    otherFacts: ['Delivery within 5 miles'],
    unknowns: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [],
    otherFacts: ['Delivery within 5 miles', 'Parking available'], // Added new fact
    unknowns: []
  };

  const userMessage = 'We also have parking';

  const result = preserveFacts(newDraft, currentDraft, userMessage);

  assert.equal(result.otherFacts.length, 2, 'Should keep both facts');
  assert.ok(result.otherFacts.includes('Delivery within 5 miles'));
  assert.ok(result.otherFacts.includes('Parking available'));
  
  console.log('✓ Test 4: New facts added correctly');
}

// Test 5: Service notes dropped - should restore
{
  const currentDraft = {
    name: 'Test Business',
    services: [
      { name: 'Custom cakes', price: '$65', notes: 'start at, require 5 days notice' }
    ],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [
      { name: 'Custom cakes', price: '$65', notes: null } // Notes dropped
    ],
    otherFacts: []
  };

  const userMessage = 'What else can you tell me?'; // No change request

  const result = preserveFacts(newDraft, currentDraft, userMessage);

  assert.equal(result.services[0].notes, 'start at, require 5 days notice', 'Should restore dropped notes');
  
  console.log('✓ Test 5: Dropped service notes restored');
}

// Test 6: No previous draft - should return draft as-is
{
  const newDraft = {
    name: 'Test Business',
    services: [{ name: 'Service A', price: '$10', notes: null }],
    otherFacts: ['Fact 1']
  };

  const result = preserveFacts(newDraft, null, 'Tell me about your business');

  assert.deepEqual(result, newDraft, 'Should return draft unchanged when no previous draft');
  
  console.log('✓ Test 6: No previous draft handled');
}

// Test 7: Text fields dropped - should restore
{
  const currentDraft = {
    name: 'Test Business',
    whatWeDo: 'We sell handmade crafts',
    hours: 'Mon-Fri 9am-5pm',
    services: [],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    whatWeDo: null, // Dropped
    hours: null, // Dropped
    services: [],
    otherFacts: []
  };

  const userMessage = 'Do you offer gift cards?'; // No change request

  const result = preserveFacts(newDraft, currentDraft, userMessage);

  assert.equal(result.whatWeDo, 'We sell handmade crafts', 'Should restore whatWeDo');
  assert.equal(result.hours, 'Mon-Fri 9am-5pm', 'Should restore hours');
  
  console.log('✓ Test 7: Dropped text fields restored');
}

console.log('\n✓ All fact preservation tests passed!');
