import { strict as assert } from 'assert';
import { preserveFacts, applyFactOps, dropResolved } from '../src/builder.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const svc = (name, price, notes = null) => ({ name, price, notes });

test('price edit reported in ownerEdits replaces, no duplicate', () => {
  const r = preserveFacts(
    { services: [svc('Item A', '$60')] },
    { services: [svc('Item A', '$50')] },
    [{ field: 'services', item: 'Item A', action: 'change' }]
  );
  assert.deepEqual(r.services, [svc('Item A', '$60')]);
});

test('FAQ answer edit reported replaces, no duplicate', () => {
  const q = 'Question one?';
  const r = preserveFacts(
    { commonQuestions: [{ question: q, answer: 'new' }] },
    { commonQuestions: [{ question: q, answer: 'old' }] },
    [{ field: 'commonQuestions', item: q, action: 'change' }]
  );
  assert.deepEqual(r.commonQuestions, [{ question: q, answer: 'new' }]);
});

test('unreported price shortening keeps previous price', () => {
  const r = preserveFacts(
    { services: [svc('Item A', '$10')] },
    { services: [svc('Item A', 'from $10, condition X')] },
    []
  );
  assert.deepEqual(r.services, [svc('Item A', 'from $10, condition X')]);
});

test('unreported rewording of notes/answer keeps original, no duplicate', () => {
  const r = preserveFacts(
    { services: [svc('Item A', '$1', 'reworded')], commonQuestions: [{ question: 'Q?', answer: 'short' }] },
    { services: [svc('Item A', '$1', 'original')], commonQuestions: [{ question: 'Q?', answer: 'full answer' }] },
    []
  );
  assert.deepEqual(r.services, [svc('Item A', '$1', 'original')]);
  assert.deepEqual(r.commonQuestions, [{ question: 'Q?', answer: 'full answer' }]);
});

test('dropped service, FAQ, and text fields are restored', () => {
  const r = preserveFacts(
    { services: [svc('Item A', '$1')], commonQuestions: [], whatWeDo: null, hours: 'shortened' },
    {
      services: [svc('Item A', '$1'), svc('Item B', '$2', 'n')],
      commonQuestions: [{ question: 'Q?', answer: 'A' }],
      whatWeDo: 'desc',
      hours: 'full hours with exception',
    },
    []
  );
  assert.equal(r.services.length, 2);
  assert.deepEqual(r.services[1], svc('Item B', '$2', 'n'));
  assert.equal(r.commonQuestions.length, 1);
  assert.equal(r.whatWeDo, 'desc');
  assert.equal(r.hours, 'full hours with exception');
});

test('restored list items keep their original position', () => {
  const r = preserveFacts(
    { services: [svc('Men\'s cut', '$30')] },
    {
      services: [
        svc('Women\'s cut', '$45'),
        svc('Men\'s cut', '$28'),
        svc('Blowout', '$35'),
      ],
    },
    [{ field: 'services', item: 'Men\'s cut', action: 'change' }]
  );
  assert.deepEqual(
    r.services.map((s) => s.name),
    ['Women\'s cut', 'Men\'s cut', 'Blowout']
  );
  assert.equal(r.services[0].price, '$45');
  assert.equal(r.services[1].price, '$30');
});

test('sameKey folds curly apostrophes so a reported edit still applies', () => {
  const r = preserveFacts(
    { services: [svc('Men\'s cut', '$30')] },
    { services: [svc('Women\'s cut', '$45'), svc('men\u2019s cut', '$28')] },
    [{ field: 'services', item: 'Men\'s cut', action: 'change' }]
  );
  assert.equal(r.services.find((s) => /^men/i.test(s.name)).price, '$30');
  assert.equal(r.services.find((s) => /women/i.test(s.name)).price, '$45');
});

test('overlapping service names: editing one does not mark the other', () => {
  const r = preserveFacts(
    { services: [svc('Men\'s cut', '$30')] },
    { services: [svc('Women\'s cut', '$45'), svc('Men\'s cut', '$28')] },
    [{ field: 'services', item: 'Men\'s cut', action: 'change' }]
  );
  assert.equal(r.services.find((s) => s.name === 'Women\'s cut').price, '$45');
  assert.equal(r.services.find((s) => s.name === 'Men\'s cut').price, '$30');
});

test('locationOrArea is kept when a service correction sends a shorter area', () => {
  const r = preserveFacts(
    {
      services: [svc('Plumbing', '$95')],
      locationOrArea: 'Dayton and Kettering',
    },
    {
      services: [svc('Plumbing', '$90'), svc('Electrical', '$110')],
      locationOrArea: 'Dayton and Kettering. Does not serve Springfield.',
    },
    [{ field: 'services', item: 'Plumbing', action: 'change' }]
  );
  assert.match(r.locationOrArea, /Springfield/);
  assert.equal(r.services.find((s) => s.name === 'Electrical').price, '$110');
});

test('text-field rewrite in this turn\'s delta is kept without ownerEdits', () => {
  const prev = { locationOrArea: 'City, Region', hours: 'Weekdays 9-5' };
  const incoming = {
    locationOrArea: 'City and Town; does not serve Place A or Place B',
    hours: 'Weekdays 9-5, Saturday 10-2',
  };
  const r = preserveFacts(incoming, prev, [], incoming);
  assert.equal(r.locationOrArea, incoming.locationOrArea);
  assert.equal(r.hours, incoming.hours);
});

test('text-field shortening in the delta is reverted without an owner edit', () => {
  const prev = {
    locationOrArea: 'City, Region. Serves Town. Does not serve Place A.',
    whatWeDo: 'Full description with a condition',
  };
  const incoming = { locationOrArea: 'City, Region', whatWeDo: 'Full description' };
  const r = preserveFacts(incoming, prev, [], incoming);
  assert.equal(r.locationOrArea, prev.locationOrArea);
  assert.equal(r.whatWeDo, prev.whatWeDo);
});

test('text-field shortening applies when ownerEdits names the field', () => {
  const prev = { locationOrArea: 'City, Region. Serves Town. Does not serve Place A.' };
  const incoming = { locationOrArea: 'City, Region' };
  const r = preserveFacts(incoming, prev, [{ field: 'locationOrArea', item: null, action: 'change' }], incoming);
  assert.equal(r.locationOrArea, 'City, Region');
});

test('unreported additive change (e.g. resolving an unknown) is kept', () => {
  const r = preserveFacts(
    { hours: 'Weekdays 8-6, Saturday 9-1', unknowns: [], services: [svc('Item A', '$5, per unit')] },
    { hours: 'Weekdays 8-6', unknowns: ['Weekend hours undecided'], services: [svc('Item A', '$5')] },
    []
  );
  assert.equal(r.hours, 'Weekdays 8-6, Saturday 9-1');
  assert.equal(r.services[0].price, '$5, per unit');
  assert.deepEqual(r.unknowns, []);
});

test('reported removal stays removed; reported text change kept', () => {
  const r = preserveFacts(
    { services: [svc('Item A', '$1')], hours: 'new hours' },
    { services: [svc('Item A', '$1'), svc('Item B', '$2')], hours: 'old hours' },
    [
      { field: 'services', item: 'Item B', action: 'remove' },
      { field: 'hours', item: null, action: 'change' },
    ]
  );
  assert.deepEqual(r.services, [svc('Item A', '$1')]);
  assert.equal(r.hours, 'new hours');
});

test('resolved unknown is not restored', () => {
  const r = preserveFacts(
    { unknowns: [], services: [svc('Item A', '$5 per unit')] },
    { unknowns: ['Whether price is per unit'], services: [svc('Item A', '$5')] },
    [{ field: 'services', item: 'Item A', action: 'change' }]
  );
  assert.deepEqual(r.unknowns, []);
});

test('resolvedUnknowns removes answered unknown even if model re-emits it', () => {
  const stored = ['Topic X undecided', 'Topic Y undecided'];
  assert.deepEqual(dropResolved([...stored], stored, [0]), ['Topic Y undecided']);
  assert.deepEqual(dropResolved([...stored], stored, [9, 'x']), stored);
});

test('newFacts append; already-stored fact not duplicated', () => {
  assert.deepEqual(applyFactOps(['Fact 1'], ['Fact 2', 'fact 1'], []), ['Fact 1', 'Fact 2']);
});

test('factEdits text replaces stored fact by index, no duplicate', () => {
  assert.deepEqual(
    applyFactOps(['Fact 1', 'Fact 2'], [], [{ index: 1, text: 'Fact 2 corrected' }]),
    ['Fact 1', 'Fact 2 corrected']
  );
});

test('factEdits null text removes by index', () => {
  assert.deepEqual(applyFactOps(['Fact 1', 'Fact 2'], [], [{ index: 0, text: null }]), ['Fact 2']);
});

test('no fact changes keeps stored list intact; invalid edits ignored', () => {
  assert.deepEqual(applyFactOps(['Fact 1'], undefined, undefined), ['Fact 1']);
  assert.deepEqual(
    applyFactOps(['Fact 1'], [], [{ index: 5, text: null }, { index: 0, text: '' }, { index: 'x' }]),
    ['Fact 1']
  );
});

test('intake ownerEdits remove drops one item', () => {
  const prev = { informationToCollect: ['name', 'phone'] };
  const removed = preserveFacts(
    { informationToCollect: ['name', 'phone'] },
    prev,
    [{ field: 'informationToCollect', item: 'phone', action: 'remove' }]
  );
  assert.deepEqual(removed.informationToCollect, ['name']);
});

test('no previous draft returns draft as-is', () => {
  const d = { services: [svc('Item A', '$1')] };
  assert.deepEqual(preserveFacts(d, null, []), d);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
