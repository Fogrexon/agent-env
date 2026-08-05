import {
  BaseLlm,
  LLMRegistry,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {
  parseProviderModelId,
  type LlmProviderId,
  type ModelRef,
} from '@agent-env/shared';
import { resolveModel } from './resolve.js';

const ROUTING_PATTERN = /^[^:\s]+:.+$/;

type RegistryInternals = {
  llmRegistryDict: Map<string | RegExp, unknown>;
  resolveCache: { cache?: Map<string, unknown> };
};

function mergeRoutedMetadata(
  response: LlmResponse,
  modelRef: ModelRef,
): LlmResponse {
  return {
    ...response,
    customMetadata: {
      ...response.customMetadata,
      provider: modelRef.provider,
      model: modelRef.model,
    },
  };
}

/**
 * ADK {@link LLMRegistry} entry for `provider:model` wire strings.
 * Resolves via the agent-env provider registry ({@link resolveModel}).
 */
export class RegistryRoutedLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    ROUTING_PATTERN,
  ];

  readonly providerId: LlmProviderId;
  readonly modelRef: ModelRef;
  private readonly inner: BaseLlm;

  constructor({ model }: { model: string }) {
    super({ model });
    this.modelRef = parseProviderModelId(model);
    this.providerId = this.modelRef.provider;
    this.inner = resolveModel(this.modelRef);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    for await (const response of this.inner.generateContentAsync(
      llmRequest,
      stream,
      abortSignal,
    )) {
      yield mergeRoutedMetadata(response, this.modelRef);
    }
  }

  override connect(llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return this.inner.connect(llmRequest);
  }
}

let registered = false;

/** Idempotent: register {@link RegistryRoutedLlm} with ADK LLMRegistry. */
export function registerAdkLlmRouting(): void {
  if (registered) return;
  LLMRegistry.register(RegistryRoutedLlm);
  registered = true;
}

/** Remove routing registration (tests). */
export function clearAdkLlmRouting(): void {
  if (!registered) return;
  const internals = LLMRegistry as unknown as RegistryInternals;
  internals.llmRegistryDict.delete(ROUTING_PATTERN);
  const cache = internals.resolveCache?.cache;
  if (cache) {
    for (const key of [...cache.keys()]) {
      if (ROUTING_PATTERN.test(key)) cache.delete(key);
    }
  }
  registered = false;
}
