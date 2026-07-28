import {
  createAgentMemoryStore,
  createAgentMemoryTools,
  createContextBuilder,
  defaultCursorModelRef,
  defineAgent,
  resolveModel,
  selectModelRef,
  shapeObservation,
} from '@agent-env/harness';
import { DEFAULT_CURSOR_MODEL, DEFAULT_GEMINI_MODEL } from '@agent-env/shared';
import { LlmAgent } from '@google/adk';

/**
 * Minimal demo of Loop + Data planes:
 * - ContextBuilder assembles a bounded working-context hint into instruction
 * - Agent memory tools (propose→validate→accept / retrieve) are available
 */
export const agentDefinition = defineAgent({
  id: 'hello',
  name: 'Hello',
  description:
    'Minimal demo with ContextBuilder working-context hint + agent memory tools.',
  createAgent() {
    const modelRef = selectModelRef(defaultCursorModelRef(), {
      provider: 'gemini',
      model: DEFAULT_GEMINI_MODEL,
    });

    const memory = createAgentMemoryStore({ defaultScope: 'hello' });
    const memoryTools = createAgentMemoryTools({ store: memory });

    // Seed one accepted preference so retrieve can demonstrate the Data plane.
    memory.apply(
      {
        op: 'ADD',
        content: 'This harness greets briefly and can remember short facts via memory tools.',
        kind: 'fact',
        scope: 'hello',
        tags: ['harness'],
      },
      { acceptImmediately: true },
    );

    const working = createContextBuilder({ budgetTokens: 600 })
      .addSection({
        kind: 'instruction',
        title: 'Role',
        content:
          'You are a concise assistant for the agent-env harness (Loop + Data demo).',
      })
      .addSection({
        kind: 'plan',
        title: 'Plan',
        content:
          '1) Greet briefly. 2) Optionally memory_retrieve. 3) Optionally memory_propose a new fact then note it is not searchable until validated+accepted.',
      })
      .addObservation('Seed note', {
        status: 'ok',
        content: shapeObservation({
          status: 'ok',
          content: 'Seed memory is available under scope=hello.',
          source: 'system',
        }).content,
        source: 'system',
      })
      .build();

    return new LlmAgent({
      name: 'hello',
      model: resolveModel(modelRef),
      description: `Greets the user (provider=${modelRef.provider}, model=${modelRef.model || DEFAULT_CURSOR_MODEL}).`,
      instruction: `${working.text}

If the user attached documents, some may arrive as "[attachment: ... text-extracted]"; use them when relevant.

Memory tools (Data plane): memory_retrieve, memory_extract, memory_propose, memory_validate, memory_accept, memory_apply.
Keep the reply short. Mention when you used memory.`,
      tools: memoryTools.tools,
    });
  },
});
