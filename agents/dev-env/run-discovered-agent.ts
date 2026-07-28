/**
 * Single invocation path for CLI / admin / API.
 * Resolves canonical agent package files, builds a per-run agent tree,
 * merges RunRequest into an effective RunSpec, then runs + verifies.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  applyAgentParams,
  applyRunSpecOverrides,
  createRunHistoryStore,
  defaultValuesFromParams,
  RUN_WORKSPACE_STATE_KEY,
  runFromSpec,
  type AgentBuildContext,
  type RunFromSpecResult,
  type RunHistoryWriter,
  type ToolApprovalPolicy,
} from '@agent-env/harness';
import type {
  AgentProgressSink,
  AgentRunRequest,
  ModelRef,
} from '@agent-env/shared';
import { agentRunRequestSchema } from '@agent-env/shared';
import { bootstrapProvidersFromEnv, loadDotEnv } from './bootstrap.js';
import {
  getResolvedAgentPackage,
  loadAgentDefinition,
  type DiscoverAgentsOptions,
  type ResolvedAgentPackage,
} from './catalog.js';

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


export interface RunDiscoveredAgentResult extends RunFromSpecResult {
  package: ResolvedAgentPackage;
  historyDir?: string;
  workspaceDir?: string;
}

function createBuildContext(
  repoRoot: string,
  inputs?: Readonly<Record<string, unknown>>,
): AgentBuildContext {
  return {
    repoRoot,
    config: (name) => process.env[name]?.trim() || undefined,
    secret: (name) => process.env[name]?.trim() || undefined,
    ...(inputs ? { inputs } : {}),
  };
}

function discoveryFromCwd(cwd: string): DiscoverAgentsOptions {
  return {
    agentsDir: resolve(cwd, 'agents'),
    repoRoot: resolve(cwd),
  };
}

/**
 * Validate values against params.yaml and produce a typed AgentRunRequest.
 */
export function buildRunRequestFromValues(
  pkg: ResolvedAgentPackage,
  values: Record<string, unknown>,
  options: { cwd?: string; model?: ModelRef; runId?: string } = {},
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
    ...(options.model ? { model: options.model } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
  });
}

export async function runDiscoveredAgent(
  options: RunDiscoveredAgentOptions,
): Promise<RunDiscoveredAgentResult> {
  const cwd = options.cwd ?? process.cwd();
  loadDotEnv(resolve(cwd, '.env'));
  bootstrapProvidersFromEnv();

  const discovery = options.discovery ?? discoveryFromCwd(cwd);
  const pkg = getResolvedAgentPackage(discovery, options.request.agentId);
  if (!pkg) {
    throw new Error(`Unknown agent: ${options.request.agentId}`);
  }

  const request = options.values
    ? buildRunRequestFromValues(pkg, options.values, {
        cwd,
        model: options.request.model,
        runId: options.request.runId,
      })
    : agentRunRequestSchema.parse(options.request);

  if (request.agentId !== pkg.id) {
    throw new Error(
      `request.agentId "${request.agentId}" does not match package "${pkg.id}"`,
    );
  }

  const definition = await loadAgentDefinition(pkg.entry, cwd);
  if (definition.id !== pkg.id) {
    throw new Error(
      `agentDefinition.id "${definition.id}" must match directory "${pkg.id}"`,
    );
  }

  const agent = await definition.createAgent(
    createBuildContext(discovery.repoRoot ?? cwd, request.inputs),
  );

  const effectiveSpec = applyRunSpecOverrides(pkg.runSpec, {
    objective: request.objective,
    model: request.model,
    inputs: request.inputs,
  });

  const runId = request.runId ?? randomUUID();
  let writer: RunHistoryWriter | undefined;
  if (options.history !== false) {
    const history = createRunHistoryStore({
      baseDir: resolve(cwd, '.runs', 'runs'),
    });
    writer = history.open({
      runId,
      agentId: pkg.id,
      runMode: 'runspec',
      message: request.objective,
      ...(request.model ? { model: request.model } : {}),
    });
    writeFileSync(
      join(writer.dir, 'runspec.json'),
      `${JSON.stringify(effectiveSpec, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(writer.dir, 'evaluation.json'),
      `${JSON.stringify(pkg.evaluation, null, 2)}\n`,
      'utf8',
    );
  }

  const stateDelta: Record<string, unknown> = {
    ...request.inputs,
    ...(writer
      ? { [RUN_WORKSPACE_STATE_KEY]: writer.workspaceDir }
      : {}),
  };

  const result = await runFromSpec({
    spec: effectiveSpec,
    evaluation: pkg.evaluation,
    evaluationBaseDir: pkg.dir,
    agent,
    runId,
    cwd,
    stateDelta,
    attachments: request.attachments,
    abortSignal: options.abortSignal,
    toolApproval: options.toolApproval,
    onProgress: options.onProgress
      ? writer
        ? (event) => {
            writer.progressSink(event);
            options.onProgress?.(event);
          }
        : options.onProgress
      : writer?.progressSink,
  });

  if (writer) {
    writeFileSync(
      join(writer.dir, 'runspec.json'),
      `${JSON.stringify(result.effectiveSpec, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(writer.dir, 'evaluation.json'),
      `${JSON.stringify(result.effectiveEvaluation, null, 2)}\n`,
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
