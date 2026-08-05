/**
 * Hypothesis-driven refine with dig-deeper continuity:
 *
 *   Outer LoopAgent (quality):
 *     Inner LoopAgent (exploration): parent → workers → exit on submit
 *     director: READ report → pick dig-deeper points → next investigations
 *
 * Director is a senior specialist who continues the research by choosing what
 * to deepen next — not a section checklist. Loop exits only on rare accept.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  BaseAgent,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  createEvent,
  createEventActions,
  type FunctionTool,
  type InvocationContext,
} from '@google/adk';
import {
  createEmitHandoffTool,
  createGitCloneTool,
  createGrokBuildXSearchConnector,
  createGuardedTool,
  createHttpDownloadTool,
  createTavilyExtractTool,
  createWebSearchConnector,
  createWorkspaceFsTools,
  defineAgent,
  isProviderConfigured,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';
import {
  CHALLENGE_BRIEF_SCHEMA_ID,
  HTML_REPORT_SECTIONS,
  KNOWLEDGE_LEDGER_SCHEMA_ID,
  TASK_BATCH_SCHEMA_ID,
  WORKER_RESULT_SCHEMA_ID,
  WORK_PRODUCT_SCHEMA_ID,
  challengeBriefSchema,
  knowledgeLedgerSchema,
  taskBatchSchema,
  workerResultSchema,
  workProductSchema,
} from './schema.js';

function numInput(
  inputs: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = inputs?.[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function boolInput(
  inputs: Readonly<Record<string, unknown>> | undefined,
  key: string,
  fallback: boolean,
): boolean {
  const raw = inputs?.[key];
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fallback;
}

function stringInput(
  inputs: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const raw = inputs?.[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

class LoopExitGate extends BaseAgent {
  constructor(
    private readonly gateName: string,
    private readonly shouldExit: () => boolean,
  ) {
    super({ name: gateName, description: `Exit gate: ${gateName}` });
  }

  async *runAsyncImpl(ctx: InvocationContext) {
    if (!this.shouldExit()) return;
    yield createEvent({
      invocationId: ctx.invocationId,
      author: this.name,
      actions: createEventActions({ escalate: true }),
    });
  }

  async *runLiveImpl(ctx: InvocationContext) {
    yield* this.runAsyncImpl(ctx);
  }
}

class ConditionalWorkers extends BaseAgent {
  constructor(
    private readonly parallel: ParallelAgent,
    private readonly isExploring: () => boolean,
  ) {
    super({
      name: 'conditional_workers',
      description: 'Runs worker batch only while exploration is open.',
      subAgents: [parallel],
    });
  }

  async *runAsyncImpl(ctx: InvocationContext) {
    if (!this.isExploring()) return;
    for await (const event of this.parallel.runAsync(ctx)) {
      yield event;
    }
  }

  async *runLiveImpl(ctx: InvocationContext) {
    yield* this.runAsyncImpl(ctx);
  }
}

export const agentDefinition = defineAgent({
  id: 'hypothesis-refine',
  name: 'Hypothesis Refine',
  description:
    'Parent/workers investigate (code + web); senior Director reads the cumulative HTML report, picks dig-deeper points, and keeps the investigation going until further digging has low value.',
  limits: {
    maxSteps: 200,
    maxToolCalls: 200,
    maxWallSeconds: 1800,
    maxRepairs: 0,
  },
  verification: {
    checks: [
      verify.artifact({
        artifactId: 'report',
        mediaTypes: ['text/html'],
        minBytes: 1500,
      }),
      verify.artifact({
        artifactId: 'ledger',
        mediaTypes: ['application/json'],
        minBytes: 40,
      }),
      verify.document({
        artifactId: 'report',
        sections: [...HTML_REPORT_SECTIONS],
        minLevel: 1,
        maxLevel: 6,
      }),
    ],
  },
  createAgent(context: AgentBuildContext) {
    const maxBatches = numInput(context.inputs, 'maxBatches', 8, 1, 20);
    const maxQualityRounds = numInput(
      context.inputs,
      'maxQualityRounds',
      3,
      1,
      8,
    );
    const parallelSlots = numInput(context.inputs, 'parallelSlots', 3, 1, 5);
    const allowRepoWrite = boolInput(context.inputs, 'allowWrite', false);
    const repo = stringInput(context.inputs, 'repo');

    const model = isProviderConfigured('cursor')
      ? 'cursor:grok-4.5'
      : 'gemini:gemini-3.6-flash';

    const RUNS_DIR = resolve(context.repoRoot, '.runs', 'hypothesis-refine');
    const workRoots = new Set<string>();
    const reportRoots = new Set<string>();

    if (repo && !/^https?:\/\//i.test(repo) && existsSync(repo)) {
      workRoots.add(resolve(repo));
    }

    const loopFlags = {
      exploring: true,
      /** false only when Director accepts (stop digging). */
      keepDigging: true,
    };

    const fs = createWorkspaceFsTools({
      roots: () => [...workRoots, ...reportRoots],
      write: {
        approve: ({ input }) => {
          const abs = resolve(input.path);
          for (const root of reportRoots) {
            if (abs === root || abs.startsWith(root + sep)) return true;
          }
          if (!allowRepoWrite) return false;
          for (const root of workRoots) {
            if (abs === root || abs.startsWith(root + sep)) return true;
          }
          return false;
        },
      },
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
        'Register the run workspace directory (report.html / ledger.json live here).',
      parameters: z.object({
        dir: z.string().describe('Absolute run workspace directory'),
      }),
      execute: ({ dir }) => {
        const abs = resolve(dir);
        reportRoots.add(abs);
        workRoots.add(abs);
        return { status: 'success' as const, dir: abs };
      },
    });

    const registerLocalRepo = createGuardedTool({
      contract: {
        version: '1.0',
        name: 'register_local_repo',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description: 'Register a local absolute repo path as a readable workspace root.',
      parameters: z.object({
        dir: z.string().describe('Absolute path to an existing local repository'),
      }),
      execute: ({ dir }) => {
        const abs = resolve(dir);
        if (!existsSync(abs)) {
          return { status: 'error' as const, message: `path not found: ${abs}` };
        }
        workRoots.add(abs);
        return { status: 'success' as const, dir: abs };
      },
    });

    const cloneRepo = createGitCloneTool({
      parentDir: RUNS_DIR,
      description:
        'Shallow-clone a public GitHub repository under .runs/hypothesis-refine.',
      onCloned: (workdir) => {
        workRoots.add(workdir);
      },
    });

    function cliOk(bin: string, args: string[]): boolean {
      try {
        execFileSync(bin, args, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }

    const researchTools: FunctionTool[] = [];
    const researchToolNames: string[] = [];

    const tavilyKey = () => context.secret('TAVILY_API_KEY');
    const hasTavily = Boolean(context.secret('TAVILY_API_KEY')?.trim());
    const braveKey = () => context.secret('BRAVE_API_KEY');
    const hasBrave = Boolean(context.secret('BRAVE_API_KEY')?.trim());

    if (hasTavily) {
      const web = createWebSearchConnector({
        id: 'web',
        provider: 'tavily',
        apiKey: tavilyKey,
        searchDepth: 'advanced',
        timeoutMs: 45_000,
      });
      researchTools.push(web.createTool());
      researchToolNames.push('search_web');
      researchTools.push(
        createTavilyExtractTool({
          apiKey: tavilyKey,
          timeoutMs: 60_000,
          defaultMaxCharsPerUrl: 3500,
        }),
      );
      researchToolNames.push('fetch_pages');
    } else if (hasBrave) {
      const web = createWebSearchConnector({
        id: 'web',
        provider: 'brave',
        apiKey: braveKey,
        timeoutMs: 45_000,
      });
      researchTools.push(web.createTool());
      researchToolNames.push('search_web');
    }

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
      researchToolNames.push('search_x');
    }

    researchTools.push(
      createHttpDownloadTool({
        roots: () => [...reportRoots],
      }),
    );
    researchToolNames.push('download_url');

    const webHint =
      researchToolNames.filter((n) => n !== 'download_url').length > 0
        ? `Web tools: ${researchToolNames.join(', ')}. Cite real URLs; never invent stats or links.`
        : `No search_web this run (need TAVILY_API_KEY or BRAVE_API_KEY). Do not invent URLs or market figures.`;

    const signalExplorationSubmit = createGuardedTool({
      contract: {
        version: '1.0',
        name: 'signal_exploration_submit',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description:
        'Call when cumulative report.html + ledger.json are written and ready for Director dig-deeper review.',
      parameters: z.object({
        reason: z.string().min(8),
      }),
      execute: ({ reason }) => {
        loopFlags.exploring = false;
        return { status: 'ok' as const, phase: 'submit', reason };
      },
    });

    const signalStopDigging = createGuardedTool({
      contract: {
        version: '1.0',
        name: 'signal_stop_digging',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description:
        'Director only: call with stance=accept when further dig-deeper has low expected value for the goal.',
      parameters: z.object({
        reason: z.string().min(40),
      }),
      execute: ({ reason }) => {
        loopFlags.keepDigging = false;
        return { status: 'ok' as const, phase: 'accept', reason };
      },
    });

    const emitTaskBatch = createEmitHandoffTool({
      name: 'emit_task_batch',
      fromAgent: 'parent',
      toAgent: 'workers',
      outputSchema: TASK_BATCH_SCHEMA_ID,
      payloadSchema: taskBatchSchema,
      defaultObjective: 'Exploration / dig-deeper task batch',
      doneCriteria: ['tasks executable', 'prefer Director nextInvestigations'],
    });

    const emitLedger = createEmitHandoffTool({
      name: 'emit_knowledge_ledger',
      fromAgent: 'parent',
      toAgent: 'director',
      outputSchema: KNOWLEDGE_LEDGER_SCHEMA_ID,
      payloadSchema: knowledgeLedgerSchema,
      defaultObjective: 'Cumulative knowledge ledger',
      doneCriteria: ['facts grounded', 'digHistory updated'],
    });

    const emitWorkProduct = createEmitHandoffTool({
      name: 'emit_work_product',
      fromAgent: 'parent',
      toAgent: 'director',
      outputSchema: WORK_PRODUCT_SCHEMA_ID,
      payloadSchema: workProductSchema,
      defaultObjective: 'Submit cumulative report for dig-deeper review',
      doneCriteria: ['htmlPath + ledgerPath exist'],
    });

    const emitChallenge = createEmitHandoffTool({
      name: 'emit_challenge_brief',
      fromAgent: 'director',
      toAgent: 'parent',
      outputSchema: CHALLENGE_BRIEF_SCHEMA_ID,
      payloadSchema: challengeBriefSchema,
      defaultObjective: 'Dig-deeper guidance for the next investigation cycle',
      doneCriteria: [
        'dig_deeper: digDeeperPoints + nextInvestigations from report content',
        'accept: rare, residual uncertainties explicit',
      ],
    });

    const sectionList = HTML_REPORT_SECTIONS.map((s) => `<h2>${s}</h2>`).join(
      '\n',
    );

    const parent = new LlmAgent({
      name: 'parent',
      model,
      description:
        'Field orchestrator: run dig-deeper batches from Director, maintain cumulative HTML.',
      instruction: `You are the FIELD ORCHESTRATOR. You keep investigating until the Director stops digging.

Goal: user message.
Repo hint: ${repo || '(none)'}
Parallel slots: ${parallelSlots}
Workspace: {runWorkspaceDir}
${webHint}

Prior state:
- {parent_turn?}
- {worker_result_0?} {worker_result_1?} {worker_result_2?} {worker_result_3?} {worker_result_4?}
- Director dig-deeper brief (HIGHEST PRIORITY when present): {challenge_brief?}

## Continuity rule
When a ChallengeBrief with stance=dig_deeper exists, your NEXT explore batch MUST implement its nextInvestigations (map each to a worker task; put digReason from whyItMatters). Do not ignore digDeeperPoints.

## Budget
At most ${maxBatches} exploration iterations this cycle.
- If ${maxBatches} === 1: investigate yourself, write complete report.html + ledger.json, emit handoffs, signal_exploration_submit (no task_batch).
- On the last iteration you MUST submit, not explore.
- Always leave report.html + ledger.json on disk before submit.

### A) EXPLORE
1. register_workspace({runWorkspaceDir}).
2. clone_repo / register_local_repo if needed.
3. Optionally spot-check with search_web / fetch_pages.
4. emit_task_batch (≤${parallelSlots} tasks). Prefer Director nextInvestigations.
5. Do NOT signal_exploration_submit.
6. FINAL = emit_task_batch envelope.

### B) SUBMIT (after workers or solo investigation)
1. Overwrite {runWorkspaceDir}/report.html as a COMPLETE cumulative report (not last round only).
2. Overwrite {runWorkspaceDir}/ledger.json (include digHistory outcomes).
3. emit_knowledge_ledger + emit_work_product.
4. signal_exploration_submit.
5. FINAL = emit_work_product envelope.

## HTML (exact h2 titles)
${sectionList}
Tables for evidence / dig-deeper themes. Cite real sources. Match user language.

You are NOT the Director. After submit the Director will tell you what to dig next.`,
      tools: [
        registerWorkspace,
        registerLocalRepo,
        cloneRepo,
        fs.listFiles,
        fs.readFile,
        fs.writeFile,
        ...researchTools,
        emitTaskBatch,
        emitLedger,
        emitWorkProduct,
        signalExplorationSubmit,
      ],
      outputKey: 'parent_turn',
    });

    const workerTools: FunctionTool[] = [
      fs.listFiles,
      fs.readFile,
      ...(allowRepoWrite ? [fs.writeFile] : []),
      ...researchTools.filter((t) => t.name !== 'download_url'),
    ];

    const workers = Array.from({ length: parallelSlots }, (_, i) => {
      const emitResult = createEmitHandoffTool({
        name: `emit_worker_result_${i}`,
        fromAgent: `worker_${i}`,
        toAgent: 'parent',
        outputSchema: WORKER_RESULT_SCHEMA_ID,
        payloadSchema: workerResultSchema,
        defaultObjective: `Worker slot ${i} dig findings`,
        doneCriteria: ['grounded in files or web tools', 'taskId matches'],
      });

      return new LlmAgent({
        name: `worker_${i}`,
        model,
        description: `Homogeneous dig worker slot ${i}.`,
        instruction: `Worker slot ${i}/${parallelSlots}. Execute ONLY your assigned dig task.

Parent turn (TaskBatch inside envelope):
{parent_turn}

${webHint}

1. Parse tasks[${i}]. If missing → idle result and stop.
2. Follow instructions deeply (search_web / fetch_pages / read_file as needed). No invented URLs or numbers.
3. emit_worker_result_${i} with findings + gapsNoticed.
4. Do not decide whether to continue the overall investigation.
5. FINAL = emit envelope.`,
        tools: [...workerTools, emitResult],
        outputKey: `worker_result_${i}`,
      });
    });

    const parallelWorkers = new ParallelAgent({
      name: 'workers',
      description: 'Parallel dig workers.',
      subAgents: workers,
    });

    const director = new LlmAgent({
      name: 'director',
      model,
      description:
        'Senior Director: read report, choose dig-deeper points, keep investigation going.',
      instruction: `You are the RESEARCH DIRECTOR (senior specialist / PI). The field team reports to you.

## Your job (this is NOT a formatting review)
1. READ the submitted cumulative report end-to-end (register_workspace + read_file on htmlPath and ledgerPath from {parent_turn?} / {runWorkspaceDir}/report.html).
2. From the *substance* of the report, find 2–5 DIG-DEEPER points: claims that are thin, high-leverage unknowns, weak comparisons, missing counter-evidence, or next-layer questions a good analyst would chase.
3. For each point, define executable nextInvestigations the workers can run (queries, pages, files, competitor tables, etc.).
4. Prefer depth over breadth: push the team to go deeper on the most consequential threads, not to polish headings.

## Forbidden (do not spend the brief on these)
- Listing missing h2 titles / "add a table" as the main feedback
- Vague "looks incomplete" without naming what to dig
- Accepting just because the HTML structure looks complete
- Repeating dig themes already in ledger digHistory without a new angle

## Stance
- **dig_deeper** (default): emit ChallengeBrief with digDeeperPoints (≥2), hypotheses, ordered nextInvestigations, and a clear guidance paragraph. Do NOT call signal_stop_digging.
- **accept** (rare): only when additional digging has low expected value for the user goal. State residual uncertainties in acceptRationale, then signal_stop_digging.
- **blocked**: cannot read report / empty product — explain in guidance; no accept.

Prior brief (avoid duplicate digs): {challenge_brief?}

Call emit_challenge_brief ONCE. FINAL = emit envelope.
Payload shape: { stance, digDeeperPoints[{id, reportAnchor, whyItMatters, openQuestion, priority}], hypotheses[], nextInvestigations[{title, instructions, acceptance, linkedDigId}], guidance, acceptRationale? }`,
      tools: [
        registerWorkspace,
        fs.listFiles,
        fs.readFile,
        emitChallenge,
        signalStopDigging,
      ],
      outputKey: 'challenge_brief',
    });

    const exploration = new LoopAgent({
      name: 'exploration',
      description: 'Parent/workers dig until submit.',
      maxIterations: maxBatches,
      subAgents: [
        parent,
        new ConditionalWorkers(parallelWorkers, () => loopFlags.exploring),
        new LoopExitGate('exploration_exit_gate', () => !loopFlags.exploring),
      ],
    });

    const qualityReset = new (class extends BaseAgent {
      constructor() {
        super({
          name: 'quality_round_reset',
          description: 'Re-open exploration for the next dig cycle.',
        });
      }
      async *runAsyncImpl(_ctx: InvocationContext) {
        loopFlags.exploring = true;
      }
      async *runLiveImpl(ctx: InvocationContext) {
        yield* this.runAsyncImpl(ctx);
      }
    })();

    return new LoopAgent({
      name: 'hypothesis_refine',
      description:
        'Investigate → submit report → Director picks dig-deeper → repeat.',
      maxIterations: maxQualityRounds,
      subAgents: [
        qualityReset,
        exploration,
        director,
        new LoopExitGate('quality_exit_gate', () => !loopFlags.keepDigging),
      ],
    });
  },
});
