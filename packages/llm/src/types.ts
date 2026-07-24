import type { Content } from '@google/genai';
import type { BaseLlm } from '@google/adk';
import type { LlmProviderId, ModelRef } from '@agent-env/shared';

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
 * Secrets (API keys, etc.) are closed over at construction time by the
 * caller / provider factory — not passed through a global credentials bag.
 */
export interface LlmProvider {
  readonly id: LlmProviderId;
  /** Optional taxonomy hint, e.g. "openai-compatible". */
  readonly kind?: string;
  isConfigured(): boolean;
  assertConfigured(): void;
  generate(
    request: ProviderGenerateRequest,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult>;
  /**
   * Optional ADK-native backend (used by Gemini for FunctionTools).
   * When present, resolveModel prefers this over ProviderBackedLlm.
   */
  createAdkLlm?(model: string): BaseLlm;
}

/** string | lazy getter — how you load the secret is your concern. */
export type SecretSource = string | (() => string | undefined | null);

export function resolveSecret(
  source: SecretSource | undefined,
): string | undefined {
  if (source == null) return undefined;
  const value = typeof source === 'function' ? source() : source;
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type { ModelRef, LlmProviderId };
