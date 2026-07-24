import { z } from 'zod';

/** Built-in LLM provider ids. Extend when adding adapters. */
export const LLM_PROVIDER_IDS = [
  'gemini',
  'cursor',
  'openai',
  'anthropic',
  'openai-compatible',
] as const;

export const llmProviderIdSchema = z.enum(LLM_PROVIDER_IDS);
export type LlmProviderId = z.infer<typeof llmProviderIdSchema>;

/**
 * Provider-qualified model binding.
 * Agents/sub-agents declare this instead of a bare Gemini model string.
 */
export const modelRefSchema = z.object({
  provider: llmProviderIdSchema,
  model: z.string().min(1),
  /**
   * Provider-specific knobs.
   * Examples:
   * - Cursor: `{ fast: true }` → mapped to model.params
   * - openai-compatible: `{ baseUrl: "http://127.0.0.1:1234/v1" }`
   */
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
/** LM Studio default OpenAI-compatible endpoint. */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL =
  'http://127.0.0.1:1234/v1' as const;

export const agentRunStatusSchema = z.enum(['finished', 'error']);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentEventSummarySchema = z.object({
  author: z.string(),
  isFinal: z.boolean(),
  text: z.string().optional(),
  errorMessage: z.string().optional(),
  branch: z.string().optional(),
  /** Present when the event carries provider metadata. */
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
  /** Models observed during the run (best-effort). */
  modelsUsed: z.array(modelRefSchema).optional(),
});
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;

/** Registry metadata for discovering agents (CLI / future admin UI). */
export const agentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Path relative to repo root, e.g. agents/hello/agent.ts */
  entry: z.string().min(1),
  /** Optional default / documented model bindings for this agent. */
  models: z.array(modelRefSchema).optional(),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const providerCredentialsSchema = z.object({
  geminiApiKey: z.string().optional(),
  cursorApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  /** Optional override for the official OpenAI client (rare). */
  openaiBaseUrl: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  /**
   * Base URL for OpenAI-compatible servers (LM Studio, Ollama, vLLM, etc.).
   * Example: http://127.0.0.1:1234/v1
   */
  openaiCompatibleBaseUrl: z.string().optional(),
  /** Optional; many local servers accept any / empty key. */
  openaiCompatibleApiKey: z.string().optional(),
});
export type ProviderCredentials = z.infer<typeof providerCredentialsSchema>;

export const harnessConfigSchema = z.object({
  defaultModel: modelRefSchema.default(DEFAULT_MODEL_REF),
  /** @deprecated Prefer defaultModel. Still accepted for older env wiring. */
  model: z.string().optional(),
  appName: z.string().default('agent-env'),
  userId: z.string().default('local-user'),
  credentials: providerCredentialsSchema.default({}),
  /** @deprecated Prefer credentials.geminiApiKey */
  geminiApiKey: z.string().optional(),
});
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
