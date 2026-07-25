import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { runWithLlmProgressAuthor } from './progress-context.js';

/**
 * Wraps a BaseLlm so each generateContentAsync / connect runs under an ALS
 * scope with `llmAuthor`. Mid-stream tool progress can then set parentAuthor
 * to this agent even when sibling agents stream in parallel.
 */
export class ProgressScopedLlm extends BaseLlm {
  private readonly inner: BaseLlm;
  private readonly author: string;

  constructor(inner: BaseLlm, author: string) {
    super({ model: inner.model });
    this.inner = inner;
    this.author = author;
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

/** Bind `author` onto a concrete BaseLlm; leave string model ids unchanged. */
export function bindLlmProgressAuthor(
  model: string | BaseLlm,
  author: string,
): string | BaseLlm {
  if (typeof model === 'string') return model;
  if (model instanceof ProgressScopedLlm) return model;
  return new ProgressScopedLlm(model, author);
}
