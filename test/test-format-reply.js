import { strict as assert } from 'assert';
import {
  OFF_PURPOSE_OWNER_REPLY,
  openingMessage,
} from '../src/builder.js';
import { REQUIRED_TOPICS } from '../src/builderTopics.js';
import { PARAGRAPH_MARK, PARAGRAPH_PROMPT_LINE, formatModelReply } from '../src/formatReply.js';
import { LEAD_INTRO, LEAD_THANKS_YES } from '../src/leadIntake.js';
import { defaultCustomerOpening } from '../src/profile.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('converts || marker to a blank line', () => {
  const dense =
    "I can answer customers' questions and collect their details for you today; calendar bookings and registrations aren't available yet, but more is coming soon ✨ || What would you like me to help with most: answering questions, collecting details, or both?";
  assert.equal(
    formatModelReply(dense),
    "I can answer customers' questions and collect their details for you today; calendar bookings and registrations aren't available yet, but more is coming soon ✨\n\nWhat would you like me to help with most: answering questions, collecting details, or both?"
  );
});

test('keeps real blank lines and collapses 3+ newlines to 2', () => {
  assert.equal(formatModelReply('First para.\n\nSecond para.'), 'First para.\n\nSecond para.');
  assert.equal(formatModelReply('A\n\n\n\nB'), 'A\n\nB');
  assert.equal(formatModelReply('A\n\n\nB\n\n\n\nC'), 'A\n\nB\n\nC');
});

test('trims, strips leftover markers, and never leaks ||', () => {
  assert.equal(formatModelReply('  hello || world  '), 'hello\n\nworld');
  assert.equal(formatModelReply('|| leading'), 'leading');
  assert.equal(formatModelReply('trailing ||'), 'trailing');
  assert.equal(formatModelReply('one |||| two'), 'one\n\ntwo');
  const out = formatModelReply(`para${PARAGRAPH_MARK}next ${PARAGRAPH_MARK}`);
  assert.equal(out.includes(PARAGRAPH_MARK), false);
  assert.equal(out.includes('||'), false);
  assert.equal(out, 'para\n\nnext');
});

test('null / empty / non-string inputs become empty or stringified safely', () => {
  assert.equal(formatModelReply(null), '');
  assert.equal(formatModelReply(undefined), '');
  assert.equal(formatModelReply(''), '');
  assert.equal(formatModelReply('   \n\n  '), '');
});

test('single newlines stay single (lists are not forced into paragraphs)', () => {
  assert.equal(
    formatModelReply('For example, I can:\n💬 Answer questions\n📝 Collect details'),
    'For example, I can:\n💬 Answer questions\n📝 Collect details'
  );
});

test('scripted / fixed copy is unchanged', () => {
  const samples = [
    openingMessage().message,
    OFF_PURPOSE_OWNER_REPLY,
    defaultCustomerOpening({ name: 'Studio Yoga' }),
    defaultCustomerOpening({}),
    LEAD_INTRO,
    LEAD_THANKS_YES,
    ...REQUIRED_TOPICS.map((t) =>
      typeof t.questionFor === 'function'
        ? t.questionFor({
            name: 'Studio Yoga',
            services: [],
            hours: null,
            locationOrArea: null,
          })
        : t.question
    ),
    ...REQUIRED_TOPICS.map((t) => t.ack),
  ];
  for (const sample of samples) {
    assert.equal(formatModelReply(sample), sample, `rewrote scripted copy: ${sample.slice(0, 60)}`);
    assert.equal(sample.includes('||'), false, 'scripted copy must not contain the marker');
  }
  assert.equal(openingMessage().message.split('\n\n').length, 5);
});

test('prompt line is one short instruction', () => {
  assert.equal(PARAGRAPH_PROMPT_LINE.includes('\n'), false);
  assert.match(PARAGRAPH_PROMPT_LINE, /short paragraphs/i);
  assert.match(PARAGRAPH_PROMPT_LINE, /blank line/i);
  assert.ok(PARAGRAPH_PROMPT_LINE.includes(PARAGRAPH_MARK));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
