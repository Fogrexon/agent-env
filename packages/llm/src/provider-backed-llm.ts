import {
  BaseLlm,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import type { LlmProviderId, ModelRef } from '@agent-env/shared';
import { adkToolToProviderTool } from './adk-tool-bridge.js';
import { assertMediaSupported } from './media.js';
import {
  contentsToAttachments,
  contentsToMessages,
  systemInstructionToText,
} from './prompt.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStreamChunk,
  ProviderToolDefinition,
} from './types.js';

export interface ProviderBackedLlmOptions {
  modelRef: ModelRef;
  provider: LlmProvider;
}

function applyStreamChunk(
  cumulative: string,
  chunk: ProviderStreamChunk,
): string {
  if (typeof chunk.delta === 'string') {
    return cumulative + chunk.delta;
  }
  if (typeof chunk.text === 'string') {
    return chunk.text;
  }
  return cumulative;
}

function toLlmResponse(
  text: string,
  modelRef: ModelRef,
  providerId: LlmProviderId,
  opts: { partial: boolean; modelVersion?: string },
): LlmResponse {
  return {
    content: {
      role: 'model',
      parts: [{ text }],
    },
    partial: opts.partial,
    turnComplete: !opts.partial,
    modelVersion: opts.modelVersion ?? modelRef.model,
    customMetadata: {
      provider: providerId,
      model: modelRef.model,
    },
  };
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
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    this.maybeAppendUserContent(llmRequest);

    const adkTools = Object.values(llmRequest.toolsDict ?? {});
    let tools: ProviderToolDefinition[] | undefined;
    if (adkTools.length > 0 && this.provider.kind !== 'gemini') {
      if (!this.provider.supportsTools) {
        const toolNames = adkTools.map((tool) => tool.name);
        throw new Error(
          `Provider "${this.providerId}" does not bridge ADK FunctionTools (tools: ${toolNames.join(', ')}). Use a provider with supportsTools (e.g. cursor) or gemini.`,
        );
      }
      tools = adkTools.map((tool) => adkToolToProviderTool(tool));
    }

    const systemInstruction = systemInstructionToText(
      llmRequest.config?.systemInstruction,
    );
    const messages = contentsToMessages(llmRequest.contents);
    const attachments = contentsToAttachments(llmRequest.contents);
    assertMediaSupported(this.providerId, this.provider.media, attachments);

    const request: ProviderGenerateRequest = {
      model: this.modelRef.model,
      params: this.modelRef.params,
      systemInstruction,
      messages,
      contents: llmRequest.contents,
      ...(attachments.length > 0 ? { attachments } : {}),
      tools,
    };

    if (stream && this.provider.generateStream) {
      yield* this.streamFromProvider(request, abortSignal);
      return;
    }

    const result = await this.provider.generate(request, abortSignal);
    yield toLlmResponse(result.text, this.modelRef, this.providerId, {
      partial: false,
      modelVersion: result.modelVersion,
    });
  }

  private async *streamFromProvider(
    request: ProviderGenerateRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const gen = this.provider.generateStream!(request, abortSignal);
    let cumulative = '';
    let next = await gen.next();
    while (!next.done) {
      cumulative = applyStreamChunk(cumulative, next.value);
      if (cumulative.length > 0) {
        yield toLlmResponse(cumulative, this.modelRef, this.providerId, {
          partial: true,
        });
      }
      next = await gen.next();
    }
    const result: ProviderGenerateResult = next.value;
    yield toLlmResponse(result.text, this.modelRef, this.providerId, {
      partial: false,
      modelVersion: result.modelVersion,
    });
  }

  override connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return Promise.reject(
      new Error(
        `Live connect is not supported for provider "${this.providerId}" via ProviderBackedLlm.`,
      ),
    );
  }
}
