import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import type { LlmProviderId, ModelRef } from '@agent-env/shared';
import {
  contentsToMessages,
  systemInstructionToText,
} from './prompt.js';
import type { LlmProvider } from './types.js';

export interface ProviderBackedLlmOptions {
  modelRef: ModelRef;
  provider: LlmProvider;
}

/**
 * ADK BaseLlm bridge over an LlmProvider adapter.
 * Lets ParallelAgent / LlmAgent keep using ADK while the vendor is swappable.
 */
export class ProviderBackedLlm extends BaseLlm {
  readonly providerId: LlmProviderId;
  readonly modelRef: ModelRef;
  private readonly provider: LlmProvider;

  constructor(options: ProviderBackedLlmOptions) {
    super({ model: `${options.modelRef.provider}:${options.modelRef.model}` });
    this.providerId = options.modelRef.provider;
    this.modelRef = options.modelRef;
    this.provider = options.provider;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);

    const toolNames = Object.keys(llmRequest.toolsDict ?? {});
    if (toolNames.length > 0 && this.provider.kind !== 'gemini') {
      throw new Error(
        `Provider "${this.providerId}" does not bridge ADK FunctionTools yet (tools: ${toolNames.join(', ')}). Use a gemini provider for tool-using agents.`,
      );
    }

    const systemInstruction = systemInstructionToText(
      llmRequest.config?.systemInstruction,
    );
    const messages = contentsToMessages(llmRequest.contents);

    const result = await this.provider.generate(
      {
        model: this.modelRef.model,
        params: this.modelRef.params,
        systemInstruction,
        messages,
        contents: llmRequest.contents,
      },
      abortSignal,
    );

    const response: LlmResponse = {
      content: {
        role: 'model',
        parts: [{ text: result.text }],
      },
      turnComplete: true,
      modelVersion: result.modelVersion ?? this.modelRef.model,
      customMetadata: {
        provider: this.providerId,
        model: this.modelRef.model,
      },
    };
    yield response;
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(
      new Error(
        `Live connect is not supported for provider "${this.providerId}" via ProviderBackedLlm.`,
      ),
    );
  }
}
