import {
  InMemoryRunner,
  isFinalResponse,
  stringifyContent,
  type BaseAgent,
  type Event,
} from '@google/adk';
import { createUserContent } from '@google/genai';
import { randomUUID } from 'node:crypto';
import type { AgentEventSummary, AgentRunResult } from '@agent-env/shared';
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
  return {
    author: event.author ?? 'system',
    isFinal: isFinalResponse(event),
    text: text.length > 0 ? text : undefined,
    errorMessage: event.errorMessage,
    branch: event.branch,
  };
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
  };
}

export type { Event };
