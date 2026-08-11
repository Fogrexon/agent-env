import type { Content } from '@google/genai';
import type { BaseLlm } from '@google/adk';
import type { LlmProviderId, ModelRef } from '@agent-env/shared';
import type { ProviderAttachment, ProviderMediaSupport } from './media.js';

/** Normalized chat turn for provider adapters (ADK-agnostic). */
export interface ProviderMessage {
  role: 'user' | 'model' | 'system';
  text: string;
}

/**
 * Vendor-neutral function tool passed to providers that can run tools
 * inside their own agent loop (e.g. Cursor SDK customTools).
 * `inputSchema` is standard JSON Schema (lowercase types).
 */
export interface ProviderToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ProviderGenerateRequest {
  model: string;
  params?: Record<string, unknown>;
  systemInstruction?: string;
  messages: ProviderMessage[];
  /** Raw ADK/genai contents when the adapter needs them (e.g. Gemini). */
  contents?: Content[];
  /**
   * Binary attachments extracted from the user turn (inlineData parts).
   * Already validated against `provider.media` by the caller.
   */
  attachments?: readonly ProviderAttachment[];
  /**
   * Function tools bridged from the agent framework. Only sent to providers
   * with `supportsTools === true`; the provider executes them in-loop and
   * returns the final text.
   */
  tools?: ProviderToolDefinition[];
}

export interface ProviderGenerateResult {
  text: string;
  modelVersion?: string;
  provider: LlmProviderId;
  model: string;
}

/**
 * Incremental chunk from {@link LlmProvider.generateStream}.
 * Prefer `delta` (append); otherwise treat `text` as a cumulative snapshot.
 */
export interface ProviderStreamChunk {
  delta?: string;
  text?: string;
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
  /**
   * True when generate() honors `request.tools` (in-loop tool execution).
   * Gemini bridges tools natively via createAdkLlm instead.
   */
  readonly supportsTools?: boolean;
  /**
   * MIME types this adapter actually forwards to the model.
   * Omitted / empty means the provider takes text only — attachments then fail
   * with UnsupportedMediaError instead of being silently dropped.
   */
  readonly media?: ProviderMediaSupport;
  isConfigured(): boolean;
  assertConfigured(): void;
  generate(
    request: ProviderGenerateRequest,
    abortSignal?: AbortSignal,
  ): Promise<ProviderGenerateResult>;
  /**
   * Optional token / delta stream. When omitted, callers fall back to
   * {@link generate}. The generator's return value is the final result.
   */
  generateStream?(
    request: ProviderGenerateRequest,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamChunk, ProviderGenerateResult, void>;
  /**
   * Optional ADK-native backend (used by Gemini for FunctionTools).
   * When present, resolveModel prefers this over ProviderBackedLlm.
   */
  createAdkLlm?(model: string): BaseLlm;
  /**
   * Optional live model inventory (bare model ids, not `provider:model`).
   * Callers fall back to a static catalog when this is missing or throws.
   */
  listModels?(): Promise<readonly string[]>;
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

export type { ModelRef, LlmProviderId, ProviderAttachment, ProviderMediaSupport };
