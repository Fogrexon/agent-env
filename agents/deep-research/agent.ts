import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { LlmAgent, SequentialAgent } from '@google/adk';
import {
  createEmitHandoffTool,
  createGuardedTool,
  createGrokBuildXSearchConnector,
  createHttpDownloadTool,
  createMarkdownPdfTool,
  createTavilyExtractTool,
  createWebSearchConnector,
  createWorkspaceFsTools,
  defaultCursorModelRef,
  defaultGeminiModelRef,
  defineAgent,
  resolveModel,
  selectModelRef,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';
import {
  DRAFT_REPORT_SCHEMA_ID,
  EVIDENCE_LEDGER_SCHEMA_ID,
  GAP_FILL_SCHEMA_ID,
  RESEARCH_PLAN_SCHEMA_ID,
  RESEARCH_SCOPE_SCHEMA_ID,
  draftReportSchema,
  evidenceLedgerSchema,
  gapFillSchema,
  researchPlanSchema,
  researchScopeSchema,
} from './schema.js';

/**
 * Deep research with typed stage handoffs (scope → plan → ledger → gaps → draft → publish).
 */
export const agentDefinition = defineAgent({
  id: 'deep-research',
  name: 'Deep Research',
  description:
    'Typed-handoff deep research: scope → plan → hunt → gaps → draft → publish MD/PDF.',
  createAgent(context: AgentBuildContext) {
    const model = resolveModel(
      selectModelRef(defaultCursorModelRef(), defaultGeminiModelRef()),
    );

    function cliOk(bin: string, args: string[]): boolean {
      try {
        execFileSync(bin, args, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }

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
    });
    const researchTools = [webSearch.createTool(), fetchPages];

    if (
      context.config('AGENT_ENV_GROK_X') !== '0' &&
      (cliOk('grok', ['--version']) || cliOk('grok', ['--help']))
    ) {
      researchTools.push(
        createGrokBuildXSearchConnector({
          id: 'x',
          model: context.config('AGENT_ENV_GROK_MODEL'),
          timeoutMs: 180_000,
        }).createTool(),
      );
    }

    const workRoots = new Set<string>();
    const fs = createWorkspaceFsTools({
      roots: () => [...workRoots],
      write: { approve: () => true },
    });
    const downloadUrl = createHttpDownloadTool({
      roots: () => [...workRoots],
    });
    const markdownToPdf = createMarkdownPdfTool({
      roots: () => [...workRoots],
    });
    const registerWorkspace = createGuardedTool({
      contract: {
        version: '1.0',
        name: 'register_workspace',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description:
        'Register the run workspace directory for download / write / PDF tools.',
      parameters: z.object({
        dir: z.string().describe('Absolute run workspace directory'),
      }),
      execute: ({ dir }) => {
        const abs = resolve(dir);
        workRoots.add(abs);
        return { status: 'success' as const, dir: abs };
      },
    });

    const hasXSearch = researchTools.some((t) => t.name === 'search_x');
    const xHuntHint = hasXSearch
      ? `Also use search_x for discourse / realtime claims when relevant.`
      : '';
    const xGapHint = hasXSearch
      ? `Use search_x for reaction/rumor holes when relevant.`
      : '';
    const xPlanHint = hasXSearch
      ? `Include search_x-oriented query ideas when a Qi needs public discourse.`
      : '';

    const emitScope = createEmitHandoffTool({
      name: 'emit_research_scope',
      fromAgent: 'research_scoper',
      toAgent: 'research_planner',
      outputSchema: RESEARCH_SCOPE_SCHEMA_ID,
      payloadSchema: researchScopeSchema,
      defaultObjective: 'Research scope for downstream planning',
      doneCriteria: ['successCriteria checkable', 'questions mapped'],
    });
    const emitPlan = createEmitHandoffTool({
      name: 'emit_research_plan',
      fromAgent: 'research_planner',
      toAgent: 'evidence_hunter',
      outputSchema: RESEARCH_PLAN_SCHEMA_ID,
      payloadSchema: researchPlanSchema,
      defaultObjective: 'Search plan for evidence hunt',
      doneCriteria: ['every Qi has queries'],
    });
    const emitLedger = createEmitHandoffTool({
      name: 'emit_evidence_ledger',
      fromAgent: 'evidence_hunter',
      toAgent: 'gap_filler',
      outputSchema: EVIDENCE_LEDGER_SCHEMA_ID,
      payloadSchema: evidenceLedgerSchema,
      defaultObjective: 'Evidence ledger from hunt',
      doneCriteria: ['findings grounded in tool output only'],
    });
    const emitGaps = createEmitHandoffTool({
      name: 'emit_gap_fill',
      fromAgent: 'gap_filler',
      toAgent: 'report_writer',
      outputSchema: GAP_FILL_SCHEMA_ID,
      payloadSchema: gapFillSchema,
      defaultObjective: 'Gap assessment after fill',
      doneCriteria: ['every criterion assessed'],
    });
    const emitDraft = createEmitHandoffTool({
      name: 'emit_draft_report',
      fromAgent: 'report_writer',
      toAgent: 'report_publisher',
      outputSchema: DRAFT_REPORT_SCHEMA_ID,
      payloadSchema: draftReportSchema,
      defaultObjective: 'Draft report markdown for publish',
      doneCriteria: ['markdown cites sources', 'no invented URLs'],
    });

    const scoper = new LlmAgent({
      name: 'research_scoper',
      model,
      description: 'Scope ask → typed ResearchScope handoff.',
      instruction: `SCOPING step. No search tools.

Optional: audience={audience?} decisionFocus={decisionFocus?}

Call emit_research_scope with payloadJson:
{
  "userIntent": "...",
  "audience": "...",
  "decisionFocus": "...",
  "successCriteria": ["By the end…", … 5–8],
  "questions": [{ "id": "Q1", "question": "...", "criterionRef": "…" }, … 6–10],
  "outOfScope": ["…"]
}
FINAL message = emit envelope. Do not invent facts.`,
      tools: [emitScope],
      outputKey: 'research_scope',
    });

    const planner = new LlmAgent({
      name: 'research_planner',
      model,
      description: 'Plan searches → typed ResearchPlan handoff.',
      instruction: `PLANNING step. No search tools.

Scope handoff:
{research_scope}

Call emit_research_plan with payloadJson:
{
  "items": [{
    "questionId": "Q1",
    "why": "…",
    "queries": ["…", "…"],
    "sourcePreferences": "…"
  }],
  "coverageChecklist": ["criterion → Qi …"]
}
${xPlanHint}
Prefer English queries for recall. FINAL = emit envelope.`,
      tools: [emitPlan],
      outputKey: 'research_plan',
    });

    const hunter = new LlmAgent({
      name: 'evidence_hunter',
      model,
      description: 'Hunt evidence → typed EvidenceLedger handoff.',
      instruction: `EVIDENCE HUNTER. Gather sources; do not write the report.

Scope:
{research_scope}
Plan:
{research_plan}

Use search_web / fetch_pages extensively (breadth then depth). ${xHuntHint}
Never invent URLs/facts.

Then call emit_evidence_ledger:
{
  "byQuestion": [{ "questionId": "Q1", "findings": ["… (url)"], "coverage": "strong|partial|weak" }],
  "sources": [{ "title": "…", "url": "https://…" }],
  "stillMissing": ["…"]
}
FINAL = emit envelope.`,
      tools: [...researchTools, emitLedger],
      outputKey: 'evidence_ledger',
    });

    const gapFiller = new LlmAgent({
      name: 'gap_filler',
      model,
      description: 'Fill gaps → typed GapFill handoff.',
      instruction: `GAP FILLER.

Scope:
{research_scope}
Ledger:
{evidence_ledger}

Assess each success criterion; search to fill PARTIAL/MISSING. ${xGapHint}

Call emit_gap_fill:
{
  "assessments": [{ "criterion": "…", "status": "COVERED|PARTIAL|MISSING", "reason": "…" }],
  "additionalFindings": ["… (url)"],
  "readyForWriting": true,
  "residualGaps": ["…"]
}
FINAL = emit envelope.`,
      tools: [...researchTools, emitGaps],
      outputKey: 'gap_fill',
    });

    const writer = new LlmAgent({
      name: 'report_writer',
      model,
      description: 'Write draft → typed DraftReport handoff.',
      instruction: `REPORT WRITER. One useful report from typed handoffs.

Scope: {research_scope}
Plan: {research_plan}
Ledger: {evidence_ledger}
Gaps: {gap_fill}

Write full markdown (cite URLs inline). Match user language (JP→Japanese).
Trailing sections required: ## Sources, ## Residual uncertainties, ## Success criteria check.
Optional ## Suggested figures with direct image URLs.

Call emit_draft_report:
{ "markdown": "<full md>", "suggestedFigures": ["https://…"] }
FINAL = emit envelope. Do not write files.`,
      tools: [emitDraft],
      outputKey: 'draft_report',
    });

    const publisher = new LlmAgent({
      name: 'report_publisher',
      model,
      description: 'Publish draft handoff to report.md + PDF.',
      instruction: `PUBLISHER. Workspace: {runWorkspaceDir}

Draft handoff (prefer JSON payload.markdown):
{draft_report}

Ledger (for figure URLs):
{evidence_ledger}

1. register_workspace(dir=runWorkspaceDir)
2. download up to 8 figure URLs → {runWorkspaceDir}/images
3. write_file final markdown → {runWorkspaceDir}/report.md (embed images; drop Suggested figures)
4. markdown_to_pdf → report.pdf
5. FINAL message = full report.md contents.`,
      tools: [registerWorkspace, downloadUrl, fs.writeFile, markdownToPdf],
    });

    return new SequentialAgent({
      name: 'deep_research',
      description:
        'Typed-handoff deep research: scope → plan → hunt → gaps → draft → publish.',
      subAgents: [scoper, planner, hunter, gapFiller, writer, publisher],
    });
  },
});
