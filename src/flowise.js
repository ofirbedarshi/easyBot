import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCustomerSystemPrompt } from './customerPrompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(
  __dirname,
  '..',
  'templates',
  'customer-bot.flowise.json'
);

function baseUrl() {
  return (process.env.FLOWISE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.FLOWISE_API_KEY;
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function flowiseFetch(pathname, options = {}) {
  const res = await fetch(`${baseUrl()}${pathname}`, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      typeof body === 'object' ? JSON.stringify(body) : String(body);
    throw new Error(`Flowise ${options.method || 'GET'} ${pathname} → ${res.status}: ${msg}`);
  }
  return body;
}

export async function pingFlowise() {
  const res = await fetch(`${baseUrl()}/api/v1/ping`);
  return res.ok;
}

export function loadGraphTemplate() {
  const raw = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  // Marketplace export may wrap nodes/edges; chatflow.flowData needs {nodes,edges}
  return {
    nodes: raw.nodes,
    edges: raw.edges,
    viewport: raw.viewport || { x: 0, y: 0, zoom: 1 },
  };
}

/**
 * Inject OpenAI key into ChatOpenAI node (password field) so Flowise
 * can call the model without a UI-created credential.
 * Also set model + system message from approved profile.
 */
export function buildFlowData(profile) {
  const graph = loadGraphTemplate();
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const systemMessage = buildCustomerSystemPrompt(profile);

  for (const node of graph.nodes) {
    if (node.data?.name === 'chatOpenAI') {
      node.data.inputs = {
        ...node.data.inputs,
        modelName: model,
        temperature: 0.3,
        openAIApiKey: apiKey,
        allowImageUploads: false,
      };
      // Prefer direct API key over credential slot when both exist
      if (node.data.inputParams) {
        // no-op; inputs.openAIApiKey used by older + some versions
      }
    }
    if (node.data?.name === 'conversationChain') {
      node.data.inputs = {
        ...node.data.inputs,
        systemMessagePrompt: systemMessage,
      };
    }
  }

  return JSON.stringify(graph);
}

export async function createOrUpdateChatflow(profile) {
  const flowData = buildFlowData(profile);
  const name = `easyBot — ${profile.name || 'Business'} CS`;

  if (profile.chatflowId) {
    try {
      const updated = await flowiseFetch(
        `/api/v1/chatflows/${profile.chatflowId}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            name,
            flowData,
            deployed: true,
            isPublic: true,
            type: 'CHATFLOW',
          }),
        }
      );
      return updated.id || profile.chatflowId;
    } catch (err) {
      // Chatflow may have been deleted — create fresh
      console.warn('Flowise update failed, creating new chatflow:', err.message);
    }
  }

  const created = await flowiseFetch('/api/v1/chatflows', {
    method: 'POST',
    body: JSON.stringify({
      name,
      flowData,
      deployed: true,
      isPublic: true,
      type: 'CHATFLOW',
    }),
  });
  return created.id;
}

export async function predict(chatflowId, question, sessionId) {
  const body = {
    question,
    streaming: false,
    overrideConfig: {
      openAIApiKey: process.env.OPENAI_API_KEY,
      sessionId: sessionId || undefined,
    },
  };
  if (sessionId) body.overrideConfig.sessionId = sessionId;

  const result = await flowiseFetch(`/api/v1/prediction/${chatflowId}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (typeof result === 'string') return result;
  if (result?.text) return result.text;
  if (result?.json) return typeof result.json === 'string' ? result.json : JSON.stringify(result.json);
  return JSON.stringify(result);
}
