import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmAgent } from '@google/adk';
import {
  createExecEnvGuard,
  createGuardedTool,
  createTsCodeRunnerTool,
  defineAgent,
  isProviderConfigured,
  shapeObservation,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
/** Per-agent exec env for AI-generated TS (`package.json` + `node_modules`). */
const execRoot = resolve(agentDir, 'exec');

/**
 * CodeAct-oriented demo: fixed FunctionTools + optional generated TS.
 * Tool results are shaped as bounded observations (Loop plane).
 */
export const agentDefinition = defineAgent({
  id: 'code-exec',
  name: 'Code Exec',
  description:
    'Bounded-observation FunctionTools + optional AI-generated TS (CodeAct-style) in a per-agent exec env.',
  mode: 'autonomous',
  limits: {
    maxSteps: 20,
    maxToolCalls: 20,
    maxWallSeconds: 300,
  },
  createAgent(context: AgentBuildContext) {
    const prepareExecEnv = createExecEnvGuard({ moduleRoot: execRoot });
    const allowGenerated =
      context.config('AGENT_ENV_CODE_EXEC_ALLOW')?.trim() === '1';

    const hello = createGuardedTool({
      contract: {
        name: 'hello',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Return a short greeting as a bounded observation.',
      parameters: z.object({
        name: z.string().optional().describe('Who to greet'),
      }),
      execute: ({ name }) =>
        shapeObservation({
          status: 'ok',
          content: { message: `hello, ${name ?? 'world'}` },
          source: 'tool',
          toolName: 'hello',
        }),
    });

    const sum = createGuardedTool({
      contract: {
        name: 'sum',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Sum a list of numbers (bounded observation).',
      parameters: z.object({
        numbers: z.array(z.number()).min(1).describe('Numbers to add'),
      }),
      execute: ({ numbers }) =>
        shapeObservation({
          status: 'ok',
          content: { total: numbers.reduce((a, b) => a + b, 0) },
          source: 'tool',
          toolName: 'sum',
        }),
    });

    const runTsCode = createTsCodeRunnerTool({
      workRoot: execRoot,
      prepare: prepareExecEnv,
      approve: () => allowGenerated,
    });

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    return new LlmAgent({
      name: 'code-exec',
      model,
      description:
        'Bounded-observation FunctionTools + optional generated TS in exec/.',
      instruction: `You help with small computations and, when allowed, generated TypeScript (CodeAct-style).

Tools:
1. hello / sum — fixed tasks; results arrive as bounded observations (status/content/source).
2. run_ts_code — AI-generated TypeScript in this agent's exec env.
   Imports must come from packages already in agents/code-exec/exec/package.json (currently: ms).
   Often policy_denied unless AGENT_ENV_CODE_EXEC_ALLOW=1.

Rules:
- Prefer hello/sum when they fit.
- For run_ts_code, write a short self-contained program that console.log's the answer.
- Report observation status / stdout / stderr clearly. Do not claim success if status is not ok.`,
      tools: [hello, sum, runTsCode],
    });
  },
});
