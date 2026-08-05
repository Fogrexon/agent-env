import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  BaseAgent,
  LlmAgent,
  ParallelAgent,
  SequentialAgent,
  createEvent,
  type FunctionTool,
  type InvocationContext,
} from '@google/adk';
import {
  RUN_WORKSPACE_STATE_KEY,
  createEmitHandoffTool,
  createGrokBuildXSearchConnector,
  createTavilyExtractTool,
  createWebSearchConnector,
  defineAgent,
  isProviderConfigured,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { PANEL_TURN_SCHEMA_ID, panelTurnSchema } from './schema.js';

type DebateMode = 'standard' | 'max';

type Debater = {
  readonly id: string;
  readonly label: string;
  readonly model: string;
};

/** Mid-range Cursor SDK models (no *-fast variants). */
const STANDARD_DEBATERS: readonly Debater[] = [
  { id: 'grok', label: 'Grok 4.5', model: 'cursor-grok-4.5' },
  { id: 'terra', label: 'GPT-5.6 Terra', model: 'gpt-5.6-terra' },
  { id: 'sonnet', label: 'Claude Sonnet 5', model: 'claude-sonnet-5' },
  { id: 'gemini', label: 'Gemini 3.6 Flash', model: 'gemini-3.6-flash' },
] as const;

/** Frontier Cursor SDK panel for Max Mode. */
const MAX_DEBATERS: readonly Debater[] = [
  { id: 'grok', label: 'Grok 4.5', model: 'cursor-grok-4.5' },
  { id: 'sol', label: 'GPT-5.6 Sol', model: 'gpt-5.6-sol' },
  { id: 'opus', label: 'Claude Opus 5', model: 'claude-opus-5' },
  { id: 'gemini', label: 'Gemini 3.1 Pro', model: 'gemini-3.1-pro' },
] as const;

const STANDARD_SYNTH = {
  model: 'gpt-5.6-sol',
  label: 'GPT-5.6 Sol',
} as const;

/** Max Mode chair: Opus after the frontier panel. */
const MAX_SYNTH = {
  model: 'claude-opus-5',
  label: 'Claude Opus 5',
} as const;

function resolveDebateMode(inputs: Readonly<Record<string, unknown>> | undefined): DebateMode {
  const raw = inputs?.['mode'];
  return raw === 'max' ? 'max' : 'standard';
}

function stateText(state: Record<string, unknown>, key: string): string {
  const value = state[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Deterministic Max Mode step: dump each panelist's opening + rebuttal into
 * the run workspace as markdown artifacts (no LLM rewrite).
 */
class DebateTranscriptExporter extends BaseAgent {
  readonly #debaters: readonly Debater[];

  constructor(debaters: readonly Debater[]) {
    super({
      name: 'super_debate_export',
      description:
        'Writes full per-panelist opening + rebuttal transcripts into the run workspace.',
    });
    this.#debaters = debaters;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
    const state = context.session.state;
    const workspaceRaw = state[RUN_WORKSPACE_STATE_KEY];
    if (typeof workspaceRaw !== 'string' || !workspaceRaw.trim()) {
      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {
          role: 'model',
          parts: [
            {
              text: 'Debate transcript export skipped: runWorkspaceDir is missing.',
            },
          ],
        },
      });
      return;
    }

    const workspaceDir = resolve(workspaceRaw.trim());
    const debateDir = join(workspaceDir, 'debate');
    mkdirSync(debateDir, { recursive: true });

    const written: string[] = [];
    for (const d of this.#debaters) {
      const opening = stateText(state, `${d.id}_opening`);
      const rebuttal = stateText(state, `${d.id}_rebuttal`);
      const body = [
        `# ${d.label} — full debate transcript`,
        '',
        `Model: \`${d.model}\``,
        '',
        '## Opening',
        '',
        opening || '_(empty)_',
        '',
        '## Rebuttal',
        '',
        rebuttal || '_(empty)_',
        '',
      ].join('\n');
      const filename = `debate-${d.id}.md`;
      writeFileSync(join(debateDir, filename), body, 'utf8');
      // Flat copies so artifact graders (stem === id) can find them.
      writeFileSync(join(workspaceDir, filename), body, 'utf8');
      written.push(filename);
    }

    yield createEvent({
      invocationId: context.invocationId,
      author: this.name,
      content: {
        role: 'model',
        parts: [
          {
            text: `Wrote ${written.length} debate transcript artifact(s): ${written.join(', ')}`,
          },
        ],
      },
    });
  }

  protected async *runLiveImpl(
    context: InvocationContext,
  ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
    yield* this.runAsyncImpl(context);
  }
}

/**
 * Super Debate — Cursor-backed multi-model panel:
 *
 *   1. opening  — four models open in parallel
 *   2. rebuttal — each responds to the others in parallel
 *   3. (max)    — full per-panelist transcripts written to workspace
 *   4. synth    — chair model summarizes positions + final conclusion
 *
 * Mode (`standard` | `max`) comes from AgentParams `mode`.
 * Optional tools: Tavily web search / extract, Grok Build X search.
 */
export const agentDefinition = defineAgent({
  id: 'super-debate',
  name: 'Super Debate',
  description:
    'Typed-handoff multi-model debate on Cursor. Standard: mid-range panel + Sol synth. Max: frontier panel, transcript artifacts, Opus synth.',
  limits: {
    maxSteps: 160,
    maxToolCalls: 200,
    maxWallSeconds: 3600,
    maxRepairs: 0,
  },
  verification: {
    checks: [
      verify.nonEmpty({ severity: 'advisory' }),
      verify.contains({ text: 'Final conclusion', severity: 'advisory' }),
    ],
  },
  createAgent(context: AgentBuildContext) {
    if (!isProviderConfigured('cursor')) {
      throw new Error(
        'super-debate requires CURSOR_API_KEY (Cursor SDK multi-model debate).',
      );
    }

    const mode = resolveDebateMode(context.inputs);
    const isMax = mode === 'max';
    const debaters = isMax ? MAX_DEBATERS : STANDARD_DEBATERS;
    const synthMeta = isMax ? MAX_SYNTH : STANDARD_SYNTH;

    function cliOk(bin: string, args: string[]): boolean {
      try {
        execFileSync(bin, args, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }

    const debateTools: FunctionTool[] = [];
    const toolNames: string[] = [];

    const tavilyKey = context.secret('TAVILY_API_KEY')?.trim();
    if (tavilyKey) {
      const web = createWebSearchConnector({
        provider: 'tavily',
        apiKey: () => context.secret('TAVILY_API_KEY'),
        searchDepth: 'advanced',
        timeoutMs: 45_000,
      });
      debateTools.push(web.createTool());
      toolNames.push('search_web');

      debateTools.push(
        createTavilyExtractTool({
          apiKey: () => context.secret('TAVILY_API_KEY'),
          timeoutMs: 60_000,
        }),
      );
      toolNames.push('fetch_pages');
    }

    if (
      context.config('AGENT_ENV_GROK_X') !== '0' &&
      (cliOk('grok', ['--version']) || cliOk('grok', ['--help']))
    ) {
      debateTools.push(
        createGrokBuildXSearchConnector({
          id: 'x',
          model: context.config('AGENT_ENV_GROK_MODEL'),
          timeoutMs: 180_000,
        }).createTool(),
      );
      toolNames.push('search_x');
    }

    const toolsHint =
      toolNames.length > 0
        ? `You MAY call tools (${toolNames.join(', ')}) before emitting the handoff. Prefer ${isMax ? '2–5' : '1–3'} focused searches; put URLs in evidence[].source. Do not invent citations.`
        : `No search tools this run — argue from general knowledge and label uncertainty. Do not invent URLs.`;

    const docsHint = `If the user attached reference documents ([attachment: ...]), ground claims in them and cite as [attachment: <name>].`;

    const depthHint = isMax
      ? `Max Mode: prefer depth and explicit trade-offs; no filler.`
      : `Be crisp and substantive.`;

    const openingAgents = debaters.map((d) => {
      const emitName = `emit_${d.id}_opening`;
      const emit = createEmitHandoffTool({
        name: emitName,
        fromAgent: `${d.id}_opening`,
        toAgent: 'super_debate_synth',
        outputSchema: PANEL_TURN_SCHEMA_ID,
        payloadSchema: panelTurnSchema,
        defaultObjective: `${d.label} opening`,
        doneCriteria: ['payload is PanelTurn', 'clear stance'],
      });
      return new LlmAgent({
        name: `${d.id}_opening`,
        model: `cursor:${d.model}`,
        description: `${d.label} opening (typed handoff).`,
        instruction: `You are panelist ${d.label} (Cursor model: ${d.model}). Take a clear stance on the user's topic.

${depthHint}
${toolsHint}
${docsHint}

After tools, call ${emitName} ONCE with payloadJson:
{
  "panelistId": "${d.id}",
  "panelistLabel": "${d.label}",
  "round": "opening",
  "stance": "…",
  "claims": [{ "text": "…", "warrant": "…" }],
  "evidence": [{ "fact": "…", "source": "…" }],
  "engagement": [],
  "closing": "…"
}
Aim for ${isMax ? '5–8' : '3–4'} claims. FINAL message = emit envelope.`,
        tools: [...debateTools, emit],
        outputKey: `${d.id}_opening`,
      });
    });

    const opening = new ParallelAgent({
      name: 'super_debate_opening',
      description: isMax
        ? 'Frontier panel opening handoffs (Max Mode).'
        : 'Mid-range panel opening handoffs.',
      subAgents: openingAgents,
    });

    const rebuttalAgents = debaters.map((d) => {
      const othersBlock = debaters
        .filter((o) => o.id !== d.id)
        .map((o) => `### ${o.label}\n{${o.id}_opening?}`)
        .join('\n\n');
      const emitName = `emit_${d.id}_rebuttal`;
      const emit = createEmitHandoffTool({
        name: emitName,
        fromAgent: `${d.id}_rebuttal`,
        toAgent: 'super_debate_synth',
        outputSchema: PANEL_TURN_SCHEMA_ID,
        payloadSchema: panelTurnSchema,
        defaultObjective: `${d.label} rebuttal`,
        doneCriteria: ['payload is PanelTurn', 'engagement filled'],
      });
      return new LlmAgent({
        name: `${d.id}_rebuttal`,
        model: `cursor:${d.model}`,
        description: `${d.label} rebuttal (typed handoff).`,
        instruction: `You are the same panelist (${d.label}). Engage other openings via typed handoff.

${depthHint}

Your opening handoff:
{${d.id}_opening?}

Other openings:
${othersBlock}

${toolsHint}
${docsHint}

Call ${emitName} with:
{
  "panelistId": "${d.id}",
  "panelistLabel": "${d.label}",
  "round": "rebuttal",
  "stance": "…",
  "claims": [{ "text": "…", "warrant": "…" }],
  "evidence": [{ "fact": "…", "source": "…" }],
  "engagement": [{ "panelistId": "<other id>", "accept": "…", "reject": "…", "refine": "…" }],
  "closing": "…"
}
FINAL message = emit envelope.`,
        tools: [...debateTools, emit],
        outputKey: `${d.id}_rebuttal`,
      });
    });

    const rebuttal = new ParallelAgent({
      name: 'super_debate_rebuttal',
      description: isMax
        ? 'Frontier panel rebuttal handoffs (Max Mode).'
        : 'Panel rebuttal handoffs.',
      subAgents: rebuttalAgents,
    });

    const transcriptBlock = debaters
      .map(
        (d) => `### ${d.label} — opening handoff
{${d.id}_opening?}

### ${d.label} — rebuttal handoff
{${d.id}_rebuttal?}`,
      )
      .join('\n\n');

    const synthInstruction = isMax
      ? `You are an impartial synthesizer (${synthMeta.label}). Read typed PanelTurn handoff envelopes (prefer JSON payloads). Do not invent facts outside them / attachments.

## Transcript handoffs

${transcriptBlock}

## Required output (markdown)

Match user language; keep English section headers.

### Panel positions
For each (${debaters.map((d) => d.label).join(', ')}): final stance, strongest unrebutted claims, concessions, residual weakness.

### Clash points
4–7 decisive disagreements with who won and why.

### Evidence quality
Who grounded claims better.

### Minority / dissent
Constraining minority points if any.

### Final conclusion
Clear verdict + confidence (low/medium/high).

### Rationale
10–16 sentences grounded in payloads.

### Practical takeaway
2–3 actionable sentences.`
      : `You are an impartial synthesizer (${synthMeta.label}). Read typed PanelTurn handoff envelopes (prefer JSON payloads). Do not invent facts outside them / attachments.

## Transcript handoffs

${transcriptBlock}

## Required output (markdown)

Match user language; keep English section headers.

### Panel positions (brief)
For each (${debaters.map((d) => d.label).join(', ')}): stance, strongest claims, concessions.

### Clash points
2–4 disagreements and who was stronger.

### Evidence quality
Who grounded claims better.

### Final conclusion
Clear verdict + confidence (low/medium/high).

### Rationale
5–8 sentences grounded in payloads.

### Practical takeaway
One actionable sentence.`;

    const synth = new LlmAgent({
      name: 'super_debate_synth',
      model: `cursor:${synthMeta.model}`,
      description: `Impartial synthesizer (${synthMeta.label} / ${synthMeta.model}).`,
      instruction: synthInstruction,
    });

    const subAgents = isMax
      ? [opening, rebuttal, new DebateTranscriptExporter(debaters), synth]
      : [opening, rebuttal, synth];

    return new SequentialAgent({
      name: 'super_debate',
      description: isMax
        ? 'Max Mode typed-handoff: frontier opening → rebuttal → transcript export → Opus synthesis.'
        : 'Typed-handoff multi-model opening → rebuttal → Sol synthesis.',
      subAgents,
    });
  },
});
