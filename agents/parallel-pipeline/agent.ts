import { execFileSync } from 'node:child_process';
import {
  LlmAgent,
  ParallelAgent,
  SequentialAgent,
  type FunctionTool,
} from '@google/adk';
import {
  DEFAULT_CURSOR_MODEL,
  DEFAULT_GEMINI_MODEL,
  type ModelRef,
} from '@agent-env/shared';
import {
  createEmitHandoffTool,
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
import {
  DEBATE_TURN_SCHEMA_ID,
  debateTurnSchema,
  type DebateTurn,
} from './schema.js';

/**
 * Structured debate with typed handoff artifacts between rounds.
 *
 *   opening → rebuttal1 → rebuttal2 → judge
 * Each PRO/CON turn must emit a DebateTurn handoff (digest + schema).
 */
export const agentDefinition = defineAgent({
  id: 'parallel-pipeline',
  name: 'Parallel Pipeline',
  description:
    'Multi-round PRO/CON debate with typed DebateTurn handoffs, then a judge verdict.',
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
        ? `You MAY call tools (${toolNames.join(', ')}) before emitting the handoff. Prefer 1–3 focused searches; put URLs in evidence[].source. Do not invent citations.`
        : `No search tools this run — argue from general knowledge and label uncertainty. Do not invent URLs.`;

    const docsHint = `If the user attached reference documents ([attachment: ...]), ground claims in them and cite as [attachment: <name>].`;

    function emitTurn(opts: {
      name: string;
      fromAgent: string;
      toAgent: string;
      side: DebateTurn['side'];
      round: DebateTurn['round'];
    }) {
      return createEmitHandoffTool({
        name: opts.name,
        fromAgent: opts.fromAgent,
        toAgent: opts.toAgent,
        outputSchema: DEBATE_TURN_SCHEMA_ID,
        payloadSchema: debateTurnSchema,
        defaultObjective: `${opts.side.toUpperCase()} ${opts.round}`,
        doneCriteria: [
          'payload matches DebateTurn schema',
          'claims grounded; evidence sources real when present',
        ],
        description: `Emit typed DebateTurn handoff (${opts.side} / ${opts.round}).`,
      });
    }

    function turnInstruction(opts: {
      side: DebateTurn['side'];
      round: DebateTurn['round'];
      emitName: string;
      contextBlock: string;
    }): string {
      const sideLabel = opts.side === 'pro' ? 'PRO (FOR)' : 'CON (AGAINST)';
      return `You are the ${sideLabel} advocate in a typed-handoff debate (${opts.round}).

${opts.contextBlock}

${toolsHint}

${docsHint}

After tools (if any), call ${opts.emitName} ONCE with payloadJson matching:
{
  "side": "${opts.side}",
  "round": "${opts.round}",
  "claims": [{ "text": "...", "warrant": "..." }],
  "evidence": [{ "fact": "...", "source": "url or attachment name" }],
  "targets": ["opponent claim paraphrases — required for rebuttal rounds, else []"],
  "closing": "one sentence"
}
Aim for 3–4 claims. Do not invent sources.

Your FINAL message MUST be the envelope string returned by ${opts.emitName}.`;
    }

    const emitProsOpening = emitTurn({
      name: 'emit_pros_opening',
      fromAgent: 'pros_opening',
      toAgent: 'debate_judge',
      side: 'pro',
      round: 'opening',
    });
    const emitConsOpening = emitTurn({
      name: 'emit_cons_opening',
      fromAgent: 'cons_opening',
      toAgent: 'debate_judge',
      side: 'con',
      round: 'opening',
    });
    const emitProsR1 = emitTurn({
      name: 'emit_pros_rebuttal_1',
      fromAgent: 'pros_rebuttal_1',
      toAgent: 'debate_judge',
      side: 'pro',
      round: 'rebuttal_1',
    });
    const emitConsR1 = emitTurn({
      name: 'emit_cons_rebuttal_1',
      fromAgent: 'cons_rebuttal_1',
      toAgent: 'debate_judge',
      side: 'con',
      round: 'rebuttal_1',
    });
    const emitProsR2 = emitTurn({
      name: 'emit_pros_rebuttal_2',
      fromAgent: 'pros_rebuttal_2',
      toAgent: 'debate_judge',
      side: 'pro',
      round: 'rebuttal_2',
    });
    const emitConsR2 = emitTurn({
      name: 'emit_cons_rebuttal_2',
      fromAgent: 'cons_rebuttal_2',
      toAgent: 'debate_judge',
      side: 'con',
      round: 'rebuttal_2',
    });

    const prosOpening = new LlmAgent({
      name: 'pros_opening',
      model: resolveModel(prosRef),
      description: `PRO opening (typed handoff).`,
      instruction: turnInstruction({
        side: 'pro',
        round: 'opening',
        emitName: 'emit_pros_opening',
        contextBlock: 'Argue FOR the user proposition. Build the affirmative case.',
      }),
      tools: [...debateTools, emitProsOpening],
      outputKey: 'pros_opening',
    });

    const consOpening = new LlmAgent({
      name: 'cons_opening',
      model: resolveModel(consRef),
      description: `CON opening (typed handoff).`,
      instruction: turnInstruction({
        side: 'con',
        round: 'opening',
        emitName: 'emit_cons_opening',
        contextBlock:
          'Argue AGAINST the user proposition (risks, costs, failure modes).',
      }),
      tools: [...debateTools, emitConsOpening],
      outputKey: 'cons_opening',
    });

    const prosRebuttal1 = new LlmAgent({
      name: 'pros_rebuttal_1',
      model: resolveModel(prosRef),
      description: 'PRO first rebuttal (typed handoff).',
      instruction: turnInstruction({
        side: 'pro',
        round: 'rebuttal_1',
        emitName: 'emit_pros_rebuttal_1',
        contextBlock: `Your opening handoff:
{pros_opening?}

Opponent CON opening handoff:
{cons_opening?}

Rebut CON; stay PRO.`,
      }),
      tools: [...debateTools, emitProsR1],
      outputKey: 'pros_rebuttal_1',
    });

    const consRebuttal1 = new LlmAgent({
      name: 'cons_rebuttal_1',
      model: resolveModel(consRef),
      description: 'CON first rebuttal (typed handoff).',
      instruction: turnInstruction({
        side: 'con',
        round: 'rebuttal_1',
        emitName: 'emit_cons_rebuttal_1',
        contextBlock: `Your opening handoff:
{cons_opening?}

Opponent PRO opening handoff:
{pros_opening?}

Rebut PRO; stay CON.`,
      }),
      tools: [...debateTools, emitConsR1],
      outputKey: 'cons_rebuttal_1',
    });

    const prosRebuttal2 = new LlmAgent({
      name: 'pros_rebuttal_2',
      model: resolveModel(prosRef),
      description: 'PRO final rebuttal (typed handoff).',
      instruction: turnInstruction({
        side: 'pro',
        round: 'rebuttal_2',
        emitName: 'emit_pros_rebuttal_2',
        contextBlock: `Your prior handoffs:
{pros_opening?}
{pros_rebuttal_1?}

Opponent latest:
{cons_rebuttal_1?}

Final rebuttal; closing must be crisp for the judge.`,
      }),
      tools: [...debateTools, emitProsR2],
      outputKey: 'pros_rebuttal_2',
    });

    const consRebuttal2 = new LlmAgent({
      name: 'cons_rebuttal_2',
      model: resolveModel(consRef),
      description: 'CON final rebuttal (typed handoff).',
      instruction: turnInstruction({
        side: 'con',
        round: 'rebuttal_2',
        emitName: 'emit_cons_rebuttal_2',
        contextBlock: `Your prior handoffs:
{cons_opening?}
{cons_rebuttal_1?}

Opponent latest:
{pros_rebuttal_1?}

Final rebuttal; closing must be crisp for the judge.`,
      }),
      tools: [...debateTools, emitConsR2],
      outputKey: 'cons_rebuttal_2',
    });

    const judge = new LlmAgent({
      name: 'debate_judge',
      model: resolveModel(judgeRef),
      description: `Impartial judge over typed DebateTurn handoffs.`,
      instruction: `You are an impartial debate judge. Decide from the typed handoff envelopes only
(## Handoff + JSON DebateTurn payloads). Prefer the JSON payload over prose.
Do not invent facts outside the payloads / user attachments.

## Transcript handoffs

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

### Round 1 — Opening
**PRO:** 2–3 bullets from claims (+ evidence sources).
**CON:** same.

### Round 2 — First rebuttal
**PRO / CON:** what each attacked (targets[]) and counters.

### Round 3 — Final rebuttal
**PRO / CON:** final answers + closing.

### Clash points
2–4 decisive clashes and who won each.

### Evidence quality
Who grounded claims better.

### Verdict
**PRO wins** | **CON wins** | **Split decision** + confidence (low/medium/high).

### Rationale
5–8 sentences grounded in payloads.

### Recommendation
One practical takeaway.`,
    });

    return new SequentialAgent({
      name: 'parallel_pipeline',
      description:
        'Typed-handoff debate: opening → two rebuttal rounds → judge.',
      subAgents: [
        new ParallelAgent({
          name: 'debate_opening',
          description: 'PRO/CON opening handoffs in parallel.',
          subAgents: [prosOpening, consOpening],
        }),
        new ParallelAgent({
          name: 'debate_rebuttal_1',
          description: 'First rebuttal handoffs.',
          subAgents: [prosRebuttal1, consRebuttal1],
        }),
        new ParallelAgent({
          name: 'debate_rebuttal_2',
          description: 'Final rebuttal handoffs.',
          subAgents: [prosRebuttal2, consRebuttal2],
        }),
        judge,
      ],
    });
  },
});
