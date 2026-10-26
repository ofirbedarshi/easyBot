/**
 * Shared token-cost helper for live replay scripts. Never logs env values.
 * Patches OpenAI.Chat.Completions so every client created later is counted.
 */
import OpenAI from 'openai';

export const MODEL_PRICES = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-5-mini': { in: 0.25, out: 2 },
  'gpt-6-sol': { in: 2, out: 10 },
  'gpt-6-luna': { in: 0.1, out: 0.5 },
};

export function costOf(model, usage) {
  const p = MODEL_PRICES[model] || MODEL_PRICES['gpt-4o-mini'];
  const input = usage?.prompt_tokens || 0;
  const output = usage?.completion_tokens || 0;
  return (input * p.in + output * p.out) / 1e6;
}

export function attachCostTracker(model) {
  let spent = 0;
  const Completions = OpenAI.Chat.Completions;
  const orig = Completions.prototype.create;
  Completions.prototype.create = function patchedCreate(body, options) {
    return Promise.resolve(orig.call(this, body, options)).then((completion) => {
      spent += costOf(model, completion?.usage);
      return completion;
    });
  };
  return {
    getSpent: () => spent,
    print: () => console.log(`Total spent: $${spent.toFixed(4)}`),
  };
}
