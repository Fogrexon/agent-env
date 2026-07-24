import { z } from 'zod';

/** Default Gemini model used across templates unless overridden. */
export const DEFAULT_MODEL = 'gemini-2.5-flash' as const;

export const agentRunStatusSchema = z.enum(['finished', 'error']);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentEventSummarySchema = z.object({
  author: z.string(),
  isFinal: z.boolean(),
  text: z.string().optional(),
  errorMessage: z.string().optional(),
  branch: z.string().optional(),
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
});
export type AgentRunResult = z.infer<typeof agentRunResultSchema>;

/** Registry metadata for discovering agents (CLI / future admin UI). */
export const agentManifestSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /** Path relative to repo root, e.g. agents/hello/agent.ts */
  entry: z.string().min(1),
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const harnessConfigSchema = z.object({
  model: z.string().default(DEFAULT_MODEL),
  appName: z.string().default('agent-env'),
  userId: z.string().default('local-user'),
  geminiApiKey: z.string().optional(),
});
export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
