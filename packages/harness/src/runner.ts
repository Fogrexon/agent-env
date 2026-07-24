import {
  InMemoryRunner,
  isFinalResponse,
  stringifyContent,
  type BaseAgent,
  type Event,
} from '@google/adk';
import { createUserContent } from '@google/genai';
import { randomUUID } from 'node:crypto';
import {
  llmProviderIdSchema,
  type AgentEventSummary,
  type AgentRunResult,
  type ModelRef,
} from '@agent-env/shared';
import { assertApiKey, loadHarnessConfig } from './config.js';

export interface RunAgentOptions {
  agent: BaseAgent;
  message: string;
  /** Defaults from env / harness config. */
  appName?: string;
  userId?: string;
  sessionId?: string;
  stateDelta?: Record<string, unknown>;
  /**
   * When true (default), create a named session and use `runAsync`
   * so multi-turn / resume is possible.
   * When false, use `runEphemeral` for fire-and-forget runs.
   */
  persistent?: boolean;
  /** Optional live event sink (CLI logs, future web SSE). */
  onEvent?: (event: Event) => void;
  abortSignal?: AbortSignal;
}

function summarizeEvent(event: Event): AgentEventSummary {
  const text = stringifyContent(event).trim();
  const meta = event.customMetadata as Record<string, unknown> | undefined;
  const providerRaw = meta?.['provider'];
  const modelRaw = meta?.['model'];
  const providerParsed =
    typeof providerRaw === 'string'
      ? llmProviderIdSchema.safeParse(providerRaw)
      : null;

  return {
    author: event.author ?? 'system',
    isFinal: isFinalResponse(event),
    text: text.length > 0 ? text : undefined,
    errorMessage: event.errorMessage,
    branch: event.branch,
    provider: providerParsed?.success ? providerParsed.data : undefined,
    model: typeof modelRaw === 'string' ? modelRaw : undefined,
  };
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
  const config = loadHarnessConfig({
    appName: options.appName,
    userId: options.userId,
  });
  assertApiKey(config);

  const startedAt = new Date().toISOString();
  const appName = options.appName ?? config.appName;
  const userId = options.userId ?? config.userId;
  const sessionId = options.sessionId ?? randomUUID();
  const persistent = options.persistent ?? true;

  const runner = new InMemoryRunner({
    agent: options.agent,
    appName,
  });

  const events: AgentEventSummary[] = [];
  let finalText: string | undefined;
  let runError: string | undefined;

  try {
    if (persistent) {
      await runner.sessionService.createSession({
        appName,
        userId,
        sessionId,
      });
    }

    const newMessage = createUserContent(options.message);
    const stream = persistent
      ? runner.runAsync({
          userId,
          sessionId,
          newMessage,
          stateDelta: options.stateDelta,
          abortSignal: options.abortSignal,
        })
      : runner.runEphemeral({
          userId,
          newMessage,
          stateDelta: options.stateDelta,
        });

    for await (const event of stream) {
      options.onEvent?.(event);
      const summary = summarizeEvent(event);
      events.push(summary);

      if (summary.errorMessage) {
        runError = summary.errorMessage;
      }

      if (summary.isFinal && summary.text) {
        finalText = summary.text;
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
