import { LlmAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import {
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  type ModelRef,
} from '@agent-env/shared';
import {
  defaultGeminiModelRef,
  parseModelRef,
  resolveModel,
  selectModelRef,
} from '@agent-env/llm';

/**
 * Multi-provider fan-out demo:
 * - pros  → Gemini (native)
 * - cons  → Cursor when CURSOR_API_KEY is set, else Gemini fallback
 * - synth → Gemini
 *
 * Override with env:
 *   AGENT_ENV_PROS_MODEL=gemini:gemini-2.5-flash
 *   AGENT_ENV_CONS_MODEL=cursor:composer-2
 *   AGENT_ENV_SYNTH_MODEL=gemini:gemini-2.5-flash
 */
function refFromEnv(key: string, fallback: ModelRef): ModelRef {
  return parseModelRef(process.env[key], fallback);
}

const geminiFallback: ModelRef = {
  provider: 'gemini',
  model: DEFAULT_GEMINI_MODEL,
};

const prosRef = refFromEnv('AGENT_ENV_PROS_MODEL', defaultGeminiModelRef());

const consPreferred = refFromEnv('AGENT_ENV_CONS_MODEL', {
  provider: 'cursor',
  model: process.env['AGENT_ENV_CURSOR_MODEL']?.trim() || DEFAULT_CURSOR_MODEL,
});

const consRef = selectModelRef(consPreferred, geminiFallback);

const synthRef = refFromEnv('AGENT_ENV_SYNTH_MODEL', defaultGeminiModelRef());

/** Documented bindings for registry / admin UI. */
export const pipelineModels: ModelRef[] = [prosRef, consRef, synthRef];

/**
 * Fan-out workers write to distinct session.state keys via `outputKey`.
 * Do not share keys across parallel branches (race conditions).
 */
const prosAgent = new LlmAgent({
  name: 'pros_analyst',
  model: resolveModel(prosRef),
  description: 'Lists upside / opportunities for the topic (Gemini).',
  instruction: `You analyze the user's topic and list 3 concise pros / opportunities.
Output plain bullet points only. No preamble.`,
  outputKey: 'pros',
});

const consAgent = new LlmAgent({
  name: 'cons_analyst',
  model: resolveModel(consRef),
  description: `Lists risks / downsides (provider=${consRef.provider}).`,
  instruction: `You analyze the user's topic and list 3 concise cons / risks.
Output plain bullet points only. No preamble.`,
  outputKey: 'cons',
});

const parallelResearch = new ParallelAgent({
  name: 'fan_out',
  description:
    'Runs independent analysts concurrently (possibly different LLM vendors).',
  subAgents: [prosAgent, consAgent],
});

const synthesizer = new LlmAgent({
  name: 'synthesizer',
  model: resolveModel(synthRef),
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
  description:
    'Fan-out analysis on possibly different providers, then synthesize.',
  subAgents: [parallelResearch, synthesizer],
});
