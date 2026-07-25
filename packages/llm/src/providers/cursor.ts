import { Agent } from '@cursor/sdk';
import type {
  ModelParameterValue,
  Run,
  RunResult,
  SDKCustomTool,
  SDKCustomToolResult,
  SDKImage,
  SDKJsonValue,
} from '@cursor/sdk';
import {
  assertMediaSupported,
  IMAGE_MIME_TYPES,
  type ProviderAttachment,
  type ProviderMediaSupport,
} from '../media.js';
import { messagesToPrompt } from '../prompt.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStreamChunk,
  ProviderToolDefinition,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

/**
 * The Cursor SDK user message carries `images` only (SDKUserMessage.images);
 * there is no audio / video / document channel.
 */
export const CURSOR_MEDIA_SUPPORT: ProviderMediaSupport = {
  mimeTypes: [...IMAGE_MIME_TYPES],
  notes: 'Cursor accepts images only (SDKUserMessage.images).',
};

export interface CreateCursorProviderOptions {
  id?: string;
  apiKey: SecretSource;
  /** Working directory for local Cursor agent runs. Default: process.cwd(). */
  cwd?: string | (() => string);
}

function toCursorModelParams(
  params: Record<string, unknown> | undefined,
): ModelParameterValue[] | undefined {
  if (!params || Object.keys(params).length === 0) return undefined;
  return Object.entries(params).map(([paramId, value]) => ({
    id: paramId,
    value: String(value),
  }));
}

/**
 * Bridge vendor-neutral tool definitions to Cursor SDK customTools
 * (exposed to the model as the in-process "custom-user-tools" MCP server).
 */
function toCursorCustomTools(
  tools: ProviderToolDefinition[] | undefined,
): Record<string, SDKCustomTool> | undefined {
  if (!tools?.length) return undefined;

  const entries = tools.map((tool) => {
    const customTool: SDKCustomTool = {
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.inputSchema
        ? { inputSchema: tool.inputSchema as Record<string, SDKJsonValue> }
        : {}),
      execute: async (args): Promise<SDKCustomToolResult> => {
        const result = await tool.execute(args as Record<string, unknown>);
        if (typeof result === 'string') return result;
        // JSON round-trip guarantees an SDKJsonValue-compatible payload.
        return JSON.parse(JSON.stringify(result ?? null)) as SDKJsonValue;
      },
    };
    return [tool.name, customTool] as const;
  });
  return Object.fromEntries(entries);
}

function toCursorImages(
  attachments: readonly ProviderAttachment[],
): SDKImage[] {
  return attachments.map((attachment) => ({
    data: attachment.data,
    mimeType: attachment.mimeType,
  }));
}

function resultToGenerate(
  result: RunResult,
  request: ProviderGenerateRequest,
  providerId: string,
): ProviderGenerateResult {
  if (result.status === 'error' || result.status === 'cancelled') {
    throw new Error(
      result.error?.message ??
        `Cursor run ${result.status} (id=${result.id})`,
    );
  }
  return {
    text: result.result?.trim() ?? '',
    modelVersion: result.model?.id ?? request.model,
    provider: providerId,
    model: request.model,
  };
}

function wireAbort(run: Run, abortSignal?: AbortSignal): () => void {
  if (!abortSignal) return () => undefined;
  const onAbort = () => {
    void run.cancel().catch(() => {
      // ignore cancel races
    });
  };
  if (abortSignal.aborted) {
    onAbort();
    return () => undefined;
  }
  abortSignal.addEventListener('abort', onAbort, { once: true });
  return () => abortSignal.removeEventListener('abort', onAbort);
}

export function createCursorProvider(
  options: CreateCursorProviderOptions,
): LlmProvider {
  const id = options.id ?? 'cursor';

  return {
    id,
    kind: 'cursor',
    supportsTools: true,
    media: CURSOR_MEDIA_SUPPORT,

    isConfigured(): boolean {
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          `Cursor provider "${id}" has no API key. Pass apiKey when calling createCursorProvider().`,
        );
      }
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();

      if (abortSignal?.aborted) {
        throw new Error('Cursor generate aborted before start');
      }

      const prompt = messagesToPrompt(
        request.systemInstruction,
        request.messages,
      );
      const params = toCursorModelParams(request.params);
      const cwd =
        typeof options.cwd === 'function'
          ? options.cwd()
          : (options.cwd ?? process.cwd());

      const customTools = toCursorCustomTools(request.tools);
      const attachments = request.attachments ?? [];
      assertMediaSupported(id, CURSOR_MEDIA_SUPPORT, attachments);

      const agentOptions = {
        apiKey: resolveSecret(options.apiKey)!,
        model: {
          id: request.model,
          ...(params ? { params } : {}),
        },
        local: {
          cwd,
          ...(customTools ? { customTools } : {}),
        },
      };

      // Agent.prompt takes plain text only; images need the create/send path.
      let result: RunResult;
      if (attachments.length > 0 || customTools) {
        const agent = await Agent.create(agentOptions);
        try {
          const run = await agent.send({
            text: prompt,
            ...(attachments.length > 0
              ? { images: toCursorImages(attachments) }
              : {}),
          });
          const unwire = wireAbort(run, abortSignal);
          try {
            result = await run.wait();
          } finally {
            unwire();
          }
        } finally {
          agent.close();
        }
      } else {
        result = await Agent.prompt(prompt, agentOptions);
      }

      if (abortSignal?.aborted) {
        throw new Error('Cursor generate aborted');
      }

      return resultToGenerate(result, request, id);
    },

    async *generateStream(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): AsyncGenerator<ProviderStreamChunk, ProviderGenerateResult, void> {
      this.assertConfigured();

      if (abortSignal?.aborted) {
        throw new Error('Cursor generate aborted before start');
      }

      const prompt = messagesToPrompt(
        request.systemInstruction,
        request.messages,
      );
      const params = toCursorModelParams(request.params);
      const cwd =
        typeof options.cwd === 'function'
          ? options.cwd()
          : (options.cwd ?? process.cwd());

      const customTools = toCursorCustomTools(request.tools);
      const attachments = request.attachments ?? [];
      assertMediaSupported(id, CURSOR_MEDIA_SUPPORT, attachments);

      const agent = await Agent.create({
        apiKey: resolveSecret(options.apiKey)!,
        model: {
          id: request.model,
          ...(params ? { params } : {}),
        },
        local: {
          cwd,
          ...(customTools ? { customTools } : {}),
        },
      });

      try {
        // Queue deltas from onDelta so the async generator can yield them.
        const pending: ProviderStreamChunk[] = [];
        let wake: (() => void) | undefined;
        let finished = false;
        let runError: unknown;

        const notify = () => {
          wake?.();
          wake = undefined;
        };

        const run = await agent.send(
          {
            text: prompt,
            ...(attachments.length > 0
              ? { images: toCursorImages(attachments) }
              : {}),
          },
          {
            onDelta: ({ update }) => {
              if (update.type === 'text-delta' && update.text) {
                pending.push({ delta: update.text });
                notify();
              }
            },
          },
        );
        const unwire = wireAbort(run, abortSignal);

        const waitPromise = run
          .wait()
          .then((result) => {
            finished = true;
            notify();
            return result;
          })
          .catch((err: unknown) => {
            runError = err;
            finished = true;
            notify();
            throw err;
          })
          .finally(() => {
            unwire();
          });

        while (!finished || pending.length > 0) {
          if (pending.length > 0) {
            yield pending.shift()!;
            continue;
          }
          if (finished) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }

        if (runError) throw runError;
        const result = await waitPromise;
        if (abortSignal?.aborted) {
          throw new Error('Cursor generate aborted');
        }
        return resultToGenerate(result, request, id);
      } finally {
        agent.close();
      }
    },
  };
}
