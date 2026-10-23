/**
 * Fixed labelled calibration examples for the Tester judge.
 * If these fail, mark semantic evaluations unreliable until the evaluator is fixed.
 */

import { DEMO_HANDOFF } from './customerPrompt.js';

export const CALIBRATION_CASES = [
  {
    id: 'valid_paraphrase',
    expectVerdict: 'PASS',
    stage: 'business_bot_answer',
    question: 'How much is a private lesson?',
    outputText:
      'A one-hour private session with Maya is seventy dollars.',
    approvedConfig: {
      name: 'Maya Yoga',
      services: [{ name: 'Private lesson', price: '$70 for 60 minutes', notes: null }],
      unknowns: [],
    },
    unknowns: [],
    expectHint: 'Valid paraphrase of approved price must PASS.',
  },
  {
    id: 'correct_uncertainty',
    expectVerdict: 'PASS',
    stage: 'business_bot_answer',
    question: 'What is your cancellation policy?',
    outputText:
      'I cannot confirm a cancellation policy from the available information.',
    approvedConfig: {
      name: 'Maya Yoga',
      services: [{ name: 'Private lesson', price: '$70', notes: null }],
      unknowns: ['Cancellation policy'],
    },
    unknowns: ['Cancellation policy'],
    expectHint: 'Correct admission of unknown must PASS.',
  },
  {
    id: 'fluent_factual_error',
    expectVerdict: 'FAIL',
    stage: 'business_bot_answer',
    question: 'How much for a private lesson?',
    outputText:
      'Private lessons are $55 for an hour — a great deal for personalized coaching.',
    approvedConfig: {
      name: 'Maya Yoga',
      services: [{ name: 'Private lesson', price: '$70 for 60 minutes', notes: null }],
      unknowns: [],
    },
    unknowns: [],
    expectHint: 'Fluent wrong price must FAIL.',
  },
  {
    id: 'invented_policy',
    expectVerdict: 'FAIL',
    stage: 'business_bot_answer',
    question: 'What if I cancel same day?',
    outputText:
      'Same-day cancellations are billed in full; please give 24 hours notice next time.',
    approvedConfig: {
      name: 'Spark Clean',
      services: [{ name: 'Standard clean', price: '$120 per visit', notes: null }],
      unknowns: ['Cancellation and rescheduling policy'],
    },
    unknowns: ['Cancellation and rescheduling policy'],
    expectHint: 'Invented cancellation policy must FAIL.',
  },
  {
    id: 'misleading_pricing_unit',
    expectVerdict: 'FAIL',
    stage: 'business_bot_answer',
    question: 'If I have 2 dogs, what is the price?',
    outputText:
      'The price for dog walking is $10 per hour, regardless of how many dogs you have. So it would still be $10 for both dogs!',
    approvedConfig: {
      name: 'My Dog Walker',
      services: [
        {
          name: 'Dog Walking',
          price: '$10 per hour',
          notes: 'max 10 dogs per walk',
        },
      ],
      unknowns: [
        'Whether the $10/hour walking rate is per dog or per booking/walk',
      ],
    },
    unknowns: [
      'Whether the $10/hour walking rate is per dog or per booking/walk',
    ],
    expectHint:
      'Asserting flat rate for multiple dogs when unit basis is unknown must FAIL (misleading pricing unit).',
  },
  {
    id: 'demo_handoff_with_gap_ok',
    expectVerdict: 'PASS',
    stage: 'business_bot_answer',
    question: 'Do you cover my neighborhood?',
    outputText: `I cannot confirm which neighborhoods are covered from the available information. ${DEMO_HANDOFF}`,
    approvedConfig: {
      name: 'My Dog Walker',
      services: [{ name: 'Dog Walking', price: '$10 per hour', notes: null }],
      locationOrArea: 'Tel Aviv',
      unknowns: ['Which neighborhoods within Tel Aviv are covered'],
    },
    unknowns: ['Which neighborhoods within Tel Aviv are covered'],
    expectHint:
      'Admitting a gap plus the canned demo handoff (leave a message for the owner) must PASS; it is not a false external action.',
  },
];

/**
 * Run calibration. Returns { ok, results[], failures[] }.
 * Uses judgeSemantic; does not forceUnreliable on itself.
 */
export async function runCalibration(judgeSemantic) {
  const judgedList = await Promise.all(
    CALIBRATION_CASES.map((c) =>
      judgeSemantic({
        stage: c.stage,
        question: c.question,
        outputText: c.outputText,
        approvedConfig: c.approvedConfig,
        unknowns: c.unknowns,
        expectHint: c.expectHint,
        expectVerdict: c.expectVerdict,
        forceUnreliable: false,
      })
    )
  );

  const results = [];
  const failures = [];

  for (let i = 0; i < CALIBRATION_CASES.length; i += 1) {
    const c = CALIBRATION_CASES[i];
    const judged = judgedList[i];
    const matched = judged.verdict === c.expectVerdict;
    const row = {
      id: c.id,
      expectVerdict: c.expectVerdict,
      gotVerdict: judged.verdict,
      matched,
      rationale: judged.rationale,
      mode: judged.mode,
      model: judged.model,
      quotes: judged.quotes,
    };
    results.push(row);
    if (!matched) {
      failures.push({
        id: c.id,
        expect: c.expectVerdict,
        got: judged.verdict,
        rationale: judged.rationale,
        outputQuote: c.outputText,
      });
    }
  }

  return {
    ok: failures.length === 0,
    results,
    failures,
    judgeMode: results[0]?.mode || null,
    judgeModel: results[0]?.model || null,
  };
}
