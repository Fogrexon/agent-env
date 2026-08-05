import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LlmAgent } from '@google/adk';
import {
  createPythonScriptTool,
  defineAgent,
  isProviderConfigured,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';

const agentDir = fileURLToPath(new URL('.', import.meta.url));
/** Predeclared Python scripts + requirements + .venv live here. */
const pythonRoot = resolve(agentDir, 'python');

/**
 * Vision / detection demo:
 *   predeclared `python/scripts/detect.py` (mock YOLO JSON)
 *   → agent reasons about detections (clear / warn / escalate).
 *
 * Swap detect.py + requirements.txt for real ultralytics without changing
 * the tool contract (imagePath / conf → JSON detections).
 */
export const agentDefinition = defineAgent({
  id: 'python-vision',
  name: 'Python Vision',
  description:
    'Run agent-local Python detection scripts (mock YOLO) then decide from structured results.',
  limits: {
    maxSteps: 16,
    maxToolCalls: 8,
    maxWallSeconds: 300,
    maxRepairs: 0,
  },
  verification: {
    checks: [
      verify.contains({ text: '## Decision', severity: 'advisory' }),
    ],
  },
  createAgent(_context: AgentBuildContext) {
    const runDetect = createPythonScriptTool({
      pythonRoot,
      script: 'scripts/detect.py',
      name: 'run_detect',
      riskClass: 'T1',
      description:
        'Run the predeclared Python detector (scripts/detect.py) and return JSON detections.',
      parameters: z.object({
        imagePath: z
          .string()
          .min(1)
          .describe('Absolute or agent-visible path to an image file'),
        conf: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe('Confidence threshold (default 0.25)'),
      }),
    });

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    return new LlmAgent({
      name: 'python_vision',
      model,
      description:
        'Calls run_detect (Python) then recommends an action from detections.',
      instruction: `You are a vision triage agent. The detector is a **predeclared Python script**
under this agent's python/ tree (not free-form code generation).

Workflow:
1. Call run_detect with imagePath (and optional conf).
   - Filename hints in the mock: "person"/"crowd", "car"/"traffic", "empty"/"blank".
   - Missing files still return mock JSON with imageExists=false + warning.
2. Read result.detections / count / warning from the tool response.
3. Decide one of: CLEAR | WATCH | ALERT — with a short rationale grounded in detections.
4. Finish with markdown:

## Decision
CLEAR | WATCH | ALERT

## Evidence
- bullets from detections (label, confidence, bbox)

## Next action
One concrete recommendation.

Do not invent detections that were not in the tool output.`,
      tools: [runDetect],
    });
  },
});
