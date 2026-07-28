import {
  InMemoryRunner,
  getFunctionCalls,
  getFunctionResponses,
  isFinalResponse,
  isLlmAgent,
  StreamingMode,
  stringifyContent,
  type BaseAgent,
  type BaseLlm,
  type Event,
} from '@google/adk';
import { randomUUID } from 'node:crypto';
import {
  createProgressSequencer,
  llmProviderIdSchema,
  type AgentAttachment,
  type AgentEventSummary,
  type AgentProgressSink,
  type AgentRunResult,
  type ModelRef,
} from '@agent-env/shared';
import {
  assertProviderAcceptsMedia,
  providerIdOfModel,
  resolveModel,
} from '@agent-env/llm';
import { assertApiKey, loadHarnessConfig } from './config.js';
import { collectLlmAgents } from './runtime/agent-tree.js';
import { bindLlmProgressAuthor } from './runtime/llm-progress-scope.js';
import { runWithProgressEmit } from './runtime/progress-context.js';
import { prepareAttachmentsForProvider } from './attachments/index.js';
import { buildUserContent } from './user-content.js';

export interface RunAgentOptions {
  agent: BaseAgent;
  message: string;
  /** Defaults from loadHarnessConfig (explicit overrides only). */
  appName?: string;
  userId?: string;
  sessionId?: string;
  /**
   * Correlation id for progress events. Defaults to sessionId.
   * Callers that own an outer run (admin / runFromSpec) should pass their runId.
   */
  runId?: string;
  /**
   * When set, temporarily bind this ModelRef onto every LlmAgent in the tree
   * for the run (restored afterwards so shared module-level agents stay unchanged).
   */
  model?: ModelRef;
  stateDelta?: Record<string, unknown>;
  /** Multimodal / binary attachments (from AgentParams delivery: content). */
  attachments?: readonly AgentAttachment[];
  /** Workspace root for resolving attachment paths. */
  cwd?: string;
  /**
   * When true (default), create a named session and use `runAsync`
   * so multi-turn / resume is possible.
   * When false, use `runEphemeral` for fire-and-forget runs.
   */
  persistent?: boolean;
  /** Optional live event sink (CLI logs, raw ADK Event). */
  onEvent?: (event: Event) => void;
  /** Normalized progress sink for admin SSE / CLI live views. */
  onProgress?: AgentProgressSink;
  abortSignal?: AbortSignal;
}

/**
 * Apply a ModelRef to every LlmAgent in the tree for the duration of `fn`,
 * then restore. Covers Sequential / Parallel roots used by RunSpec demos.
 * No-op when model is omitted or the tree has no LlmAgent.
 */
export async function withAgentModel<T>(
  agent: BaseAgent,
  model: ModelRef | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!model) {
    return fn();
  }
  const targets = collectLlmAgents(agent);
  if (targets.length === 0) {
    return fn();
  }
  const resolved = resolveModel(model);
  const previous = targets.map((llm) => llm.model as string | BaseLlm | undefined);
  for (const llm of targets) {
    llm.model = resolved;
  }
  try {
    return await fn();
  } finally {
    for (let i = 0; i < targets.length; i += 1) {
      targets[i]!.model = previous[i];
    }
  }
}

/**
 * Temporarily wrap every concrete BaseLlm in the tree so mid-stream tools
 * inherit that agent's author via ALS (restored afterwards).
 */
export async function withLlmProgressScopes<T>(
  agent: BaseAgent,
  fn: () => Promise<T>,
): Promise<T> {
  const targets = collectLlmAgents(agent);
  if (targets.length === 0) return fn();
  const previous = targets.map(
    (llm) => llm.model as string | BaseLlm | undefined,
  );
  for (const llm of targets) {
    if (llm.model === undefined) continue;
    llm.model = bindLlmProgressAuthor(
      llm.model as string | BaseLlm,
      llm.name,
    );
  }
  try {
    return await fn();
  } finally {
    for (let i = 0; i < targets.length; i += 1) {
      targets[i]!.model = previous[i];
    }
  }
}


function summarizeFunctionArgs(
  args: Record<string, unknown> | undefined,
): string {
  if (!args || Object.keys(args).length === 0) return '';
  try {
    const json = JSON.stringify(args);
    return json.length > 240 ? `${json.slice(0, 239)}…` : json;
  } catch {
    return '';
  }
}

export function summarizeEvent(event: Event): AgentEventSummary {
  const text = stringifyContent(event).trim();
  const meta = event.customMetadata as Record<string, unknown> | undefined;
  const providerRaw = meta?.['provider'];
  const modelRaw = meta?.['model'];
  const providerParsed =
    typeof providerRaw === 'string'
      ? llmProviderIdSchema.safeParse(providerRaw)
      : null;

  const functionCalls = getFunctionCalls(event).map((call) => ({
    ...(typeof call.name === 'string' ? { name: call.name } : {}),
    ...(call.args && typeof call.args === 'object'
      ? { args: call.args as Record<string, unknown> }
      : {}),
  }));
  const functionResponses = getFunctionResponses(event).map((res) => ({
    ...(typeof res.name === 'string' ? { name: res.name } : {}),
    ...(res.response !== undefined ? { response: res.response } : {}),
  }));

  return {
    author: event.author ?? 'system',
    isFinal: isFinalResponse(event),
    ...(event.partial ? { partial: true } : {}),
    text: text.length > 0 ? text : undefined,
    errorMessage: event.errorMessage,
    branch: event.branch,
    provider: providerParsed?.success ? providerParsed.data : undefined,
    model: typeof modelRaw === 'string' ? modelRaw : undefined,
    ...(functionCalls.length > 0 ? { functionCalls } : {}),
    ...(functionResponses.length > 0 ? { functionResponses } : {}),
  };
}

function progressMessageForSummary(summary: AgentEventSummary): string | undefined {
  if (summary.text) return summary.text;
  if (summary.errorMessage) return summary.errorMessage;
  if (summary.functionCalls?.length) {
    return summary.functionCalls
      .map((call) => {
        const args = summarizeFunctionArgs(call.args);
        return `call ${call.name ?? 'tool'}${args ? `(${args})` : ''}`;
      })
      .join('; ');
  }
  if (summary.functionResponses?.length) {
    return summary.functionResponses
      .map((res) => `result ${res.name ?? 'tool'}`)
      .join('; ');
  }
  return undefined;
}

/** Provider id the run will bind to (explicit model, else the agent's model). */
function resolveRunProviderId(
  agent: BaseAgent,
  model: ModelRef | undefined,
): string | undefined {
  return (
    model?.provider ??
    providerIdOfModel(isLlmAgent(agent) ? agent.model : undefined)
  );
}

/**
 * Fail before the first LLM call when the bound provider cannot take the
 * attached media, so the error names the offending file instead of surfacing
 * mid-stream from the vendor adapter.
 */
function assertAttachmentsFitProvider(
  providerId: string | undefined,
  attachments: readonly AgentAttachment[],
): void {
  if (attachments.length === 0 || !providerId) return;
  assertProviderAcceptsMedia(
    providerId,
    attachments.map((attachment) => ({
      mimeType: attachment.mimeType,
      name: attachment.path,
    })),
  );
}

function collectModelsUsed(events: AgentEventSummary[]): ModelRef[] | undefined {
  const seen = new Map<string, ModelRef>();
  for (const event of events) {
    if (!event.provider || !event.model) continue;
    const key = `${event.provider}:${event.model}`;
    if (!seen.has(key)) {
      seen.set(key, { provider: event.provider, model: event.model });
    }
  }
  return seen.size > 0 ? [...seen.values()] : undefined;
}

/**
 * Run a root ADK agent once and collect a typed result.
 * This is the primary integration point for scripts and future web APIs.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  return withAgentModel(options.agent, options.model, () =>
    withLlmProgressScopes(options.agent, () => runAgentWithBoundModel(options)),
  );
}

async function runAgentWithBoundModel(
  options: RunAgentOptions,
): Promise<AgentRunResult> {
  const config = loadHarnessConfig({
    appName: options.appName,
    userId: options.userId,
  });
  assertApiKey(config);

  const startedAt = new Date().toISOString();
  const appName = options.appName ?? config.appName;
  const userId = options.userId ?? config.userId;
  const sessionId = options.sessionId ?? randomUUID();
  const runId = options.runId ?? sessionId;
  const persistent = options.persistent ?? true;
  const progress = createProgressSequencer(runId, options.onProgress);

  const runner = new InMemoryRunner({
    agent: options.agent,
    appName,
  });

  const events: AgentEventSummary[] = [];
  let finalText: string | undefined;
  let runError: string | undefined;

  progress.emit('run.started', {
    message: `Running agent ${options.agent.name}`,
    author: options.agent.name,
    payload: {
      sessionId,
      appName,
      userId,
      ...(options.model
        ? {
            model: {
              provider: options.model.provider,
              model: options.model.model,
            },
          }
        : {}),
    },
  });

  try {
    const providerId = resolveRunProviderId(options.agent, options.model);
    const cwd = options.cwd ?? process.cwd();
    // Split into native byte attachments vs provider-fallback text transcripts.
    const prepared = await prepareAttachmentsForProvider({
      attachments: options.attachments ?? [],
      providerId,
      cwd,
    });
    // Non-transcribable, unsupported media still fails fast (names the file).
    assertAttachmentsFitProvider(providerId, prepared.attachments);

    if (persistent) {
      await runner.sessionService.createSession({
        appName,
        userId,
        sessionId,
      });
    }

    const newMessage = buildUserContent(
      options.message,
      prepared.attachments,
      cwd,
      prepared.textParts,
    );
    if ((options.attachments?.length ?? 0) > 0) {
      const nativeCount = prepared.attachments.length;
      const textCount = prepared.transcripts.length;
      progress.emit('agent.event', {
        author: options.agent.name,
        message:
          `Attached ${nativeCount} file(s) to user turn` +
          (textCount > 0 ? `, ${textCount} transcribed as text` : ''),
        payload: {
          attachments: prepared.attachments.map((a) => ({
            fieldId: a.fieldId,
            path: a.path,
            mimeType: a.mimeType,
          })),
          transcripts: prepared.transcripts,
        },
      });
    }
    const stream = persistent
      ? runner.runAsync({
          userId,
          sessionId,
          newMessage,
          stateDelta: options.stateDelta,
          abortSignal: options.abortSignal,
          runConfig: { streamingMode: StreamingMode.SSE },
        })
      : runner.runEphemeral({
          userId,
          newMessage,
          stateDelta: options.stateDelta,
          runConfig: { streamingMode: StreamingMode.SSE },
        });

    await runWithProgressEmit(progress.emit, async () => {
      for await (const event of stream) {
        if (options.abortSignal?.aborted) {
          throw new Error('Run aborted');
        }
        options.onEvent?.(event);
        const summary = summarizeEvent(event);
        // Result.events keeps completed turns only; live onProgress still
        // streams partials for SSE / admin UI.
        if (!summary.partial) {
          events.push(summary);
        }

        progress.emit('agent.event', {
          author: summary.author,
          message: progressMessageForSummary(summary),
          agentEvent: summary,
        });

        if (summary.errorMessage) {
          runError = summary.errorMessage;
        }

        if (summary.isFinal && summary.text) {
          finalText = summary.text;
        }
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    progress.emit('run.failed', {
      message,
      author: options.agent.name,
      payload: { sessionId },
    });
    return {
      status: 'error',
      events,
      sessionId,
      userId,
      appName,
      agentName: options.agent.name,
      error: message,
      startedAt,
      finishedAt: new Date().toISOString(),
      modelsUsed: collectModelsUsed(events),
    };
  }

  const finishedAt = new Date().toISOString();
  if (runError && !finalText) {
    progress.emit('run.failed', {
      message: runError,
      author: options.agent.name,
      payload: { sessionId },
    });
    return {
      status: 'error',
      events,
      sessionId,
      userId,
      appName,
      agentName: options.agent.name,
      error: runError,
      startedAt,
      finishedAt,
      modelsUsed: collectModelsUsed(events),
    };
  }

  progress.emit('run.completed', {
    message: 'finished',
    author: options.agent.name,
    payload: {
      sessionId,
      status: 'finished',
      ...(finalText
        ? { finalTextChars: finalText.length }
        : {}),
    },
  });

  return {
    status: 'finished',
    finalText,
    events,
    sessionId,
    userId,
    appName,
    agentName: options.agent.name,
    startedAt,
    finishedAt,
    modelsUsed: collectModelsUsed(events),
  };
}

export type { Event };
