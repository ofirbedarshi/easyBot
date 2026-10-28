/**
 * Chat Completions with a cached per-model request shape.
 * Classic models keep temperature 0. If the API rejects that (reasoning
 * models), retry without temperature, with max_completion_tokens and the
 * lowest reasoning_effort the model accepts.
 */

const LOWEST_EFFORTS = ['none', 'minimal', 'low'];
const DEFAULT_MAX_COMPLETION_TOKENS = 1024;

/** @type {Map<string, { temperature?: number, reasoning_effort?: string, max_completion_tokens?: number }>} */
const shapeByModel = new Map();

export function resetChatCompletionShapeCache() {
  shapeByModel.clear();
}

export function cachedChatCompletionShape(model) {
  return shapeByModel.get(model) || null;
}

function isUnsupportedParamError(err) {
  const msg = String(err?.message || err);
  return (
    err?.status === 400 ||
    /unsupported|not supported|unknown parameter|invalid[_\s-]?value|temperature|reasoning_effort|max_tokens|max_completion/i.test(
      msg
    )
  );
}

async function tryCreate(client, req) {
  const completion = await client.chat.completions.create(req);
  return { completion, request: req };
}

/**
 * @param {object} client
 * @param {{ model: string, messages: object[], maxCompletionTokens?: number, response_format?: object }} args
 * @returns {Promise<{ completion: object, request: object }>}
 */
export async function createChatCompletion(
  client,
  { model, messages, maxCompletionTokens, response_format }
) {
  const maxTokens = maxCompletionTokens || DEFAULT_MAX_COMPLETION_TOKENS;
  const format = response_format ? { response_format } : {};
  const cached = shapeByModel.get(model);
  if (cached) {
    return tryCreate(client, { model, messages, ...cached, ...format });
  }

  try {
    const result = await tryCreate(client, { model, messages, temperature: 0, ...format });
    shapeByModel.set(model, { temperature: 0 });
    return result;
  } catch (err) {
    if (!isUnsupportedParamError(err)) throw err;
  }

  let lastErr;
  for (const effort of LOWEST_EFFORTS) {
    try {
      const extras = {
        max_completion_tokens: maxTokens,
        reasoning_effort: effort,
      };
      const result = await tryCreate(client, { model, messages, ...extras, ...format });
      shapeByModel.set(model, extras);
      return result;
    } catch (err) {
      lastErr = err;
      if (!isUnsupportedParamError(err)) throw err;
    }
  }

  try {
    const extras = { max_completion_tokens: maxTokens };
    const result = await tryCreate(client, { model, messages, ...extras, ...format });
    shapeByModel.set(model, extras);
    return result;
  } catch (err) {
    throw lastErr || err;
  }
}

export function reasoningTokensFromUsage(usage) {
  const details = usage?.completion_tokens_details || usage?.output_tokens_details || {};
  return Number(details.reasoning_tokens || details.reasoningTokens || 0) || 0;
}
