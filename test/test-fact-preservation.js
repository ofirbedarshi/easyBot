import { strict as assert } from 'assert';
import { preserveFacts, applyFactOps } from '../src/builder.js';

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

test('factOps: add appends, duplicate add ignored', () => {
  assert.deepEqual(
    applyFactOps(['Fact 1'], [{ op: 'add', text: 'Fact 2' }, { op: 'add', text: 'fact 1' }]),
    ['Fact 1', 'Fact 2']
  );
});

test('factOps: change replaces by index, no duplicate', () => {
  assert.deepEqual(
    applyFactOps(['Fact 1', 'Fact 2'], [{ op: 'change', index: 1, text: 'Fact 2 corrected' }]),
    ['Fact 1', 'Fact 2 corrected']
  );
});

test('factOps: remove by index', () => {
  assert.deepEqual(applyFactOps(['Fact 1', 'Fact 2'], [{ op: 'remove', index: 0 }]), ['Fact 2']);
});

test('factOps: no ops keeps list intact; invalid ops ignored', () => {
  assert.deepEqual(applyFactOps(['Fact 1'], undefined), ['Fact 1']);
  assert.deepEqual(
    applyFactOps(['Fact 1'], [{ op: 'remove', index: 5 }, { op: 'change', index: 0, text: '' }, { op: 'x' }]),
    ['Fact 1']
  );
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
