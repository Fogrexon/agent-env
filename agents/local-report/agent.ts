import { resolve } from 'node:path';
import { LlmAgent, SequentialAgent } from '@google/adk';
import {
  contextBudgetModelParams,
  createEmitHandoffTool,
  createGuardedTool,
  createTavilyExtractTool,
  createWebSearchConnector,
  createWorkspaceFsTools,
  defineAgent,
  isProviderConfigured,
  resolveModel,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';
import {
  LOCAL_EVIDENCE_SCHEMA_ID,
  localEvidenceLedgerSchema,
} from './schema.js';

/**
 * Local-LLM report: research → typed evidence handoff → write report.md.
 * Context window guarded via contextBudgetModelParams (needs ModelRef.params).
 */
const MODEL = 'qwen/qwen3.6-35b-a3b';
const CONTEXT_WINDOW = 262144;
const LOCAL_PROVIDER_IDS = ['lm-studio', 'openai-compatible'] as const;

function pickLocalProviderId(context: AgentBuildContext): string {
  const configured = context.config('LOCAL_LLM_PROVIDER_ID')?.trim();
  if (configured) return configured;
  const found = LOCAL_PROVIDER_IDS.find((id) => isProviderConfigured(id));
  return found ?? 'openai-compatible';
}

export const agentDefinition = defineAgent({
  id: 'local-report',
  name: 'Local Report',
  description:
    'Local-LLM report: web research → typed evidence handoff → report.md (context-budgeted tool loop).',
  limits: {
    maxSteps: 60,
    maxToolCalls: 50,
    maxWallSeconds: 1800,
    maxRepairs: 0,
  },
  verification: {
    checks: [
      verify.artifact({
        artifactId: 'report',
        mediaTypes: ['text/markdown'],
        minBytes: 800,
      }),
      verify.document({
        artifactId: 'report',
        sections: ['Sources', 'Residual uncertainties'],
      }),
    ],
  },
  createAgent(context: AgentBuildContext) {
    // resolveModel kept for ModelRef.params (context budget knobs).
    const model = resolveModel({
      provider: pickLocalProviderId(context),
      model: MODEL,
      params: {
        ...contextBudgetModelParams({
          contextWindow: CONTEXT_WINDOW,
          reserveOutputTokens: 16000,
          maxToolResultChars: 6000,
          maxToolIterations: 8,
          contextOverflow: 'truncate-then-summarize',
        }),
        temperature: 0.3,
        maxTokens: 8000,
      },
    });
    const tavilyKey = () => context.secret('TAVILY_API_KEY');

    const webSearch = createWebSearchConnector({
      provider: 'tavily',
      apiKey: tavilyKey,
      searchDepth: 'advanced',
      timeoutMs: 45_000,
    });
    const fetchPages = createTavilyExtractTool({
      apiKey: tavilyKey,
      timeoutMs: 60_000,
      defaultMaxCharsPerUrl: 4000,
    });

    const workRoots = new Set<string>();
    const fs = createWorkspaceFsTools({
      roots: () => [...workRoots],
      write: { approve: () => true },
    });
    const registerWorkspace = createGuardedTool({
      contract: {
        version: '1.0',
        name: 'register_workspace',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Register run workspace for write_file.',
      parameters: z.object({
        dir: z.string().describe('Absolute run workspace directory'),
      }),
      execute: ({ dir }) => {
        const abs = resolve(dir);
        workRoots.add(abs);
        return { status: 'success' as const, dir: abs };
      },
    });

    const emitLedger = createEmitHandoffTool({
      name: 'emit_evidence_ledger',
      fromAgent: 'report_researcher',
      toAgent: 'report_writer',
      outputSchema: LOCAL_EVIDENCE_SCHEMA_ID,
      payloadSchema: localEvidenceLedgerSchema,
      defaultObjective: 'Compact evidence for report writing',
      doneCriteria: [
        'findings grounded in tool output',
        'no invented URLs',
      ],
    });

    const researcher = new LlmAgent({
      name: 'report_researcher',
      model,
      description: 'Search → typed local evidence handoff.',
      instruction: `RESEARCH step. Use search_web / fetch_pages. Do not write the report.

Keep context small: ~4–8 searches, ≤6 fetched pages. Distill — do not dump raw pages.

Call emit_evidence_ledger with:
{
  "findings": [{ "text": "concrete fact", "url": "https://…", "topic": "…" }],
  "sources": [{ "title": "…", "url": "https://…" }],
  "coverageGaps": ["…"]
}
FINAL message = emit envelope. Never invent URLs/facts.`,
      tools: [webSearch.createTool(), fetchPages, emitLedger],
      outputKey: 'evidence_ledger',
    });

    const writer = new LlmAgent({
      name: 'report_writer',
      model,
      description: 'Write report.md from typed evidence handoff.',
      instruction: `WRITER. Workspace: {runWorkspaceDir}

Evidence handoff (prefer JSON payload):
{evidence_ledger}

Write one useful Markdown report; cite URLs inline; match user language.
Trailing sections (exact English headers): ## Sources, ## Residual uncertainties.

1. register_workspace(dir=runWorkspaceDir)
2. write_file {runWorkspaceDir}/report.md
3. FINAL message = full report.md contents.`,
      tools: [registerWorkspace, fs.writeFile],
    });

    return new SequentialAgent({
      name: 'local_report',
      description:
        'Local-LLM: research → typed evidence handoff → report.md.',
      subAgents: [researcher, writer],
    });
  },
});
