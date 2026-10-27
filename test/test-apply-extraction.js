import { strict as assert } from 'assert';
import {
  applyBuilderModelOutput,
  applyDraftDelta,
  applyExtraction,
} from '../src/applyExtraction.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const svc = (name, price, notes = null) => ({ name, price, notes });

function stored(overrides = {}) {
  return {
    name: 'Ofir garage',
    whatWeDo: 'Garage',
    services: [svc('Oil change', '200 ILS')],
    hours: 'Mon–Fri 8–18',
    locationOrArea: 'Haifa',
    commonQuestions: [{ question: 'Do you work on trucks?', answer: 'Yes.' }],
    informationToCollect: ['name', 'phone'],
    unknowns: ['Whether we do motorcycles'],
    otherFacts: ['We only work on cars'],
    tone: 'warm',
    priceDisclosure: 'relevant',
    openingMessage: 'Hi there',
    askedTopics: ['commonQuestions', 'informationToCollect'],
    ...overrides,
  };
}

test('no-change / all-null delta keeps every stored field', () => {
  const prev = stored();
  const next = applyExtraction(prev, {
    draft: {
      name: null,
      whatWeDo: null,
      hours: null,
      locationOrArea: null,
      services: [],
      commonQuestions: [],
      informationToCollect: null,
      unknowns: [],
      tone: null,
      priceDisclosure: null,
      openingMessage: null,
      openingMessageReset: false,
    },
    newFacts: [],
    ownerEdits: [],
    factEdits: [],
    resolvedUnknowns: [],
  });
  assert.equal(next.name, prev.name);
  assert.equal(next.whatWeDo, prev.whatWeDo);
  assert.equal(next.hours, prev.hours);
  assert.equal(next.locationOrArea, prev.locationOrArea);
  assert.deepEqual(next.services, prev.services);
  assert.deepEqual(next.commonQuestions, prev.commonQuestions);
  assert.deepEqual(next.informationToCollect, prev.informationToCollect);
  assert.deepEqual(next.unknowns, prev.unknowns);
  assert.deepEqual(next.otherFacts, prev.otherFacts);
  assert.equal(next.tone, prev.tone);
  assert.equal(next.openingMessage, prev.openingMessage);
});

test('missing otherFacts on stored draft falls back to live', () => {
  const live = { otherFacts: ['Keep me'] };
  const next = applyExtraction(
    { name: 'A', services: [] },
    { draft: {}, newFacts: [], factEdits: [] },
    { live }
  );
  assert.deepEqual(next.otherFacts, ['Keep me']);
});

test('intake: omitted field keeps the list', () => {
  const next = applyExtraction(stored(), { draft: { informationToCollect: null } });
  assert.deepEqual(next.informationToCollect, ['name', 'phone']);
});

test('intake: shorter list without ownerEdits keeps omitted items', () => {
  const next = applyExtraction(stored(), {
    draft: { informationToCollect: ['name'] },
    ownerEdits: [],
  });
  assert.deepEqual(next.informationToCollect, ['name', 'phone']);
});

test('intake: ownerEdits remove drops one item', () => {
  const next = applyExtraction(stored(), {
    draft: { informationToCollect: ['name'] },
    ownerEdits: [{ field: 'informationToCollect', item: 'phone', action: 'remove' }],
  });
  assert.deepEqual(next.informationToCollect, ['name']);
});

test('intake: ownerEdits remove works when the field is omitted', () => {
  const next = applyExtraction(stored(), {
    draft: { informationToCollect: null },
    ownerEdits: [{ field: 'informationToCollect', item: 'phone', action: 'remove' }],
  });
  assert.deepEqual(next.informationToCollect, ['name']);
});

test('intake: [] means collect nothing', () => {
  const next = applyExtraction(stored(), { draft: { informationToCollect: [] } });
  assert.deepEqual(next.informationToCollect, []);
});

test('intake: add unions onto stored', () => {
  const next = applyExtraction(stored(), {
    draft: { informationToCollect: ['car model'] },
  });
  assert.deepEqual(next.informationToCollect, ['name', 'phone', 'car model']);
});

test('applyDraftDelta write-phase still unions intake without dropping', () => {
  assert.deepEqual(
    applyDraftDelta({ informationToCollect: ['name'] }, stored()).informationToCollect,
    ['name', 'phone']
  );
});

test('services: empty array keeps; upsert adds; ownerEdits remove drops', () => {
  const prev = stored();
  assert.deepEqual(applyExtraction(prev, { draft: { services: [] } }).services, prev.services);
  const added = applyExtraction(prev, {
    draft: { services: [svc('Brake pads', '350 ILS')] },
  });
  assert.equal(added.services.length, 2);
  const removed = applyExtraction(prev, {
    draft: { services: [] },
    ownerEdits: [{ field: 'services', item: 'Oil change', action: 'remove' }],
  });
  assert.deepEqual(removed.services, []);
});

test('FAQ: ownerEdits remove drops; omit keeps', () => {
  const prev = stored();
  const kept = applyExtraction(prev, { draft: { commonQuestions: [] } });
  assert.equal(kept.commonQuestions.length, 1);
  const removed = applyExtraction(prev, {
    draft: { commonQuestions: [] },
    ownerEdits: [
      { field: 'commonQuestions', item: 'Do you work on trucks?', action: 'remove' },
    ],
  });
  assert.deepEqual(removed.commonQuestions, []);
});

test('text field omit keeps; ownerEdits remove clears', () => {
  const prev = stored();
  assert.equal(applyExtraction(prev, { draft: { hours: null } }).hours, prev.hours);
  const cleared = applyExtraction(prev, {
    draft: { hours: null },
    ownerEdits: [{ field: 'hours', item: null, action: 'remove' }],
  });
  assert.equal(cleared.hours, null);
});

test('openingMessageReset clears; omitted opening keeps', () => {
  const prev = stored();
  const kept = applyExtraction(prev, {
    draft: { openingMessage: null, openingMessageReset: false },
  });
  assert.equal(kept.openingMessage, 'Hi there');
  const reset = applyExtraction(prev, {
    draft: { openingMessage: null, openingMessageReset: true },
  });
  assert.equal(reset.openingMessage, null);
});

test('otherFacts: no ops keeps; newFacts adds; factEdits null removes', () => {
  const prev = stored();
  assert.deepEqual(applyExtraction(prev, { draft: {} }).otherFacts, prev.otherFacts);
  const added = applyExtraction(prev, { draft: {}, newFacts: ['Cash only'] });
  assert.deepEqual(added.otherFacts, ['We only work on cars', 'Cash only']);
  const removed = applyExtraction(prev, {
    draft: {},
    factEdits: [{ index: 0, text: null }],
  });
  assert.deepEqual(removed.otherFacts, []);
});

test('unknowns: append; resolvedUnknowns removes', () => {
  const prev = stored();
  const added = applyExtraction(prev, { draft: { unknowns: ['Weekend hours'] } });
  assert.deepEqual(added.unknowns, ['Whether we do motorcycles', 'Weekend hours']);
  const dropped = applyExtraction(prev, { draft: {}, resolvedUnknowns: [0] });
  assert.deepEqual(dropped.unknowns, []);
});

test('applyBuilderModelOutput is applyExtraction', () => {
  const prev = stored();
  const a = applyBuilderModelOutput(
    {
      draft: { informationToCollect: ['name'] },
      ownerEdits: [{ field: 'informationToCollect', item: 'phone', action: 'remove' }],
    },
    prev
  );
  assert.deepEqual(a.informationToCollect, ['name']);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
