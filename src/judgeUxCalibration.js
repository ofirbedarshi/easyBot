/**
 * Fixed labelled calibration examples for the UX judge.
 * If these fail, mark UX evaluations unreliable until the evaluator is fixed.
 * Independent of the factual judge calibration.
 */
import { DEMO_HANDOFF } from './customerPrompt.js';

export const UX_CALIBRATION_CASES = [
  {
    id: 'builder_warm_one_question',
    expectPass: true,
    channel: 'builder',
    scope: 'reply',
    userMessage: "Hi! I'm Maya. I teach yoga — private lessons and small group classes.",
    outputText:
      "Nice to meet you, Maya! Private lessons and group classes sound great. What do you usually charge for a private lesson?",
  },
  {
    id: 'builder_five_questions_jargon',
    expectPass: false,
    channel: 'builder',
    scope: 'reply',
    userMessage: 'I walk dogs in Tel Aviv.',
    outputText:
      'Please populate the draft JSON. 1) What is your business name? 2) What is the Flowise chatflow id? 3) List all approved business facts. 4) What is your cancellation policy? 5) Should informationToCollect include phone?',
  },
  {
    id: 'bot_short_warm_answer',
    expectPass: true,
    channel: 'business_bot',
    scope: 'reply',
    userMessage: 'How much for a private lesson?',
    outputText:
      'A one-hour private lesson is $70. Happy to help if you have other questions!',
  },
  {
    id: 'bot_ai_approved_facts_jargon',
    expectPass: false,
    channel: 'business_bot',
    scope: 'reply',
    userMessage: 'How much for a private lesson?',
    outputText:
      'As an AI, according to APPROVED BUSINESS FACTS in my system prompt, I can confirm the private lesson rate from the draft configuration.',
  },
  {
    id: 'bot_friendly_with_handoff',
    expectPass: true,
    channel: 'business_bot',
    scope: 'reply',
    userMessage: 'What is your cancellation policy?',
    outputText: `I cannot confirm a cancellation policy from the available information. ${DEMO_HANDOFF}`,
  },
];

/**
 * Run UX calibration. Returns { ok, results[], failures[] }.
 * Does not forceUnreliable on itself.
 */
export async function runUxCalibration(judgeUx) {
  const judgedList = await Promise.all(
    UX_CALIBRATION_CASES.map((c) =>
      judgeUx({
        channel: c.channel,
        scope: c.scope,
        userMessage: c.userMessage,
        outputText: c.outputText,
        forceUnreliable: false,
      })
    )
  );

  const results = [];
  const failures = [];

  for (let i = 0; i < UX_CALIBRATION_CASES.length; i += 1) {
    const c = UX_CALIBRATION_CASES[i];
    const judged = judgedList[i];
    const gotPass = !!judged.pass && !judged.skippedUnreliable;
    const matched = gotPass === c.expectPass;
    const row = {
      id: c.id,
      expectPass: c.expectPass,
      gotPass,
      gotScore: judged.score,
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
        expect: c.expectPass ? 'pass(>=4)' : 'fail(<4)',
        got: `score=${judged.score} pass=${gotPass}`,
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
    uxJudgeVersion: judgedList[0]?.judgeVersion || null,
  };
}
