import { execFileSync } from 'node:child_process';
import { LlmAgent, ParallelAgent, SequentialAgent, type FunctionTool } from '@google/adk';
import {
  createGrokBuildXSearchConnector,
  createTavilyExtractTool,
  createWebSearchConnector,
  defaultCursorModelRef,
  defineAgent,
  isProviderConfigured,
  resolveModel,
  type AgentBuildContext,
} from '@agent-env/harness';

/** Mid-range Cursor SDK models (no *-fast variants). */
const DEBATERS = [
  { id: 'grok', label: 'Grok 4.5', model: 'cursor-grok-4.5' },
  { id: 'terra', label: 'GPT-5.6 Terra', model: 'gpt-5.6-terra' },
  { id: 'sonnet', label: 'Claude Sonnet 5', model: 'claude-sonnet-5' },
  { id: 'gemini', label: 'Gemini 3.6 Flash', model: 'gemini-3.6-flash' },
] as const;

const SYNTH_MODEL = 'gpt-5.6-sol';

/**
 * Super Debate — Cursor-backed multi-model panel:
 *
 *   1. opening  — four mid-range models open in parallel
 *   2. rebuttal — each responds to the others in parallel
 *   3. synth    — GPT-5.6 Sol summarizes positions + final conclusion
 *
 * Optional tools: Tavily web search / extract, Grok Build X search.
 */
export const agentDefinition = defineAgent({
  id: 'super-debate',
  name: 'Super Debate',
  description:
    'Parallel multi-model debate on Cursor (Grok 4.5, GPT-5.6 Terra, Sonnet 5, Gemini 3.6 Flash) with GPT-5.6 Sol synthesis.',
  createAgent(context: AgentBuildContext) {
    if (!isProviderConfigured('cursor')) {
      throw new Error(
        'super-debate requires CURSOR_API_KEY (Cursor SDK multi-model debate).',
      );
    }

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
        ? `You MAY call tools (${toolNames.join(', ')}) to find or verify evidence before writing. Prefer 1–3 focused searches; cite URLs when you used a tool. Do not invent citations.`
        : `No search tools are available this run — argue from general knowledge and label uncertainty clearly. Do not invent URLs.`;

    const openingFormat = `Output markdown only (no preamble):

## Stance
<one crisp sentence: your position on the topic>

## Claims
1. <claim> — <1–2 sentence warrant>
2. …
(aim for 3–4 claims)

## Evidence
- <fact or quote> — <source / URL if searched>

## Closing
<one sentence stake in the ground>`;

    const rebuttalFormat = `Output markdown only (no preamble):

## Updated stance
<keep or revise your stance in one sentence>

## Engagement
For each other panelist, 1–2 bullets: what you accept, reject, or refine (quote briefly).

## Reinforced case
2–4 bullets that still stand after this exchange

## Evidence
- <fact or quote> — <source / URL if searched>

## Closing
<one crisp closing line for the synthesizer>`;

    const openingAgents = DEBATERS.map(
      (d) =>
        new LlmAgent({
          name: `${d.id}_opening`,
          model: resolveModel(defaultCursorModelRef(d.model)),
          description: `${d.label} opening statement.`,
          instruction: `You are a debate panelist powered by ${d.label} (Cursor model id: ${d.model}).
Argue the user's topic / proposition with intellectual honesty. Take a clear stance — do not sit on the fence.
You are NOT coordinating with other models in this round; write your own best case.

${toolsHint}

${openingFormat}`,
          tools: debateTools,
          outputKey: `${d.id}_opening`,
        }),
    );

    const opening = new ParallelAgent({
      name: 'super_debate_opening',
      description: 'Four mid-range models open in parallel.',
      subAgents: openingAgents,
    });

    const rebuttalAgents = DEBATERS.map((d) => {
      const othersBlock = DEBATERS.filter((o) => o.id !== d.id)
        .map((o) => `### ${o.label}\n{${o.id}_opening?}`)
        .join('\n\n');

      return new LlmAgent({
        name: `${d.id}_rebuttal`,
        model: resolveModel(defaultCursorModelRef(d.model)),
        description: `${d.label} rebuttal / engagement.`,
        instruction: `You are the same panelist (${d.label}). Engage the other openings. Stay rigorous; update your stance only if warranted.

Your opening:
{${d.id}_opening?}

Other panelists' openings:
${othersBlock}

${toolsHint}

${rebuttalFormat}`,
        tools: debateTools,
        outputKey: `${d.id}_rebuttal`,
      });
    });

    const rebuttal = new ParallelAgent({
      name: 'super_debate_rebuttal',
      description: 'Four models respond to each other in parallel.',
      subAgents: rebuttalAgents,
    });

    const transcriptBlock = DEBATERS.map(
      (d) => `### ${d.label} — opening
{${d.id}_opening?}

### ${d.label} — rebuttal
{${d.id}_rebuttal?}`,
    ).join('\n\n');

    const synth = new LlmAgent({
      name: 'super_debate_synth',
      model: resolveModel(defaultCursorModelRef(SYNTH_MODEL)),
      description: `Impartial synthesizer (GPT-5.6 Sol / ${SYNTH_MODEL}).`,
      instruction: `You are an impartial synthesizer (GPT-5.6 Sol). Read the full multi-model debate transcript. Do not invent facts outside it. Prefer better-evidenced and better-rebutted arguments.

## Transcript

${transcriptBlock}

## Required output (markdown)

Write for a reader who did not see the debate.

### Panel positions (brief)
For each panelist (${DEBATERS.map((d) => d.label).join(', ')}), 2–4 bullets:
- Final stance (one line)
- Strongest unrebutted claim(s)
- Notable concession or revision (if any)

### Clash points
2–4 decisive disagreements and who had the stronger case on each.

### Evidence quality
Who grounded claims better (citations / specificity). Mark weak or unsupported claims.

### Final conclusion
One clear recommendation or verdict on the original topic (not a hedged both-sides paragraph). Include confidence: low / medium / high.

### Rationale
5–8 sentences grounded in the transcript. Name what tipped the scale.

### Practical takeaway
One sentence a decision-maker can act on.`,
    });

    return new SequentialAgent({
      name: 'super_debate',
      description:
        'Parallel multi-model opening → parallel rebuttal → Sol synthesis.',
      subAgents: [opening, rebuttal, synth],
    });
  },
});
