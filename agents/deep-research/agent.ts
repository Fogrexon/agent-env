import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { LlmAgent, SequentialAgent } from '@google/adk';
import {
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

/**
 * True deep-research pipeline (Cursor SDK by default):
 *
 *   1. scoper     — decompose the ask; define what the final report must
 *                   enable the reader to know / decide
 *   2. planner    — turn those goals into research questions + search tactics
 *   3. hunter     — search hard (web + optional X, extract promising pages)
 *   4. gap_filler — compare evidence vs report goals; fill holes with more
 *                   targeted searches
 *   5. writer     — design a reader-useful structure, then write ONE report
 *   6. publisher  — download figures, write report.md + report.pdf
 *
 * Requires TAVILY_API_KEY (via context.secret). X search uses Grok Build when
 * `grok` is available (opt out with AGENT_ENV_GROK_X=0). Falls back to Gemini
 * when Cursor is unavailable. Search / extract / download / PDF go through
 * harness connectors — no agent-local vendor HTTP.
 */
export const agentDefinition = defineAgent({
  id: 'deep-research',
  name: 'Deep Research',
  description:
    'True deep research: scope → plan → hunt (web + X) → fill gaps → write → publish MD/PDF with figures.',
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

    /** Shared Tavily web search (advanced depth). Tool name: search_web. */
    const webSearch = createWebSearchConnector({
      provider: 'tavily',
      apiKey: tavilyKey,
      searchDepth: 'advanced',
      timeoutMs: 45_000,
    });

    /** Shared Tavily Extract. Tool name: fetch_pages. */
    const fetchPages = createTavilyExtractTool({
      apiKey: tavilyKey,
      timeoutMs: 60_000,
    });

    const researchTools = [webSearch.createTool(), fetchPages];

    // X search via Grok Build headless (auth via caller's `grok login`).
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

    /** Run workspace roots (fresh per createAgent invocation). */
    const workRoots = new Set<string>();

    const fs = createWorkspaceFsTools({
      roots: () => [...workRoots],
      write: {
        approve: () => true,
      },
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
        'Register the run workspace directory so download_url / write_file / markdown_to_pdf can use it.',
      parameters: z.object({
        dir: z
          .string()
          .describe('Absolute run workspace directory (runWorkspaceDir)'),
      }),
      execute: ({ dir }) => {
        const abs = resolve(dir);
        workRoots.add(abs);
        return { status: 'success' as const, dir: abs };
      },
    });

    const publishTools = [
      registerWorkspace,
      downloadUrl,
      fs.writeFile,
      markdownToPdf,
    ];

    const hasXSearch = researchTools.some((t) => t.name === 'search_x');
    const xHuntHint = hasXSearch
      ? `
5. Also use search_x when the ask involves public discourse, practitioner chatter,
   launch reactions, controversy, or "what people are saying now" on X/Twitter.
   Run several focused search_x queries (handles, product names, event keywords).
   Treat X as primary evidence for sentiment / realtime claims; still prefer
   web + fetch_pages for durable facts.`
      : '';
    const xGapHint = hasXSearch
      ? `
4. If a hole is about public reaction, rumor, or realtime practitioner opinion,
   run search_x as well as search_web.`
      : '';
    const xPlanHint = hasXSearch
      ? `
- When a Qi needs public discourse / realtime reaction, include search_x-oriented
  query ideas (handles, slogans, product+complaint, launch hashtags).`
      : '';

    /** 1. Scope: decompose + define what the report must achieve for the reader. */
    const scoper = new LlmAgent({
      name: 'research_scoper',
      model,
      description:
        'Decomposes the user ask and defines what the final report must enable the reader to know.',
      instruction: `You are the SCOPING step of a deep-research pipeline. No tool calls.

The user asked a research question. Your job is NOT to answer it yet. Your job is to
decide what a useful final report must accomplish.

Optional hints from the caller (may be empty):
- Intended audience: {audience?}
- Decision the report should support: {decisionFocus?}
If those are empty, infer a sensible audience and decision from the ask.

Output these sections exactly (use the headers):

## User intent
Restate the ask in one crisp paragraph. Who is the likely reader, and what decision
or understanding are they trying to reach?

## Report success criteria
List 5–8 concrete statements of the form:
"By the end of this report, the reader should be able to …"
These are the success criteria for the FINAL REPORT — not for this step.
Make them specific, checkable, and non-overlapping. Prefer decisions, comparisons,
trade-offs, and "what to do next" over vague topic coverage.

## Decomposed questions
Break the ask into 6–10 research questions that, if answered with evidence, would
satisfy every success criterion above. Number them Q1, Q2, …
Map each Qi to the success criterion it serves (e.g. "→ criterion 3").

## Out of scope
What the report should deliberately NOT try to cover (to stay useful, not encyclopedic).

Be precise. Do not invent facts. Do not search.`,
      outputKey: 'research_scope',
    });

    /** 2. Plan: search tactics per research question. */
    const planner = new LlmAgent({
      name: 'research_planner',
      model,
      description: 'Turns report goals into a concrete multi-query search plan.',
      instruction: `You are the PLANNING step. No tool calls.

Research scope (goals + questions):
{research_scope}

Produce a search plan that will gather enough primary evidence to satisfy every
Report success criterion. Output:

## Search plan
For each Qi from the scope, write:
- Qi (copy the question)
- Why it matters (1 sentence → which success criterion)
- Queries: 3–5 DISTINCT search queries (vary wording, year, source type:
  academic / vendor docs / standards / postmortem / comparison). Prefer English
  queries for recall even if the user wrote Japanese.
- Source preferences: what kinds of sources would be trustworthy here
- Extract candidates: what you'd want full-text of (papers, RFCs, official guides)${xPlanHint}

## Coverage checklist
A checklist of success criteria → which Qi's evidence will cover them.

Do not invent findings. Plan only.`,
      outputKey: 'research_plan',
    });

    /** 3. Hunt: search extensively and extract promising pages. */
    const hunter = new LlmAgent({
      name: 'evidence_hunter',
      model,
      description:
        'Exhaustive web search (+ X when available) and page extract against the plan.',
      instruction: `You are the EVIDENCE HUNTER. Your only job is to gather sources — not to write the report.

Research scope:
{research_scope}

Search plan:
{research_plan}

Mandatory behavior:
1. For EVERY Qi in the plan, run MOST of its listed queries via search_web
   (use a high limit). Do not skip questions. Do not stop after one good hit.
2. Across the whole hunt, aim for roughly 20–40 search_web calls if the plan
   warrants it. Breadth first, then depth.
3. From the hits, pick the most authoritative / primary URLs (prefer standards,
   papers, official docs, serious postmortems over SEO blog spam) and call
   fetch_pages in batches of up to 5. Extract at least 8–15 pages total when
   candidates exist.
4. If a query returns weak results, invent a better reformulation and search again
   (synonyms, narrower/wider scope, add year or "survey" / "RFC" / "OWASP" etc.).${xHuntHint}

Output format (after tools):

## Evidence ledger
For each Qi:
### Qi — <question>
- Finding bullets grounded ONLY in tool output, each ending with (url) when available.
  Preserve concrete detail from tool results — do not compress for brevity.
- Note conflicting claims if any
- Coverage: strong | partial | weak

## Source pool
Distinct URLs / posts you actually used, one per line: - title — url

## Still missing
Which success criteria / Qi still lack evidence (be honest).

Never invent URLs or facts. If a search fails or returns policy_denied, record it and continue.`,
      tools: researchTools,
      outputKey: 'evidence_ledger',
    });

    /** 4. Gap fill: chase holes relative to report success criteria. */
    const gapFiller = new LlmAgent({
      name: 'gap_filler',
      model,
      description: 'Compares evidence to report goals and fills remaining holes.',
      instruction: `You are the GAP FILLER. Compare what we have against what the report must achieve.

Research scope (esp. Report success criteria):
{research_scope}

Evidence so far:
{evidence_ledger}

Do this:
1. For each Report success criterion, mark: COVERED / PARTIAL / MISSING, with a
   one-line reason.
2. For every PARTIAL or MISSING item, run 2–4 NEW search_web queries that target
   the hole specifically, then fetch_pages on the best new URLs.
3. Do not re-search topics that are already strong unless you need a primary source
   to replace a weak secondary one.${xGapHint}

Output:

## Gap assessment
(criterion → COVERED|PARTIAL|MISSING + reason)

## Additional evidence
Only new findings from this step, grounded in tool output, with (url). Keep detail.

## Updated coverage
Status of every success criterion after the fills.

## Ready for writing?
YES if every criterion is COVERED or an honest PARTIAL with residual uncertainty
stated; otherwise say what is still missing (writer must disclose it).`,
      tools: researchTools,
      outputKey: 'gap_fill',
    });

    /** 5. Write: reader-useful structure → one report that meets the success criteria. */
    const writer = new LlmAgent({
      name: 'report_writer',
      model,
      description:
        'Designs a reader-useful structure and writes one evidence-grounded report.',
      instruction: `You are the REPORT WRITER. Produce ONE useful report for the reader — not a dump of notes.

Original user ask is in the conversation. Also use:

Research scope (intent + success criteria + questions):
{research_scope}

Search plan:
{research_plan}

Evidence ledger:
{evidence_ledger}

Gap fill:
{gap_fill}

Process (think, then write):
1. Mentally check that every Report success criterion can be answered from the
   evidence (or honestly marked uncertain).
2. Design a section structure that serves the READER's decision/understanding —
   not a mirror of the Qi list. Prefer: context → answer the ask → deep sections
   for trade-offs / how-to / risks → practical recommendations → open questions.
3. Write the full report in that structure.

Hard rules:
- Every non-trivial claim cites a source URL inline: (https://…).
- Do not invent facts or URLs. If evidence is weak, say so explicitly.
- Prefer synthesis and judgment over bullet spam. Use bullets where they help decisions.
- Length follows the evidence and success criteria — no artificial word-count cap;
  do not pad, and do not omit useful grounded detail to stay short.
- Match the user's language when they wrote in Japanese (report in Japanese);
  otherwise English.
- Do NOT download images or write files — the publisher step handles artifacts.
  You may note suggested figure URLs in a trailing "## Suggested figures" section
  (optional, up to 8 direct image URLs from evidence if clearly useful).

Required trailing sections (exact headers):

## Sources
Distinct URLs used, one per line.

## Residual uncertainties
What we still do not know, and why it matters.

## Success criteria check
For each Report success criterion from the scope: SATISFIED | PARTIAL | UNSATISFIED
with one sentence of justification.`,
      outputKey: 'draft_report',
    });

    /** 6. Publish: figures + report.md + report.pdf. */
    const publisher = new LlmAgent({
      name: 'report_publisher',
      model,
      description:
        'Downloads figures, writes report.md and report.pdf into the run workspace.',
      instruction: `You are the REPORT PUBLISHER. Turn the draft report into durable artifacts.

Run workspace directory (absolute):
{runWorkspaceDir}

Draft report:
{draft_report}

Evidence ledger (for finding figure URLs):
{evidence_ledger}

Mandatory steps (in order):
1. Call register_workspace with dir = the run workspace directory above.
2. From the draft (Suggested figures) and evidence, pick up to 8 useful FIGURE
   image URLs (diagrams, charts, screenshots of docs — NOT logos, favicons,
   tracking pixels, or generic stock). Prefer direct image URLs ending in
   .png/.jpg/.jpeg/.webp/.gif or clear CDN image paths.
3. For each selected URL, call download_url with:
   - url: the image URL
   - destPath: {runWorkspaceDir}/images  (directory)
   Skip failures and continue.
4. Produce the FINAL markdown:
   - Start from the draft report
   - Insert ![caption](images/<filename>) near the relevant section for each
     successful download (use the filename returned by download_url)
   - Remove "## Suggested figures" if present (figures are now embedded)
   - Keep Sources / Residual uncertainties / Success criteria check
5. write_file the final markdown to {runWorkspaceDir}/report.md
6. Call markdown_to_pdf with:
   - markdownPath: {runWorkspaceDir}/report.md
   - pdfPath: {runWorkspaceDir}/report.pdf
7. Your FINAL assistant message MUST be the full contents of report.md.
   Do not summarize.

If no images download successfully, still write report.md and PDF without figures.
If PDF generation fails, still return the full markdown (and note the PDF error
briefly at the very end only if needed — prefer succeeding silently when PDF works).`,
      tools: publishTools,
    });

    return new SequentialAgent({
      name: 'deep_research',
      description:
        'True deep research: scope → plan → hunt (web + X) → fill gaps → write → publish MD/PDF with figures.',
      subAgents: [scoper, planner, hunter, gapFiller, writer, publisher],
    });
  },
});
