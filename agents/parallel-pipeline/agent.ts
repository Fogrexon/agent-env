import { LlmAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { DEFAULT_MODEL } from '@agent-env/shared';

const model = process.env['AGENT_ENV_MODEL'] ?? DEFAULT_MODEL;

/**
 * Fan-out workers write to distinct session.state keys via `outputKey`.
 * Do not share keys across parallel branches (race conditions).
 */
const prosAgent = new LlmAgent({
  name: 'pros_analyst',
  model,
  description: 'Lists upside / opportunities for the topic.',
  instruction: `You analyze the user's topic and list 3 concise pros / opportunities.
Output plain bullet points only. No preamble.`,
  outputKey: 'pros',
});

const consAgent = new LlmAgent({
  name: 'cons_analyst',
  model,
  description: 'Lists risks / downsides for the topic.',
  instruction: `You analyze the user's topic and list 3 concise cons / risks.
Output plain bullet points only. No preamble.`,
  outputKey: 'cons',
});

const parallelResearch = new ParallelAgent({
  name: 'fan_out',
  description: 'Runs independent analysts concurrently.',
  subAgents: [prosAgent, consAgent],
});

const synthesizer = new LlmAgent({
  name: 'synthesizer',
  model,
  description: 'Merges parallel findings into one balanced brief.',
  instruction: `Synthesize a short balanced brief from the parallel findings.

Pros:
{pros}

Cons:
{cons}

Rules:
- Ground every claim only in the pros/cons above.
- Structure: Overview → Pros → Cons → Recommendation (1 sentence).
- Keep the whole response under 200 words.`,
});

/**
 * Canonical parallel template: ParallelAgent (fan-out) → LlmAgent (gather).
 * Required export for ADK CLI / web: `rootAgent`.
 */
export const rootAgent = new SequentialAgent({
  name: 'parallel_pipeline',
  description: 'Fan-out analysis then synthesize a single brief.',
  subAgents: [parallelResearch, synthesizer],
});
