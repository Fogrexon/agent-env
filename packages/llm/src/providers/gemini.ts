import { GoogleGenAI } from '@google/genai';
import {
  Gemini,
  type BaseLlm,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import {
  assertMediaSupported,
  GEMINI_AUDIO_MIME_TYPES,
  GEMINI_IMAGE_MIME_TYPES,
  GEMINI_VIDEO_MIME_TYPES,
  PDF_MIME_TYPE,
  TEXT_MIME_TYPES,
  type ProviderMediaSupport,
} from '../media.js';
import { contentsToAttachments } from '../prompt.js';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  ProviderStreamChunk,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

/**
 * Gemini accepts the widest inline media set of the registered providers.
 * 20 MB is the documented inline-request ceiling; larger files need the Files API.
 */
export const GEMINI_MEDIA_SUPPORT: ProviderMediaSupport = {
  mimeTypes: [
    ...GEMINI_IMAGE_MIME_TYPES,
    ...GEMINI_AUDIO_MIME_TYPES,
    ...GEMINI_VIDEO_MIME_TYPES,
    PDF_MIME_TYPE,
    ...TEXT_MIME_TYPES,
  ],
  maxBytesPerFile: 20 * 1024 * 1024,
  notes: 'Inline data only; files above 20MB require the Gemini Files API.',
};

/** ADK-native Gemini that rejects media the provider does not declare. */
class MediaGuardedGemini extends Gemini {
  readonly providerId: string;

  constructor(params: ConstructorParameters<typeof Gemini>[0] & { providerId: string }) {
    const { providerId, ...rest } = params;
    super(rest as ConstructorParameters<typeof Gemini>[0]);
    this.providerId = providerId;
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    assertMediaSupported(
      this.providerId,
      GEMINI_MEDIA_SUPPORT,
      contentsToAttachments(llmRequest.contents),
    );
    yield* super.generateContentAsync(llmRequest, stream, abortSignal);
  }
}

/** Project / location / region string or lazy getter (caller injects; no process.env). */
export type ConfigStringSource = SecretSource;

export interface GeminiVertexOptions {
  /** GCP project id (ADC). */
  project: ConfigStringSource;
  /** Vertex location, e.g. "us-central1". */
  location: ConfigStringSource;
}

export interface CreateGeminiProviderOptions {
  /** Registry id. Default: "gemini". */
  id?: string;
  /**
   * Gemini Developer API key.
   * Omit when using `vertex` (Application Default Credentials).
   */
  apiKey?: SecretSource;
  /**
   * Vertex AI via ADC (`google-auth-library` default chain).
   * When set, `apiKey` is ignored.
   */
  vertex?: GeminiVertexOptions;
}

function resolveVertex(
  vertex: GeminiVertexOptions | undefined,
): { project: string; location: string } | undefined {
  if (!vertex) return undefined;
  const project = resolveSecret(vertex.project);
  const location = resolveSecret(vertex.location);
  if (!project || !location) return undefined;
  return { project, location };
}

export function createGeminiProvider(
  options: CreateGeminiProviderOptions,
): LlmProvider {
  const id = options.id ?? 'gemini';

  if (!options.apiKey && !options.vertex) {
    throw new Error(
      `Gemini provider "${id}" requires apiKey or vertex ({ project, location }).`,
    );
  }

  return {
    id,
    kind: 'gemini',
    media: GEMINI_MEDIA_SUPPORT,

    isConfigured(): boolean {
      if (options.vertex) return Boolean(resolveVertex(options.vertex));
      return Boolean(resolveSecret(options.apiKey));
    },

    assertConfigured(): void {
      if (!this.isConfigured()) {
        throw new Error(
          options.vertex
            ? `Gemini provider "${id}" Vertex mode needs project and location.`
            : `Gemini provider "${id}" has no API key. Pass apiKey when calling createGeminiProvider().`,
        );
      }
    },

    async listModels(): Promise<readonly string[]> {
      this.assertConfigured();
      const client = createGeminiClient(options);
      const pager = await client.models.list({
        config: { queryBase: true },
      });
      const ids: string[] = [];
      for await (const model of pager) {
        const actions = model.supportedActions;
        if (
          actions?.length &&
          !actions.includes('generateContent') &&
          !actions.includes('generateContentStream')
        ) {
          continue;
        }
        const raw = model.name?.trim();
        if (!raw) continue;
        const bare = raw.replace(/^models\//, '');
        if (bare) ids.push(bare);
      }
      return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    },

    createAdkLlm(model: string): BaseLlm {
      this.assertConfigured();
      const vertex = resolveVertex(options.vertex);
      if (vertex) {
        return new MediaGuardedGemini({
          providerId: id,
          model,
          vertexai: true,
          project: vertex.project,
          location: vertex.location,
        });
      }
      return new MediaGuardedGemini({
        providerId: id,
        model,
        apiKey: resolveSecret(options.apiKey),
      });
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();
      const { client, contents } = buildGeminiRequest(id, options, request);

      const response = await client.models.generateContent({
        model: request.model,
        contents,
        config: {
          systemInstruction: request.systemInstruction,
          abortSignal,
        },
      });

      return {
        text: response.text?.trim() ?? '',
        modelVersion: request.model,
        provider: id,
        model: request.model,
      };
    },

    async *generateStream(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): AsyncGenerator<ProviderStreamChunk, ProviderGenerateResult, void> {
      this.assertConfigured();
      const { client, contents } = buildGeminiRequest(id, options, request);

      const stream = await client.models.generateContentStream({
        model: request.model,
        contents,
        config: {
          systemInstruction: request.systemInstruction,
          abortSignal,
        },
      });

      let text = '';
      for await (const chunk of stream) {
        const piece = chunk.text;
        if (typeof piece === 'string' && piece.length > 0) {
          // Gemini stream chunks are cumulative snapshots in some SDKs and
          // deltas in others; prefer delta when the chunk is a suffix.
          if (piece.startsWith(text)) {
            const delta = piece.slice(text.length);
            text = piece;
            if (delta) yield { delta };
          } else {
            text += piece;
            yield { delta: piece };
          }
        }
      }

      return {
        text: text.trim(),
        modelVersion: request.model,
        provider: id,
        model: request.model,
      };
    },
  };
}

function buildGeminiRequest(
  id: string,
  options: CreateGeminiProviderOptions,
  request: ProviderGenerateRequest,
) {
  const client = createGeminiClient(options);

  const attachments = request.attachments ?? [];
  assertMediaSupported(id, GEMINI_MEDIA_SUPPORT, attachments);

  const contents =
    request.contents ??
    request.messages.map((message, index) => ({
      role: message.role === 'model' ? 'model' : 'user',
      parts: [
        { text: message.text },
        ...(index === request.messages.length - 1
          ? attachments.map((attachment) => ({
              inlineData: {
                data: attachment.data,
                mimeType: attachment.mimeType,
              },
            }))
          : []),
      ],
    }));

  return { client, contents };
}

function createGeminiClient(options: CreateGeminiProviderOptions): GoogleGenAI {
  const vertex = resolveVertex(options.vertex);
  return vertex
    ? new GoogleGenAI({
        vertexai: true,
        project: vertex.project,
        location: vertex.location,
      })
    : new GoogleGenAI({ apiKey: resolveSecret(options.apiKey)! });
}
