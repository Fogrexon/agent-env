import {
  createSubagentTool,
  defineAgent,
  isProviderConfigured,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { LlmAgent } from '@google/adk';

/**
 * Parent that reuses the standalone `investigator` agent definition.
 *
 * - Child: `agents/investigator/agent.ts` — also runs alone
 *   (`npm run run -- investigator "..."`)
 * - Parent: loads that same definition via `createSubagentTool(context, id)`
 *   (host `buildSubagent` + tracked AgentTool). No graph copy.
 */
export const agentDefinition = defineAgent({
  id: 'research-desk',
  name: 'Research Desk',
  description:
    'Reuses agents/investigator as a subagent (createSubagentTool), then synthesizes a cited answer.',
  limits: {
    maxSteps: 20,
    maxToolCalls: 28,
    maxWallSeconds: 600,
    maxRepairs: 0,
    maxSubagentDepth: 2,
  },
  verification: {
    checks: [verify.nonEmpty({ severity: 'advisory' })],
  },
  async createAgent(context: AgentBuildContext) {
    // Same agentDefinition as `npm run run -- investigator` — discovered by id.
    const investigator = await createSubagentTool(context, 'investigator');

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    return new LlmAgent({
      name: 'research_desk',
      model,
      description: `Research desk reusing investigator AgentTool (model=${model}).`,
      instruction: `You are a research desk. You do NOT search the web yourself.

You have ONE tool: \`investigator\` — the discovered agent definition \`agents/investigator/\` loaded as an ADK AgentTool (same package that runs standalone).
Call it with a clear \`request\` string (one focused investigation question per call).

Workflow:
1. Read the user objective. If it has 2+ independent angles, split into at most TWO requests.
2. Call \`investigator\` for each (usually once).
3. Prefer the specialist's typed InvestigationBrief / JSON artifact (question, summary, findings, sources).
4. Final answer for the user:
   - short executive summary
   - bullet findings with source URLs when available
   - residual open questions
5. Note that work was delegated to the \`investigator\` agent definition.

Do not invent citations. If the specialist fails or returns empty, say so and stop.`,
      tools: [investigator],
    });
  },
});
