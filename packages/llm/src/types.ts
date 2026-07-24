import type { Content } from '@google/genai';
import type {
  LlmProviderId,
  ModelRef,
  ProviderCredentials,
} from '@agent-env/shared';

/** Normalized chat turn for provider adapters (ADK-agnostic). */
export interface ProviderMessage {
  role: 'user' | 'model' | 'system';
  text: string;
}

export interface ProviderGenerateRequest {
  model: string;
  params?: Record<string, unknown>;
  systemInstruction?: string;
  messages: ProviderMessage[];
  /** Raw ADK/genai contents when the adapter needs them (e.g. Gemini). */
  contents?: Content[];
}

export interface ProviderGenerateResult {
  text: string;
  modelVersion?: string;
  provider: LlmProviderId;
  model: string;
}

/**
 * Vendor-neutral LLM completion port.
 * Orchestration (ADK) stays separate; adapters implement this.
 */
export interface LlmProvider {
  readonly id: LlmProviderId;
  isConfigured(credentials: ProviderCredentials): boolean;
  assertConfigured(credentials: ProviderCredentials): void;
  generate(
    request: ProviderGenerateRequest,
    credentials: ProviderCredentials,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult>;
}

export type { ModelRef, ProviderCredentials, LlmProviderId };
