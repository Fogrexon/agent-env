import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmAgent } from '@google/adk';
import {
  createExecEnvGuard,
  createGuardedTool,
  createTsCodeRunnerTool,
  defaultCursorModelRef,
  defaultGeminiModelRef,
  defineAgent,
  resolveModel,
  selectModelRef,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
/** Per-agent exec env for AI-generated TS (`package.json` + `node_modules`). */
const execRoot = resolve(agentDir, 'exec');

/**
 * FunctionTools for fixed logic; optional AI-generated TS in a per-agent exec npm env.
 */
export const agentDefinition = defineAgent({
  id: 'code-exec',
  name: 'Code Exec',
  description:
    'FunctionTools for fixed logic; optional AI-generated TS in a per-agent exec npm env.',
  createAgent(context: AgentBuildContext) {
    const prepareExecEnv = createExecEnvGuard({ moduleRoot: execRoot });
    const allowGenerated =
      context.config('AGENT_ENV_CODE_EXEC_ALLOW')?.trim() === '1';

    /**
     * Pre-declared agent logic = normal FunctionTools (LLM calls these).
     */
    const hello = createGuardedTool({
      contract: {
        name: 'hello',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Return a short greeting.',
      parameters: z.object({
        name: z.string().optional().describe('Who to greet'),
      }),
      execute: ({ name }) => ({ message: `hello, ${name ?? 'world'}` }),
    });

    const sum = createGuardedTool({
      contract: {
        name: 'sum',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Sum a list of numbers.',
      parameters: z.object({
        numbers: z.array(z.number()).min(1).describe('Numbers to add'),
      }),
      execute: ({ numbers }) => ({
        total: numbers.reduce((a, b) => a + b, 0),
      }),
    });

    /**
     * AI-generated TypeScript runs inside agents/code-exec/exec.
     * Dependencies are declared in exec/package.json and installed via ensureExecEnv
     * (not by the model picking arbitrary packages at runtime).
     */
    const runTsCode = createTsCodeRunnerTool({
      workRoot: execRoot,
      prepare: prepareExecEnv,
      approve: () => allowGenerated,
    });

    const modelRef = selectModelRef(
      defaultCursorModelRef(),
      defaultGeminiModelRef(),
    );

    return new LlmAgent({
      name: 'code-exec',
      model: resolveModel(modelRef),
      description:
        'FunctionTools for fixed logic; optional AI-generated TS in a per-agent exec npm env.',
      instruction: `You help the user with small computations and, when allowed, generated TypeScript.

Tools:
1. hello / sum — preferred for fixed tasks (normal function calls).
2. run_ts_code — AI-generated TypeScript in this agent's exec env.
   Imports must come from packages already declared in agents/code-exec/exec/package.json
   (currently: ms). Often policy_denied unless the host set AGENT_ENV_CODE_EXEC_ALLOW=1.

Rules:
- Prefer hello/sum when they fit.
- For run_ts_code, write a short self-contained program that console.log's the answer.
- Report stdout/stderr/exit status clearly. Do not claim success if status is not ok.`,
      tools: [hello, sum, runTsCode],
    });
  },
});
