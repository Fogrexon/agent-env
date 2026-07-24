import { LlmAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import {
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  type ModelRef,
} from '@agent-env/shared';
import {
  defaultCursorModelRef,
  parseModelRef,
  resolveModel,
  selectModelRef,
} from '@agent-env/harness';
import { bootstrapProvidersFromEnv, loadDotEnv } from '@agent-env/repo-env';

loadDotEnv();
bootstrapProvidersFromEnv();

/**
 * Multi-provider fan-out demo (Cursor SDK by default):
 * - pros / cons / synth → Cursor when registered, else Gemini fallback
 *
 * Override per branch via env:
 *   AGENT_ENV_PROS_MODEL=cursor:composer-2
 *   AGENT_ENV_CONS_MODEL=lm-studio:local-model
 */
function refFromEnv(key: string, fallback: ModelRef): ModelRef {
  return parseModelRef(process.env[key], fallback);
}

const cursorPreferred = defaultCursorModelRef(
  process.env['AGENT_ENV_CURSOR_MODEL']?.trim() || DEFAULT_CURSOR_MODEL,
);

const geminiFallback: ModelRef = {
  provider: 'gemini',
  model: DEFAULT_GEMINI_MODEL,
};

const cursorOrGemini = selectModelRef(cursorPreferred, geminiFallback);

const prosRef = refFromEnv('AGENT_ENV_PROS_MODEL', cursorOrGemini);
const consRef = refFromEnv('AGENT_ENV_CONS_MODEL', cursorOrGemini);
const synthRef = refFromEnv('AGENT_ENV_SYNTH_MODEL', cursorOrGemini);

/** Documented bindings for registry / admin UI. */
export const pipelineModels: ModelRef[] = [prosRef, consRef, synthRef];

const prosAgent = new LlmAgent({
  name: 'pros_analyst',
  model: resolveModel(prosRef),
  description: `Lists upside / opportunities (provider=${prosRef.provider}).`,
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

export const rootAgent = new SequentialAgent({
  name: 'parallel_pipeline',
  description:
    'Fan-out analysis on possibly different providers, then synthesize.',
  subAgents: [parallelResearch, synthesizer],
});
