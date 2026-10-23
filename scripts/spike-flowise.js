/**
 * Spike: prove we can create a Flowise chatflow from the saved graph
 * template and get a real prediction response.
 *
 * Labels: real-flowise | real-llm | error
 */
import 'dotenv/config';
import {
  pingFlowise,
  loadGraphTemplate,
  createOrUpdateChatflow,
  predict,
} from '../src/flowise.js';
import { emptyProfile } from '../src/profile.js';

async function main() {
  console.log('=== Flowise spike ===');
  const graph = loadGraphTemplate();
  console.log(
    `Template nodes=${graph.nodes.length} edges=${graph.edges.length}`
  );
  if (!graph.nodes.length || !graph.edges.length) {
    throw new Error('Invalid graph template — need nodes+edges');
  }

  const up = await pingFlowise();
  if (!up) throw new Error('Flowise not reachable at FLOWISE_URL');
  console.log('Flowise ping: OK');

  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY required for prediction');
  }

  const profile = {
    ...emptyProfile(),
    name: 'Spike Yoga',
    whatWeDo: 'Private yoga lessons',
    services: [{ name: 'Private lesson', price: '$70', notes: null }],
    hours: 'Weekday evenings',
    locationOrArea: 'Downtown studio',
    tone: 'warm and calm',
    chatflowId: null,
  };

  const id = await createOrUpdateChatflow(profile);
  console.log('Created/updated chatflow:', id, '[real-flowise]');

  const answer = await predict(id, 'How much is a private lesson?', 'spike-1');
  console.log('Prediction reply [real-flowise + real-llm]:');
  console.log(answer);

  const lower = String(answer).toLowerCase();
  if (!lower.includes('70') && !lower.includes('$70')) {
    console.warn('WARN: reply may not mention $70 — inspect above');
  } else {
    console.log('Spike check: price mentioned — OK');
  }
  console.log('=== spike done ===');
}

main().catch((err) => {
  console.error('SPIKE FAILED:', err.message);
  process.exit(1);
});
