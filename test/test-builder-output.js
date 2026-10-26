import { strict as assert } from 'assert';
import {
  adjustChatParamsOnError,
  applyBuilderModelOutput,
  applyDraftDelta,
  applyFactOps,
  builderChatParams,
  preserveFacts,
} from '../src/builder.js';
import {
  BUILDER_DRAFT_KEYS,
  BUILDER_RESPONSE_SCHEMA,
  BUILDER_TOP_LEVEL_KEYS,
} from '../src/builderSchema.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const svc = (name, price, notes = null) => ({ name, price, notes });

test('schema requires top-level newFacts and all draft keys', () => {
  assert.ok(BUILDER_TOP_LEVEL_KEYS.includes('newFacts'));
  assert.ok(BUILDER_TOP_LEVEL_KEYS.includes('asksQuestion'));
  assert.ok(BUILDER_TOP_LEVEL_KEYS.includes('draft'));
  assert.ok(!BUILDER_DRAFT_KEYS.includes('newFacts'));
  assert.ok(!BUILDER_DRAFT_KEYS.includes('otherFacts'));
  assert.ok(!BUILDER_DRAFT_KEYS.includes('askedTopics'));
  const root = BUILDER_RESPONSE_SCHEMA.schema;
  assert.equal(root.additionalProperties, false);
  assert.deepEqual([...root.required].sort(), [...Object.keys(root.properties)].sort());
  const draft = root.properties.draft;
  assert.equal(draft.additionalProperties, false);
  assert.deepEqual([...draft.required].sort(), [...Object.keys(draft.properties)].sort());
});

test('applyDraftDelta: null / omitted scalars keep previous values', () => {
  const prev = { name: 'Rosa', hours: 'Tue-Sun', tone: 'warm' };
  const next = applyDraftDelta(
    { name: null, hours: null, whatWeDo: null, tone: null, assistantNameReset: false },
    prev
  );
  assert.equal(next.name, 'Rosa');
  assert.equal(next.hours, 'Tue-Sun');
  assert.equal(next.tone, 'warm');
});

test('applyDraftDelta: provided scalars overwrite', () => {
  const next = applyDraftDelta({ name: 'Rosa', hours: 'Tue-Sun 7-3' }, { name: 'Old', hours: null });
  assert.equal(next.name, 'Rosa');
  assert.equal(next.hours, 'Tue-Sun 7-3');
});

test('applyDraftDelta: informationToCollect null keeps; [] settles empty', () => {
  const settled = ['name', 'phone'];
  assert.deepEqual(
    applyDraftDelta({ informationToCollect: null }, { informationToCollect: settled })
      .informationToCollect,
    settled
  );
  assert.deepEqual(
    applyDraftDelta({ informationToCollect: [] }, { informationToCollect: settled })
      .informationToCollect,
    []
  );
});

test('applyDraftDelta: partial informationToCollect restores omitted items', () => {
  const settled = ['name', 'phone', 'preferred time'];
  assert.deepEqual(
    applyDraftDelta({ informationToCollect: ['name'] }, { informationToCollect: settled })
      .informationToCollect,
    settled
  );
  assert.deepEqual(
    applyDraftDelta({ informationToCollect: ['email'] }, { informationToCollect: settled })
      .informationToCollect,
    ['name', 'phone', 'preferred time', 'email']
  );
});

test('applyDraftDelta: empty services array keeps previous list', () => {
  const prev = { services: [svc('A', '$1'), svc('B', '$2')] };
  assert.deepEqual(applyDraftDelta({ services: [] }, prev).services, prev.services);
});

test('applyDraftDelta: one changed service upserts in place; siblings stay', () => {
  const prev = {
    services: [svc('Women\'s cut', '$45'), svc('Men\'s cut', '$28'), svc('Blowout', '$35')],
  };
  const next = applyDraftDelta({ services: [svc('Men\'s cut', '$30')] }, prev);
  assert.deepEqual(next.services, [
    svc('Women\'s cut', '$45'),
    svc('Men\'s cut', '$30'),
    svc('Blowout', '$35'),
  ]);
});

test('applyDraftDelta: unknowns append without dropping stored ones', () => {
  const next = applyDraftDelta(
    { unknowns: ['Weekend hours undecided'] },
    { unknowns: ['Refund policy undecided'] }
  );
  assert.deepEqual(next.unknowns, ['Refund policy undecided', 'Weekend hours undecided']);
});

test('delta output: only new service is merged; stored service kept', () => {
  const current = {
    services: [svc('Sourdough', '$9')],
    otherFacts: [],
    unknowns: [],
  };
  const out = applyBuilderModelOutput(
    {
      draft: { services: [svc('Croissant', '$4.50')], name: null },
      newFacts: [],
      ownerEdits: [],
      factEdits: [],
      resolvedUnknowns: [],
    },
    current
  );
  assert.equal(out.services.length, 2);
  assert.deepEqual(
    out.services.find((s) => s.name === 'Sourdough'),
    svc('Sourdough', '$9')
  );
  assert.deepEqual(
    out.services.find((s) => s.name === 'Croissant'),
    svc('Croissant', '$4.50')
  );
});

test('delta output: ownerEdits still change a stored service price', () => {
  const current = { services: [svc('Sourdough', '$9')], otherFacts: [], unknowns: [] };
  const out = applyBuilderModelOutput(
    {
      draft: { services: [svc('Sourdough', '$10')] },
      newFacts: [],
      ownerEdits: [{ field: 'services', item: 'Sourdough', action: 'change' }],
    },
    current
  );
  assert.deepEqual(out.services, [svc('Sourdough', '$10')]);
});

test('partial services delta applies the new price even without ownerEdits', () => {
  const current = {
    services: [svc('Women\'s cut', '$45'), svc('Men\'s cut', '$28'), svc('Blowout', '$35')],
    otherFacts: [],
    unknowns: [],
  };
  const out = applyBuilderModelOutput(
    {
      draft: { services: [svc('Men\'s cut', '$30')] },
      newFacts: [],
      ownerEdits: [],
    },
    current
  );
  assert.equal(out.services.find((s) => s.name === 'Men\'s cut').price, '$30');
  assert.equal(out.services.find((s) => s.name === 'Women\'s cut').price, '$45');
  assert.equal(out.services.length, 3);
});

test('correction of one overlapping service name keeps siblings and order', () => {
  const current = {
    services: [
      svc('Women\'s cut', '$45'),
      svc('Men\'s cut', '$28'),
      svc('Kids\' cut (under 10)', '$25'),
      svc('Blowout', '$35'),
      svc('Long or thick hair extra', '$15'),
    ],
    locationOrArea: 'Columbus, Ohio. Does not serve Westerville.',
    otherFacts: [],
    unknowns: [],
    informationToCollect: ['name', 'phone', 'preferred time'],
  };
  const out = applyBuilderModelOutput(
    {
      draft: {
        services: [svc('Men\'s cut', '$30')],
        locationOrArea: 'Columbus, Ohio',
        informationToCollect: ['name'],
      },
      newFacts: ['The salon does not offer nail services.'],
      ownerEdits: [{ field: 'services', item: 'Men\'s cut', action: 'change' }],
    },
    current
  );
  assert.equal(out.services.length, 5);
  assert.deepEqual(
    out.services.map((s) => s.name),
    current.services.map((s) => s.name)
  );
  assert.equal(out.services.find((s) => s.name === 'Women\'s cut').price, '$45');
  assert.equal(out.services.find((s) => s.name === 'Men\'s cut').price, '$30');
  assert.ok(/westerville/i.test(out.locationOrArea));
  assert.deepEqual(out.informationToCollect, ['name', 'phone', 'preferred time']);
  assert.deepEqual(out.otherFacts, ['The salon does not offer nail services.']);
});

test('ownerEdits item null on services does not drop siblings', () => {
  const current = {
    services: [svc('Women\'s cut', '$45'), svc('Men\'s cut', '$28')],
    otherFacts: [],
    unknowns: [],
  };
  const out = applyBuilderModelOutput(
    {
      draft: { services: [svc('Men\'s cut', '$30')] },
      newFacts: [],
      ownerEdits: [{ field: 'services', item: null, action: 'change' }],
    },
    current
  );
  assert.equal(out.services.length, 2);
  assert.equal(out.services.find((s) => s.name === 'Women\'s cut').price, '$45');
  assert.ok(out.services.find((s) => s.name === 'Men\'s cut'));
});

test('ownerEdits abbreviation applies only when it matches one stored item', () => {
  const current = {
    services: [svc('Women\'s cut', '$45'), svc('Men\'s cut', '$28'), svc('Blowout', '$35')],
    otherFacts: [],
    unknowns: [],
  };
  const ambiguous = applyBuilderModelOutput(
    {
      draft: { services: [svc('Men\'s cut', '$30')] },
      newFacts: [],
      ownerEdits: [{ field: 'services', item: 'cut', action: 'change' }],
    },
    current
  );
  assert.equal(ambiguous.services.length, 3);
  assert.equal(ambiguous.services.find((s) => s.name === 'Women\'s cut').price, '$45');
  assert.ok(ambiguous.services.find((s) => s.name === 'Men\'s cut'));

  const unique = applyBuilderModelOutput(
    {
      draft: { services: [svc('Blowout', '$40')] },
      newFacts: [],
      ownerEdits: [{ field: 'services', item: 'blow', action: 'change' }],
    },
    current
  );
  assert.equal(unique.services.find((s) => s.name === 'Blowout').price, '$40');
  assert.equal(unique.services.find((s) => s.name === 'Women\'s cut').price, '$45');
});

test('delta output: top-level newFacts append; missing key is none', () => {
  const current = { otherFacts: ['Already stored'], unknowns: [], services: [] };
  const added = applyBuilderModelOutput(
    { draft: {}, newFacts: ['Nut-free kitchen', 'already stored'] },
    current
  );
  assert.deepEqual(added.otherFacts, ['Already stored', 'Nut-free kitchen']);
  const empty = applyBuilderModelOutput({ draft: {} }, current);
  assert.deepEqual(empty.otherFacts, ['Already stored']);
});

test('delta output: factEdits and resolvedUnknowns still apply', () => {
  const current = {
    otherFacts: ['Old policy', 'Keep me'],
    unknowns: ['Refund policy undecided', 'Weekend hours undecided'],
    services: [],
  };
  const out = applyBuilderModelOutput(
    {
      draft: { unknowns: [] },
      newFacts: [],
      factEdits: [{ index: 0, text: null }],
      resolvedUnknowns: [0],
    },
    current
  );
  assert.deepEqual(out.otherFacts, ['Keep me']);
  assert.deepEqual(out.unknowns, ['Weekend hours undecided']);
});

test('delta output: identity reset flag clears assistantName', () => {
  const current = { assistantName: 'Maya', openingMessage: 'Hi', services: [], otherFacts: [] };
  const out = applyBuilderModelOutput(
    {
      draft: { assistantName: null, assistantNameReset: true, openingMessage: null },
      newFacts: [],
    },
    current
  );
  assert.equal(out.assistantName, null);
  assert.equal(out.openingMessage, 'Hi');
});

test('legacy output still reads draft.newFacts, not top-level', () => {
  const current = { otherFacts: [], unknowns: [], services: [] };
  const out = applyBuilderModelOutput(
    {
      draft: { newFacts: ['Deliver within 3 miles'] },
      newFacts: ['should be ignored in legacy'],
    },
    current,
    { mode: 'legacy' }
  );
  assert.deepEqual(out.otherFacts, ['Deliver within 3 miles']);
});

test('chat params start with temperature; drop it and try lowest effort on 400', () => {
  const start = builderChatParams({
    model: 'm',
    messages: [],
    response_format: { type: 'json_object' },
  });
  assert.equal(start.temperature, 0.4);
  const next = adjustChatParamsOnError(start, { message: "Unsupported parameter: 'temperature'" });
  assert.ok(next);
  assert.equal(next.temperature, undefined);
  assert.equal(next.reasoning_effort, 'none');
  assert.equal(next.max_completion_tokens, 4000);
  const again = adjustChatParamsOnError(next, { message: "Unsupported value: 'none' for 'reasoning_effort'" });
  assert.equal(again.reasoning_effort, 'minimal');
  const low = adjustChatParamsOnError(again, { error: { message: 'reasoning_effort must be low' } });
  assert.equal(low.reasoning_effort, 'low');
  assert.equal(adjustChatParamsOnError(start, { message: 'insufficient_quota' }), null);
});

test('preserveFacts / applyFactOps still exported for existing tests', () => {
  const r = preserveFacts(
    { services: [svc('A', '$1')] },
    { services: [svc('A', '$1'), svc('B', '$2')] },
    []
  );
  assert.equal(r.services.length, 2);
  assert.deepEqual(applyFactOps(['Fact 1'], ['Fact 2'], []), ['Fact 1', 'Fact 2']);
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
