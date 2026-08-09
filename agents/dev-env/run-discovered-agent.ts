/**
 * Single invocation path for CLI / admin / API.
 * Resolves a discovered agent package, builds the ADK graph, merges host
 * execution policy, then runs via executeAgentRun.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyAgentParams,
  assertGraphModelsResolvable,
  buildObservedGraph,
  createRunHistoryStore,
  defaultValuesFromParams,
  describeAgentGraph,
  executeAgentRun,
  mergeExecutionLimits,
  RUN_WORKSPACE_STATE_KEY,
  type AgentBuildContext,
  type AgentDefinition,
  type ExecuteAgentRunResult,
  type RunHistoryWriter,
  type ToolApprovalPolicy,
} from '@agent-env/harness';
import type {
  AgentProgressEvent,
  AgentProgressSink,
  AgentRunRequest,
} from '@agent-env/shared';
import { agentRunRequestSchema } from '@agent-env/shared';
import { bootstrapProvidersFromEnv, loadDotEnv } from './bootstrap.js';
import {
  getResolvedAgentPackage,
  loadAgentDefinition,
  type DiscoverAgentsOptions,
  type ResolvedAgentPackage,
} from './catalog.js';
import { DEFAULT_HOST_EXECUTION_LIMITS } from './execution-policy.js';
import {
  discoveryFromHostPaths,
  resolveDiscoveryOptions,
  resolveHostPaths,
} from './host-paths.js';

export interface RunDiscoveredAgentOptions {
  request: AgentRunRequest;
  /** Form/CLI values before params validation. When set, overrides request fields. */
  values?: Record<string, unknown>;
  cwd?: string;
  discovery?: DiscoverAgentsOptions;
  abortSignal?: AbortSignal;
  onProgress?: AgentProgressSink;
  /** Skip writing run history (tests). */
  history?: boolean;
  /**
   * Per-run T2/T3 approval policy.
   * Default deny (CLI). Admin passes interactive or auto.
   */
  toolApproval?: ToolApprovalPolicy;
}

export interface RunDiscoveredAgentResult extends ExecuteAgentRunResult {
  package: ResolvedAgentPackage;
  historyDir?: string;
  workspaceDir?: string;
}

function discoveryFromCwd(cwd: string): DiscoverAgentsOptions {
  return resolveDiscoveryOptions({ fallbackRoot: cwd });
}

function createBuildContext(options: {
  repoRoot: string;
  discovery: DiscoverAgentsOptions;
  inputs?: Readonly<Record<string, unknown>>;
  depth?: number;
  stack?: readonly string[];
  maxSubagentDepth?: number;
}): AgentBuildContext {
  const depth = options.depth ?? 0;
  const stack = options.stack ?? [];
  const maxSubagentDepth =
    options.maxSubagentDepth ?? DEFAULT_HOST_EXECUTION_LIMITS.maxSubagentDepth;
  const cwd = options.repoRoot;

  return {
    repoRoot: options.repoRoot,
    config: (name) => process.env[name]?.trim() || undefined,
    secret: (name) => process.env[name]?.trim() || undefined,
    ...(options.inputs ? { inputs: options.inputs } : {}),
    async buildSubagent(id, subOptions) {
      if (depth >= maxSubagentDepth) {
        throw new Error(
          `Subagent depth exceeds maxSubagentDepth (${maxSubagentDepth})`,
        );
      }
      if (stack.includes(id)) {
        throw new Error(
          `Circular subagent dependency: ${[...stack, id].join(' -> ')}`,
        );
      }
      const pkg = getResolvedAgentPackage(options.discovery, id);
      if (!pkg) {
        throw new Error(`Unknown subagent: ${id}`);
      }
      const definition = await loadAgentDefinition(pkg.entry, cwd);
      if (definition.id !== pkg.id) {
        throw new Error(
          `agentDefinition.id "${definition.id}" must match directory "${pkg.id}"`,
        );
      }
      const childInputs = subOptions?.inputs ?? options.inputs;
      return definition.createAgent(
        createBuildContext({
          repoRoot: options.repoRoot,
          discovery: options.discovery,
          ...(childInputs ? { inputs: childInputs } : {}),
          depth: depth + 1,
          stack: [...stack, id],
          maxSubagentDepth,
        }),
      );
    },
  };
}

/**
 * Validate values against params (file or in-memory default) and produce a typed AgentRunRequest.
 */
export function buildRunRequestFromValues(
  pkg: ResolvedAgentPackage,
  values: Record<string, unknown>,
  options: { cwd?: string; runId?: string } = {},
): AgentRunRequest {
  const applied = applyAgentParams(pkg.params, values, {
    cwd: options.cwd ?? process.cwd(),
  });
  return agentRunRequestSchema.parse({
    agentId: pkg.id,
    objective: applied.objective,
    inputs: applied.inputs,
    attachments: applied.attachments,
    metadata: applied.metadata,
    ...(options.runId ? { runId: options.runId } : {}),
  });
}

export async function runDiscoveredAgent(
  options: RunDiscoveredAgentOptions,
): Promise<RunDiscoveredAgentResult> {
  const cwd = options.cwd ?? process.cwd();
  const host = resolveHostPaths({ fallbackRoot: cwd });
  loadDotEnv(resolve(host.root, '.env'));
  bootstrapProvidersFromEnv();

  const discovery = options.discovery ?? discoveryFromHostPaths(host);
  const pkg = getResolvedAgentPackage(discovery, options.request.agentId);
  if (!pkg) {
    throw new Error(`Unknown agent: ${options.request.agentId}`);
  }

  const request = options.values
    ? buildRunRequestFromValues(pkg, options.values, {
        cwd: host.root,
        runId: options.request.runId,
      })
    : agentRunRequestSchema.parse(options.request);

  if (request.agentId !== pkg.id) {
    throw new Error(
      `request.agentId "${request.agentId}" does not match package "${pkg.id}"`,
    );
  }

  const definition = await loadAgentDefinition(pkg.entry, host.root);
  if (definition.id !== pkg.id) {
    throw new Error(
      `agentDefinition.id "${definition.id}" must match directory "${pkg.id}"`,
    );
  }

  const repoRoot = discovery.repoRoot ?? host.root;
  const context = createBuildContext({
    repoRoot,
    discovery,
    ...(request.inputs ? { inputs: request.inputs } : {}),
    depth: 0,
    stack: [pkg.id],
    maxSubagentDepth: DEFAULT_HOST_EXECUTION_LIMITS.maxSubagentDepth,
  });

  const agent = await definition.createAgent(context);
  const effectiveGraph = describeAgentGraph(agent, { agentId: pkg.id });
  assertGraphModelsResolvable(effectiveGraph);

  const limits = mergeExecutionLimits(
    DEFAULT_HOST_EXECUTION_LIMITS,
    definition.limits,
  );

  const runId = request.runId ?? randomUUID();
  let writer: RunHistoryWriter | undefined;
  if (options.history !== false) {
    const history = createRunHistoryStore({
      baseDir: resolve(host.root, '.runs', 'runs'),
    });
    writer = history.open({
      runId,
      agentId: pkg.id,
      runMode: 'agent',
      message: request.objective,
    });
    writeFileSync(
      join(writer.dir, 'effective-graph.json'),
      `${JSON.stringify(effectiveGraph, null, 2)}\n`,
      'utf8',
    );
  }

  const stateDelta: Record<string, unknown> = {
    ...request.inputs,
    ...(writer
      ? { [RUN_WORKSPACE_STATE_KEY]: writer.workspaceDir }
      : {}),
  };

  const result = await executeAgentRun({
    agent,
    agentId: pkg.id,
    objective: request.objective,
    inputs: request.inputs,
    limits,
    stateDelta,
    attachments: request.attachments,
    cwd: host.root,
    runId,
    abortSignal: options.abortSignal,
    toolApproval: options.toolApproval,
    onProgress: options.onProgress
      ? writer
        ? (event: AgentProgressEvent) => {
            writer.progressSink(event);
            options.onProgress?.(event);
          }
        : options.onProgress
      : writer?.progressSink,
  });

  if (writer) {
    writeFileSync(
      join(writer.dir, 'intent.json'),
      `${JSON.stringify(result.intent, null, 2)}\n`,
      'utf8',
    );
    const observed = buildObservedGraph(
      effectiveGraph,
      // progress events are on disk; synthesize minimal from record models
      [],
    );
    if (result.record.modelsUsed?.length) {
      observed.modelsUsed = [...result.record.modelsUsed];
    }
    writeFileSync(
      join(writer.dir, 'observed-graph.json'),
      `${JSON.stringify(observed, null, 2)}\n`,
      'utf8',
    );
    writer.writeRunRecord(
      result.record,
      result.events,
      result.agentFinalText,
    );
  }

  return {
    ...result,
    package: pkg,
    historyDir: writer?.dir,
    workspaceDir: writer?.workspaceDir,
  };
}

export { defaultValuesFromParams };
