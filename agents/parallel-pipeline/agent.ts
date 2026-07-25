import { execFileSync } from 'node:child_process';
import { LlmAgent, ParallelAgent, SequentialAgent, type FunctionTool } from '@google/adk';
import {
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  type ModelRef,
} from '@agent-env/shared';
import {
  createGrokBuildXSearchConnector,
  createTavilyExtractTool,
  createWebSearchConnector,
  defaultCursorModelRef,
  defineAgent,
  parseModelRef,
  resolveModel,
  selectModelRef,
  type AgentBuildContext,
} from '@agent-env/harness';

/**
 * Structured debate demo (Cursor SDK by default):
 *
 *   1. opening   — PRO / CON open in parallel (claims + evidence)
 *   2. rebuttal1 — each side rebuts the other in parallel
 *   3. rebuttal2 — second exchange in parallel
 *   4. judge     — impartial verdict from the full transcript
 *
 * Debaters may reinforce claims via web search / page extract / optional X
 * search (Tavily + Grok Build). Override per role via config:
 *   AGENT_ENV_PROS_MODEL / AGENT_ENV_CONS_MODEL / AGENT_ENV_JUDGE_MODEL
 */
export const agentDefinition = defineAgent({
  id: 'parallel-pipeline',
  name: 'Parallel Pipeline',
  description:
    'Multi-round PRO/CON debate with search-backed rebuttals, then a judge verdict.',
  createAgent(context: AgentBuildContext) {
    function refFromConfig(key: string, fallback: ModelRef): ModelRef {
      return parseModelRef(context.config(key), fallback);
    }

    function cliOk(bin: string, args: string[]): boolean {
      try {
        execFileSync(bin, args, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }

    const cursorPreferred = defaultCursorModelRef(
      context.config('AGENT_ENV_CURSOR_MODEL')?.trim() || DEFAULT_CURSOR_MODEL,
    );

    const geminiFallback: ModelRef = {
      provider: 'gemini',
      model: DEFAULT_GEMINI_MODEL,
    };

    const cursorOrGemini = selectModelRef(cursorPreferred, geminiFallback);

    const prosRef = refFromConfig('AGENT_ENV_PROS_MODEL', cursorOrGemini);
    const consRef = refFromConfig('AGENT_ENV_CONS_MODEL', cursorOrGemini);
    const judgeRef = refFromConfig(
      'AGENT_ENV_JUDGE_MODEL',
      refFromConfig('AGENT_ENV_SYNTH_MODEL', cursorOrGemini),
    );

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

## Claims
1. <claim> — <1–2 sentence warrant>
2. …
(aim for {maxClaims?} claims; default 3–4)

## Evidence
- <fact or quote> — <source / URL if searched>

## Closing
<one sentence stake in the ground>`;

    const rebuttalFormat = `Output markdown only (no preamble):

## Target
- Which opponent claims you are answering (quote or paraphrase briefly)

## Rebuttals
1. <counter> — why their claim fails or is incomplete
2. …

## Reinforced case
- What still stands on your side after this exchange

## Evidence
- <fact or quote> — <source / URL if searched>`;

    const prosOpening = new LlmAgent({
      name: 'pros_opening',
      model: resolveModel(prosRef),
      description: `PRO opening statement (provider=${prosRef.provider}).`,
      instruction: `You are the PRO advocate in a structured debate.
Argue FOR the user's proposition / topic. Build the strongest affirmative case.

${toolsHint}

${openingFormat}`,
      tools: debateTools,
      outputKey: 'pros_opening',
    });

    const consOpening = new LlmAgent({
      name: 'cons_opening',
      model: resolveModel(consRef),
      description: `CON opening statement (provider=${consRef.provider}).`,
      instruction: `You are the CON advocate in a structured debate.
Argue AGAINST the user's proposition / topic. Build the strongest negative case (risks, costs, failure modes, counter-evidence).

${toolsHint}

${openingFormat}`,
      tools: debateTools,
      outputKey: 'cons_opening',
    });

    const opening = new ParallelAgent({
      name: 'debate_opening',
      description: 'PRO and CON open in parallel.',
      subAgents: [prosOpening, consOpening],
    });

    const prosRebuttal1 = new LlmAgent({
      name: 'pros_rebuttal_1',
      model: resolveModel(prosRef),
      description: 'PRO first rebuttal of CON opening.',
      instruction: `You are the PRO advocate. Rebut the CON opening. Stay on the PRO side.

Your opening:
{pros_opening?}

Opponent opening (CON):
{cons_opening?}

${toolsHint}

${rebuttalFormat}`,
      tools: debateTools,
      outputKey: 'pros_rebuttal_1',
    });

    const consRebuttal1 = new LlmAgent({
      name: 'cons_rebuttal_1',
      model: resolveModel(consRef),
      description: 'CON first rebuttal of PRO opening.',
      instruction: `You are the CON advocate. Rebut the PRO opening. Stay on the CON side.

Your opening:
{cons_opening?}

Opponent opening (PRO):
{pros_opening?}

${toolsHint}

${rebuttalFormat}`,
      tools: debateTools,
      outputKey: 'cons_rebuttal_1',
    });

    const rebuttal1 = new ParallelAgent({
      name: 'debate_rebuttal_1',
      description: 'First parallel rebuttal exchange.',
      subAgents: [prosRebuttal1, consRebuttal1],
    });

    const prosRebuttal2 = new LlmAgent({
      name: 'pros_rebuttal_2',
      model: resolveModel(prosRef),
      description: 'PRO second rebuttal (final exchange).',
      instruction: `You are the PRO advocate in the final rebuttal round. Answer CON's latest rebuttal and close your case.

Your opening:
{pros_opening?}

Your prior rebuttal:
{pros_rebuttal_1?}

Opponent latest (CON rebuttal 1):
{cons_rebuttal_1?}

${toolsHint}

${rebuttalFormat}
End with one crisp closing line for the judge.`,
      tools: debateTools,
      outputKey: 'pros_rebuttal_2',
    });

    const consRebuttal2 = new LlmAgent({
      name: 'cons_rebuttal_2',
      model: resolveModel(consRef),
      description: 'CON second rebuttal (final exchange).',
      instruction: `You are the CON advocate in the final rebuttal round. Answer PRO's latest rebuttal and close your case.

Your opening:
{cons_opening?}

Your prior rebuttal:
{cons_rebuttal_1?}

Opponent latest (PRO rebuttal 1):
{pros_rebuttal_1?}

${toolsHint}

${rebuttalFormat}
End with one crisp closing line for the judge.`,
      tools: debateTools,
      outputKey: 'cons_rebuttal_2',
    });

    const rebuttal2 = new ParallelAgent({
      name: 'debate_rebuttal_2',
      description: 'Second parallel rebuttal exchange.',
      subAgents: [prosRebuttal2, consRebuttal2],
    });

    const judge = new LlmAgent({
      name: 'debate_judge',
      model: resolveModel(judgeRef),
      description: `Impartial judge (provider=${judgeRef.provider}).`,
      instruction: `You are an impartial debate judge. Decide from the transcript only — do not invent new facts outside it. Prefer arguments that were better evidenced and better rebutted.

## Transcript

### PRO opening
{pros_opening?}

### CON opening
{cons_opening?}

### PRO rebuttal 1
{pros_rebuttal_1?}

### CON rebuttal 1
{cons_rebuttal_1?}

### PRO rebuttal 2
{pros_rebuttal_2?}

### CON rebuttal 2
{cons_rebuttal_2?}

## Required output (markdown)

The report must let a reader who never saw the debate follow how it unfolded,
so write the round log BEFORE judging and keep it strictly neutral there.

### Round 1 — Opening
**PRO:** 2–3 bullets, one line each (≤25 words), each the actual claim + its warrant.
**CON:** same.

### Round 2 — First rebuttal
**PRO:** 2–3 bullets — what it attacked in CON's opening and with what counter.
**CON:** same, against PRO's opening.

### Round 3 — Final rebuttal
**PRO:** 2–3 bullets — final answers plus the closing line.
**CON:** same.

Round log rules: faithful paraphrase only (no new arguments, no verdict language),
keep each side's strongest cited source in parentheses when one was used, and mark
a side "no substantive reply" when it dropped an argument.

### Clash points
2–4 decisive clash points and who won each.

### Evidence quality
Who grounded claims better (citations / specificity).

### Verdict
One of: **PRO wins** | **CON wins** | **Split decision**
Include a confidence (low / medium / high).

### Rationale
5–8 sentences grounded in the transcript. Name the strongest unrebutted point that tipped the scale (or why the split).

### Recommendation
One sentence practical takeaway for someone deciding the original topic.`,
    });

    return new SequentialAgent({
      name: 'parallel_pipeline',
      description:
        'Opening → two rebuttal rounds (parallel PRO/CON) → judge verdict.',
      subAgents: [opening, rebuttal1, rebuttal2, judge],
    });
  },
});
