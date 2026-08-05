import {
  createEmitHandoffTool,
  createTavilyExtractTool,
  createWebSearchConnector,
  defineAgent,
  isProviderConfigured,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { LlmAgent, type BaseTool } from '@google/adk';
import { z } from 'zod';

export const INVESTIGATION_BRIEF_SCHEMA_ID =
  'artifact://schemas/investigation-brief-v1';

export const investigationBriefSchema = z.object({
  question: z.string().min(4).max(500),
  summary: z.string().min(40).max(2500),
  findings: z
    .array(
      z.object({
        claim: z.string().min(8).max(400),
        confidence: z.enum(['high', 'medium', 'low']),
        sources: z.array(z.string().min(1).max(500)).max(5).default([]),
      }),
    )
    .min(1)
    .max(8),
  openQuestions: z.array(z.string().min(4).max(240)).max(5).default([]),
});

/**
 * Reusable web investigator (search → extract → typed InvestigationBrief).
 *
 * Dual-use agentDefinition:
 * - Standalone: `npm run run -- investigator "..."`
 * - Subagent:   `createSubagentTool(context, 'investigator')` from a parent
 *               (e.g. research-desk). Same `agent.ts`, no graph copy.
 */
export const agentDefinition = defineAgent({
  id: 'investigator',
  name: 'Investigator',
  description:
    'Independent web investigator: search + extract → typed InvestigationBrief with citations.',
  limits: {
    maxSteps: 28,
    maxToolCalls: 36,
    maxWallSeconds: 480,
    maxRepairs: 0,
  },
  verification: {
    checks: [verify.nonEmpty({ severity: 'advisory' })],
  },
  createAgent(context: AgentBuildContext) {
    const tavilyKey = () => context.secret('TAVILY_API_KEY');
    const braveKey = () => context.secret('BRAVE_API_KEY');
    const hasTavily = Boolean(context.secret('TAVILY_API_KEY')?.trim());
    const hasBrave = Boolean(context.secret('BRAVE_API_KEY')?.trim());

    if (!hasTavily && !hasBrave) {
      throw new Error(
        'investigator requires TAVILY_API_KEY or BRAVE_API_KEY (host-injected secrets)',
      );
    }

    const tools: BaseTool[] = [];
    const toolNames: string[] = [];

    if (hasTavily) {
      const web = createWebSearchConnector({
        id: 'web',
        provider: 'tavily',
        apiKey: tavilyKey,
        searchDepth: 'advanced',
        timeoutMs: 45_000,
      });
      const webTool = web.createTool();
      tools.push(webTool);
      toolNames.push(webTool.name);

      const extract = createTavilyExtractTool({
        apiKey: tavilyKey,
        timeoutMs: 60_000,
        defaultMaxCharsPerUrl: 3500,
      });
      tools.push(extract);
      toolNames.push(extract.name);
    } else {
      const web = createWebSearchConnector({
        id: 'web',
        provider: 'brave',
        apiKey: braveKey,
        timeoutMs: 45_000,
      });
      const webTool = web.createTool();
      tools.push(webTool);
      toolNames.push(webTool.name);
    }

    const emitBrief = createEmitHandoffTool({
      name: 'emit_investigation_brief',
      fromAgent: 'investigator',
      toAgent: 'caller',
      outputSchema: INVESTIGATION_BRIEF_SCHEMA_ID,
      payloadSchema: investigationBriefSchema,
      defaultObjective: 'Deliver a cited investigation brief',
      doneCriteria: [
        'payload matches InvestigationBrief',
        'findings grounded in search/extract',
        'no invented URLs',
      ],
    });
    tools.push(emitBrief);
    toolNames.push(emitBrief.name);

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    const extractHint = hasTavily
      ? 'Use extract on 1–3 promising URLs when snippets are thin.'
      : 'Brave search only (no extract tool); lean on snippets and titles.';

    return new LlmAgent({
      name: 'investigator',
      model,
      description: `Web investigator (model=${model}). Emits typed InvestigationBrief.`,
      instruction: `You are a careful web investigator for agent-env.

Tools: ${toolNames.join(', ')}.
${extractHint}

Workflow:
1. Parse the user request into a concrete investigation question.
2. Search with focused queries (usually 1–3 searches). Prefer primary / recent sources.
3. ${hasTavily ? 'Extract key pages when needed.' : 'Do not invent page contents.'}
4. Call emit_investigation_brief ONCE with payloadJson matching:
   { question, summary, findings[{ claim, confidence, sources[] }], openQuestions[] }
5. FINAL assistant message MUST be the raw JSON of the \`artifact\` object returned by emit_investigation_brief (not the markdown envelope, no prose).

Rules:
- Never invent URLs or citations.
- Mark uncertain claims confidence=low and list residual openQuestions.
- Keep summary actionable and grounded in findings.`,
      tools,
    });
  },
});
