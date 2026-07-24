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
] as const;

/**
 * Provider-qualified model binding.
 * `provider` must match a registered LlmProvider id.
 */
export const modelRefSchema = z.object({
  provider: llmProviderIdSchema,
  model: z.string().min(1),
  /** Provider-specific knobs (temperature, Cursor params, …). */
  params: z.record(z.string(), z.unknown()).optional(),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

/** Default Gemini model id used when provider is gemini. */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash' as const;

/** @deprecated Prefer DEFAULT_MODEL_REF. Kept for string-only call sites. */
export const DEFAULT_MODEL = DEFAULT_GEMINI_MODEL;

export const DEFAULT_MODEL_REF: ModelRef = {
  provider: 'gemini',
  model: DEFAULT_GEMINI_MODEL,
};

export const DEFAULT_CURSOR_MODEL = 'composer-2' as const;
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini' as const;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-5' as const;
export const DEFAULT_OPENAI_COMPATIBLE_MODEL = 'local-model' as const;

export const agentRunStatusSchema = z.enum(['finished', 'error']);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentEventSummarySchema = z.object({
  author: z.string(),
  isFinal: z.boolean(),
  text: z.string().optional(),
  errorMessage: z.string().optional(),
  branch: z.string().optional(),
  provider: llmProviderIdSchema.optional(),
  model: z.string().optional(),
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

/** Registry metadata for discovering agents (CLI / future admin UI). */
export const agentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  entry: z.string().min(1),
  models: z.array(modelRefSchema).optional(),
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
