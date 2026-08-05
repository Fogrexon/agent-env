import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { materializeAgentModel } from '@agent-env/llm';
import { runWithLlmProgressAuthor } from './progress-context.js';

/**
 * Wraps a BaseLlm so each generateContentAsync / connect runs under an ALS
 * scope with `llmAuthor`. Mid-stream tool progress can then set parentAuthor
 * to this agent even when sibling agents stream in parallel.
 */
export class ProgressScopedLlm extends BaseLlm {
  private readonly inner: BaseLlm;
  private readonly author: string;
  /** Forwarded from inner when present (ProviderBackedLlm / RegistryRoutedLlm). */
  readonly providerId?: string;

  constructor(inner: BaseLlm, author: string) {
    super({ model: inner.model });
    this.inner = inner;
    this.author = author;
    const id = (inner as { providerId?: unknown }).providerId;
    if (typeof id === 'string') this.providerId = id;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const inner = this.inner.generateContentAsync(
      llmRequest,
      stream,
      abortSignal,
    );
    while (true) {
      const next = await runWithLlmProgressAuthor(this.author, () =>
        inner.next(),
      );
      if (next.done) return;
      yield next.value;
    }
  }

  override connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return runWithLlmProgressAuthor(this.author, () =>
      this.inner.connect(llmRequest),
    );
  }
}

/**
 * Bind `author` onto a concrete BaseLlm.
 * Registry `provider:model` strings are materialized first so progress
 * wrapping always sits on a real adapter.
 */
export function bindLlmProgressAuthor(
  model: string | BaseLlm,
  author: string,
): BaseLlm {
  const concrete = materializeAgentModel(model);
  if (concrete instanceof ProgressScopedLlm) return concrete;
  return new ProgressScopedLlm(concrete, author);
}
