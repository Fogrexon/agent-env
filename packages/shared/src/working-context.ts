import { z } from 'zod';

/** Status of one tool / environment observation returned into the loop. */
export const observationStatusSchema = z.enum([
  'ok',
  'error',
  'empty_success',
]);
export type ObservationStatus = z.infer<typeof observationStatusSchema>;

/** Where an observation or context fragment came from. */
export const observationSourceSchema = z.enum([
  'tool',
  'index',
  'memory',
  'agent',
  'user',
  'system',
]);
export type ObservationSource = z.infer<typeof observationSourceSchema>;

/**
 * Handle to the full (possibly oversized) payload kept outside working context.
 * Working context keeps the handle; full trace / workspace keeps the body.
 */
export const artifactHandleSchema = z.object({
  uri: z.string().min(1),
  digest: z.string().optional(),
  mediaType: z.string().optional(),
  byteLength: z.number().int().nonnegative().optional(),
});
export type ArtifactHandle = z.infer<typeof artifactHandleSchema>;

/**
 * Bounded observation contract for the loop plane.
 * Oversized content is truncated and pointed at via `handle`.
 */
export const boundedObservationSchema = z.object({
  status: observationStatusSchema,
  content: z.string(),
  source: observationSourceSchema,
  truncated: z.boolean().default(false),
  handle: artifactHandleSchema.optional(),
  toolName: z.string().optional(),
  observedAt: z.string().optional(),
});
export type BoundedObservation = z.infer<typeof boundedObservationSchema>;

/** Named sections a ContextBuilder may assemble into working context. */
export const contextSectionKindSchema = z.enum([
  'instruction',
  'task',
  'plan',
  'memory',
  'observation',
  'information',
]);
export type ContextSectionKind = z.infer<typeof contextSectionKindSchema>;

export const contextSectionSchema = z.object({
  kind: contextSectionKindSchema,
  title: z.string().min(1),
  content: z.string(),
  /** Higher = kept longer when over budget. Default by kind if omitted. */
  priority: z.number().int().optional(),
  /** Soft per-section token ceiling before global budgeting. */
  maxTokens: z.number().int().positive().optional(),
  handle: artifactHandleSchema.optional(),
});
export type ContextSection = z.infer<typeof contextSectionSchema>;

/** How to shrink tool history when the provider tool-loop nears the window. */
export const contextOverflowStrategySchema = z.enum([
  'truncate',
  'summarize',
  'truncate-then-summarize',
]);
export type ContextOverflowStrategy = z.infer<
  typeof contextOverflowStrategySchema
>;

/**
 * Provider-agnostic knobs for context-window guarding.
 * OpenAI-compatible tool loops consume these via ModelRef.params today;
 * other providers may adopt the same names as they grow tool loops.
 */
export const contextBudgetParamsSchema = z.object({
  contextWindow: z.number().int().positive(),
  reserveOutputTokens: z.number().int().positive().optional(),
  maxToolResultChars: z.number().int().positive().optional(),
  maxToolIterations: z.number().int().positive().optional(),
  contextOverflow: contextOverflowStrategySchema.optional(),
});
export type ContextBudgetParams = z.infer<typeof contextBudgetParamsSchema>;
