import { z } from 'zod';

/**
 * Provider id is an opaque string (registry key).
 * Built-in factories often use "gemini" / "openai" / …;
 * openai-compatible backends should use distinct ids (e.g. "lm-studio", "ollama").
 */
export const llmProviderIdSchema = z.string().min(1);
export type LlmProviderId = z.infer<typeof llmProviderIdSchema>;

/** Well-known ids used by optional harness bootstrap — not an exclusive set. */
export const WELL_KNOWN_PROVIDER_IDS = [
  'gemini',
  'cursor',
  'openai',
  'anthropic',
  'openrouter',
] as const;

/**
 * Provider-qualified model id used in LlmAgent.model strings.
 * Format: `provider:model` (first colon splits; model may contain colons).
 */
export type ProviderModelId = `${string}:${string}`;

export const providerModelIdSchema = z
  .string()
  .min(3)
  .refine((value) => {
    const colon = value.indexOf(':');
    return colon > 0 && colon < value.length - 1 && !/\s/.test(value);
  }, 'expected provider:model')
  .transform((value) => value as ProviderModelId);

/**
 * Provider-qualified model binding (internal / telemetry / advanced params).
 * Agent authors prefer `provider:model` strings via ADK LLMRegistry routing.
 */
export const modelRefSchema = z.object({
  provider: llmProviderIdSchema,
  model: z.string().min(1),
  /** Provider-specific knobs (temperature, Cursor params, …). */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

/** Format a ModelRef as a provider-qualified wire string. */
export function formatModelRef(ref: ModelRef): ProviderModelId {
  return `${ref.provider}:${ref.model}` as ProviderModelId;
}

/**
 * Parse `provider:model`. Rejects bare model ids (no colon).
 * Does not read process.env — pass the raw string from the caller.
 */
export function parseProviderModelId(raw: string): ModelRef {
  const text = raw.trim();
  const colon = text.indexOf(':');
  if (colon <= 0 || colon >= text.length - 1 || /\s/.test(text)) {
    throw new Error(
      `Invalid provider model id "${raw}". Expected "provider:model" (bare model ids are not allowed).`,
    );
  }
  return {
    provider: llmProviderIdSchema.parse(text.slice(0, colon)),
    model: text.slice(colon + 1),
  };
}

/** Default Gemini model id used when provider is gemini. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash' as const;

/** @deprecated Prefer DEFAULT_MODEL_REF. Kept for string-only call sites. */
export const DEFAULT_MODEL = DEFAULT_GEMINI_MODEL;

export const DEFAULT_MODEL_REF: ModelRef = {
  provider: 'gemini',
  model: DEFAULT_GEMINI_MODEL,
};

/**
 * Cursor SDK Auto (`id: "default"`, alias `"auto"` from `Cursor.models.list()`).
 * Prefer the alias so demos / docs read as "Auto".
 */
export const DEFAULT_CURSOR_MODEL = 'auto' as const;
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini' as const;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6' as const;
/** OpenRouter model id (provider/model path on openrouter.ai). */
export const DEFAULT_OPENROUTER_MODEL = 'openai/gpt-4o-mini' as const;
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'local-model' as const;

export const agentRunStatusSchema = z.enum(['finished', 'error']);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentFunctionCallSummarySchema = z.object({
  name: z.string().optional(),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type AgentFunctionCallSummary = z.infer<
  typeof agentFunctionCallSummarySchema
>;

export const agentFunctionResponseSummarySchema = z.object({
  name: z.string().optional(),
  /** Truncated / sanitized tool response payload. */
  response: z.unknown().optional(),
});
export type AgentFunctionResponseSummary = z.infer<
  typeof agentFunctionResponseSummarySchema
>;

export const agentEventSummarySchema = z.object({
  author: z.string(),
  isFinal: z.boolean(),
  /** True while the model is still streaming this text. */
  partial: z.boolean().optional(),
  text: z.string().optional(),
  errorMessage: z.string().optional(),
  branch: z.string().optional(),
  provider: llmProviderIdSchema.optional(),
  model: z.string().optional(),
  functionCalls: z.array(agentFunctionCallSummarySchema).optional(),
  functionResponses: z.array(agentFunctionResponseSummarySchema).optional(),
});
export type AgentEventSummary = z.infer<typeof agentEventSummarySchema>;

/**
 * Normalized result of a harness run.
 * Shared with future web admin / API layers.
 */
export const agentRunResultSchema = z.object({
  status: agentRunStatusSchema,
  finalText: z.string().optional(),
  events: z.array(agentEventSummarySchema),
  sessionId: z.string(),
  userId: z.string(),
  appName: z.string(),
  agentName: z.string(),
  error: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string(),
  modelsUsed: z.array(modelRefSchema).optional(),
});
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;

export const agentModeSchema = z.enum(['interactive', 'autonomous']);
export type AgentMode = z.infer<typeof agentModeSchema>;

/** Manifest metadata produced by repo-local discovery (not stored in packages). */
export const agentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  entry: z.string().min(1),
  models: z.array(modelRefSchema).optional(),
  /** Repo-relative path to AgentParams YAML when present. */
  paramsFile: z.string().min(1).optional(),
  /**
   * How the host should present and run this agent.
   * interactive = chat-style; autonomous = batch / one-shot jobs.
   * Omitted → treated as autonomous.
   */
  mode: agentModeSchema.optional(),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const harnessConfigSchema = z.object({
  defaultModel: modelRefSchema.default(DEFAULT_MODEL_REF),
  /** @deprecated Prefer defaultModel. */
  model: z.string().optional(),
  appName: z.string().default('agent-env'),
  userId: z.string().default('local-user'),
});
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
