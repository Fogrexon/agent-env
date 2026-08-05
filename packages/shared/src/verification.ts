import { z } from 'zod';

/** Base directory a verifier path/command resolves against. */
export const verifyBaseDirSchema = z.enum(['workspace', 'repo']);
export type VerifyBaseDir = z.infer<typeof verifyBaseDirSchema>;

export const verificationSeveritySchema = z.enum(['required', 'advisory']);
export type VerificationSeverity = z.infer<typeof verificationSeveritySchema>;

export const verificationCheckKindSchema = z.enum([
  'command',
  'artifact',
  'document',
  'jsonSchema',
  'contains',
  'nonEmpty',
  'custom',
  'agent',
]);
export type VerificationCheckKind = z.infer<typeof verificationCheckKindSchema>;

const checkBase = z.object({
  id: z.string().min(1),
  severity: verificationSeveritySchema.default('required'),
});

export const commandCheckSchema = checkBase.extend({
  kind: z.literal('command'),
  bin: z.string().min(1),
  args: z.array(z.string()).default([]),
  baseDir: verifyBaseDirSchema.default('workspace'),
  subdir: z.string().optional(),
  expectExitCode: z.number().int().default(0),
  outputContains: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().default(120_000),
  shell: z.boolean().default(false),
});

export const artifactCheckSchema = checkBase.extend({
  kind: z.literal('artifact'),
  artifactId: z.string().min(1),
  mediaTypes: z.array(z.string().min(1)).min(1),
  minBytes: z.number().int().nonnegative().default(1),
  required: z.boolean().default(true),
});

export const documentCheckSchema = checkBase.extend({
  kind: z.literal('document'),
  artifactId: z.string().min(1).optional(),
  sourcePath: z.string().optional(),
  baseDir: verifyBaseDirSchema.default('workspace'),
  sections: z.array(z.string().min(1)).min(1),
  minLevel: z.number().int().min(1).max(6).default(1),
  maxLevel: z.number().int().min(1).max(6).default(3),
});

export const jsonSchemaCheckSchema = checkBase.extend({
  kind: z.literal('jsonSchema'),
  schemaRef: z.string().min(1),
  sourcePath: z.string().optional(),
  baseDir: verifyBaseDirSchema.default('workspace'),
});

export const containsCheckSchema = checkBase.extend({
  kind: z.literal('contains'),
  text: z.string().min(1),
  caseInsensitive: z.boolean().default(true),
});

export const nonEmptyCheckSchema = checkBase.extend({
  kind: z.literal('nonEmpty'),
});

export const customCheckSchema = checkBase.extend({
  kind: z.literal('custom'),
  verifierId: z.string().min(1),
});

export const agentCheckSchema = checkBase.extend({
  kind: z.literal('agent'),
  /** Host/agent-registered agent-grader id. */
  graderId: z.string().min(1),
});

export const verificationCheckSchema = z.discriminatedUnion('kind', [
  commandCheckSchema,
  artifactCheckSchema,
  documentCheckSchema,
  jsonSchemaCheckSchema,
  containsCheckSchema,
  nonEmptyCheckSchema,
  customCheckSchema,
  agentCheckSchema,
]);
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationCheckInput = z.input<typeof verificationCheckSchema>;

/**
 * Serializable verification plan declared on AgentDefinition (or host policy).
 * Runtime callbacks (custom / agent graders) are registered separately.
 */
export const verificationPlanSchema = z.object({
  checks: z.array(verificationCheckSchema).default([]),
});
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;
export type VerificationPlanInput = z.input<typeof verificationPlanSchema>;

export const verificationCheckResultSchema = z.object({
  id: z.string().min(1),
  kind: verificationCheckKindSchema,
  severity: verificationSeveritySchema,
  passed: z.boolean(),
  detail: z.string().optional(),
});
export type VerificationCheckResult = z.infer<
  typeof verificationCheckResultSchema
>;

export const verificationOutcomeSchema = z.enum([
  'passed',
  'failed',
  'not-gated',
]);
export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;

export const verificationResultSchema = z.object({
  /** Aggregate outcome for the run. */
  outcome: verificationOutcomeSchema,
  /** True when outcome === 'passed'. Kept for callers that only need a boolean. */
  passed: z.boolean(),
  /** Human-readable plan id / version label. */
  planId: z.string().default('verification'),
  checks: z.array(verificationCheckResultSchema).default([]),
  evidenceRefs: z.array(z.string()).default([]),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;
