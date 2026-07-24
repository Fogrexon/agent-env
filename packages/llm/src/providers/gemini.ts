import { GoogleGenAI } from '@google/genai';
import { Gemini, type BaseLlm } from '@google/adk';
import type {
  LlmProvider,
  ProviderGenerateRequest,
  ProviderGenerateResult,
  SecretSource,
} from '../types.js';
import { resolveSecret } from '../types.js';

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

    createAdkLlm(model: string): BaseLlm {
      this.assertConfigured();
      const vertex = resolveVertex(options.vertex);
      if (vertex) {
        return new Gemini({
          model,
          vertexai: true,
          project: vertex.project,
          location: vertex.location,
        });
      }
      return new Gemini({
        model,
        apiKey: resolveSecret(options.apiKey),
      });
    },

    async generate(
      request: ProviderGenerateRequest,
      abortSignal?: AbortSignal,
    ): Promise<ProviderGenerateResult> {
      this.assertConfigured();
      const vertex = resolveVertex(options.vertex);
      const client = vertex
        ? new GoogleGenAI({
            vertexai: true,
            project: vertex.project,
            location: vertex.location,
          })
        : new GoogleGenAI({ apiKey: resolveSecret(options.apiKey)! });

      const contents =
        request.contents ??
        request.messages.map((message) => ({
          role: message.role === 'model' ? 'model' : 'user',
          parts: [{ text: message.text }],
        }));

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
  };
}
