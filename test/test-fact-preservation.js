import { strict as assert } from 'assert';
import { preserveFacts } from '../src/builder.js';

console.log('Testing fact preservation logic with ownerEdits...\n');

// Test 1: Natural price edit without change keywords -> replaced, no duplicate
{
  const currentDraft = {
    name: 'Test Business',
    services: [
      { name: 'Wash', price: '$50', notes: null }
    ],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [
      { name: 'Wash', price: '$60', notes: null }
    ],
    otherFacts: []
  };

  // Model reports owner edited the service
  const ownerEdits = [
    { field: 'services', item: 'Wash', action: 'change' }
  ];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.services.length, 1, 'Should have exactly one service, not duplicate');
  assert.equal(result.services[0].name, 'Wash');
  assert.equal(result.services[0].price, '$60', 'Should keep new price');
  
  console.log('✓ Test 1: Natural price edit without keywords -> replaced, no duplicate');
}

// Test 2: FAQ answer update -> replaced, no duplicate
{
  const currentDraft = {
    name: 'Test Business',
    services: [],
    commonQuestions: [
      { question: 'Do you offer refunds?', answer: 'Yes, within 30 days' }
    ],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [],
    commonQuestions: [
      { question: 'Do you offer refunds?', answer: 'Yes, within 14 days with receipt' }
    ],
    otherFacts: []
  };

  const ownerEdits = [
    { field: 'commonQuestions', item: 'refunds', action: 'change' }
  ];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.commonQuestions.length, 1, 'Should have exactly one FAQ, not duplicate');
  assert.equal(result.commonQuestions[0].answer, 'Yes, within 14 days with receipt', 'Should keep new answer');
  
  console.log('✓ Test 2: FAQ answer update -> replaced, no duplicate');
}

// Test 3: Model rewords a service without owner request -> no duplicate, original kept
{
  const currentDraft = {
    name: 'Test Business',
    services: [
      { name: 'Deep Clean', price: '$100', notes: 'includes wax' }
    ],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    services: [
      { name: 'Deep Clean', price: '$100', notes: 'with wax included' }
    ],
    otherFacts: []
  };

  // No ownerEdits - model just rephrased on its own
  const ownerEdits = [];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.services.length, 1, 'Should have exactly one service, not duplicate');
  assert.equal(result.services[0].notes, 'includes wax', 'Should keep original wording when no edit requested');
  
  console.log('✓ Test 3: Model rewords without owner request -> original kept, no duplicate');
}

// Test 4: Real fact drop without owner request -> restored
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

  // No ownerEdits - these are unintended drops
  const ownerEdits = [];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.services.length, 2, 'Should restore missing service');
  assert.equal(result.services[1].name, 'Service B');
  assert.equal(result.services[1].notes, 'with extras');
  assert.equal(result.otherFacts.length, 2, 'Should restore missing otherFact');
  assert.ok(result.otherFacts.includes('Nut-free kitchen'));
  
  console.log('✓ Test 4: Real fact drops without owner request -> restored');
}

// Test 5: Explicit removal in ownerEdits -> stays removed
{
  const currentDraft = {
    name: 'Test Business',
    services: [
      { name: 'Service A', price: '$10', notes: null },
      { name: 'Service B', price: '$20', notes: null }
    ],
    otherFacts: ['Nut-free kitchen']
  };

  const newDraft = {
    name: 'Test Business',
    services: [
      { name: 'Service A', price: '$10', notes: null }
    ],
    otherFacts: []
  };

  const ownerEdits = [
    { field: 'services', item: 'Service B', action: 'remove' },
    { field: 'otherFacts', item: 'nut-free', action: 'remove' }
  ];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.services.length, 1, 'Should not restore explicitly removed service');
  assert.equal(result.services[0].name, 'Service A');
  assert.equal(result.otherFacts.length, 0, 'Should not restore explicitly removed fact');
  
  console.log('✓ Test 5: Explicit removal in ownerEdits -> stays removed');
}

// Test 6: New fact addition -> appended
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
    otherFacts: ['Delivery within 5 miles', 'Parking available'],
    unknowns: []
  };

  const ownerEdits = [
    { field: 'otherFacts', item: 'parking', action: 'add' }
  ];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.otherFacts.length, 2, 'Should have both facts');
  assert.ok(result.otherFacts.includes('Delivery within 5 miles'));
  assert.ok(result.otherFacts.includes('Parking available'));
  
  console.log('✓ Test 6: New fact addition -> appended');
}

// Test 7: Service notes dropped without edit -> restored
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
      { name: 'Custom cakes', price: '$65', notes: null }
    ],
    otherFacts: []
  };

  const ownerEdits = [];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.services[0].notes, 'start at, require 5 days notice', 'Should restore dropped notes');
  
  console.log('✓ Test 7: Service notes dropped without edit -> restored');
}

// Test 8: Text fields dropped without edit -> restored
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
    whatWeDo: null,
    hours: null,
    services: [],
    otherFacts: []
  };

  const ownerEdits = [];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.whatWeDo, 'We sell handmade crafts', 'Should restore whatWeDo');
  assert.equal(result.hours, 'Mon-Fri 9am-5pm', 'Should restore hours');
  
  console.log('✓ Test 8: Text fields dropped without edit -> restored');
}

// Test 9: Text field explicitly changed -> not restored
{
  const currentDraft = {
    name: 'Test Business',
    hours: 'Mon-Fri 9am-5pm',
    services: [],
    otherFacts: []
  };

  const newDraft = {
    name: 'Test Business',
    hours: 'Mon-Fri 9am-6pm',
    services: [],
    otherFacts: []
  };

  const ownerEdits = [
    { field: 'hours', item: null, action: 'change' }
  ];

  const result = preserveFacts(newDraft, currentDraft, ownerEdits);

  assert.equal(result.hours, 'Mon-Fri 9am-6pm', 'Should keep new hours when explicitly changed');
  
  console.log('✓ Test 9: Text field explicitly changed -> not restored');
}

// Test 10: No previous draft -> return as-is
{
  const newDraft = {
    name: 'Test Business',
    services: [{ name: 'Service A', price: '$10', notes: null }],
    otherFacts: ['Fact 1']
  };

  const result = preserveFacts(newDraft, null, []);

  assert.deepEqual(result, newDraft, 'Should return draft unchanged when no previous draft');
  
  console.log('✓ Test 10: No previous draft -> return as-is');
}

console.log('\n✓ All fact preservation tests passed!');
