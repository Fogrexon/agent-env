import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentProgressKind } from '@agent-env/shared';

type ProgressEmit = (
  kind: AgentProgressKind,
  partial?: {
    message?: string;
    author?: string;
    parentAuthor?: string;
    payload?: Record<string, unknown>;
  },
) => void;

type ProgressStore = {
  emit: ProgressEmit;
  /** Agent author of the in-flight LLM generateContentAsync (parallel-safe). */
  llmAuthor?: string;
};

const progressAls = new AsyncLocalStorage<ProgressStore>();

/** Run `fn` with a progress emit bound for nested tool invocations. */
export function runWithProgressEmit<T>(
  emit: ProgressEmit,
  fn: () => Promise<T>,
): Promise<T> {
  return progressAls.run({ emit }, fn);
}

/**
 * Nest `fn` under the current progress store with an LLM author scope.
 * Used so mid-stream tools can tag `parentAuthor` without racing peers.
 */
export function runWithLlmProgressAuthor<T>(
  author: string,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = progressAls.getStore();
  if (!parent) return fn();
  return progressAls.run({ emit: parent.emit, llmAuthor: author }, fn);
}

/** Current LLM author from ALS, if a generateContentAsync scope is active. */
export function getLlmProgressAuthor(): string | undefined {
  return progressAls.getStore()?.llmAuthor;
}

/** Emit a progress event from inside a tool if a run is active. */
export function emitToolProgress(
  partial: {
    message?: string;
    author?: string;
    payload?: Record<string, unknown>;
  },
): void {
  const store = progressAls.getStore();
  if (!store) return;
  store.emit('agent.event', {
    author: partial.author ?? 'tool',
    message: partial.message,
    ...(store.llmAuthor ? { parentAuthor: store.llmAuthor } : {}),
    payload: partial.payload,
  });
}
