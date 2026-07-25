import { z } from 'zod';
import { modelRefSchema } from './types.js';

const graderBudgetSchema = z.object({
  maxCostUsd: z.number().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().default(10),
  maxWallSeconds: z.number().int().positive().default(300),
});

export const artifactContractSchema = z.object({
  id: z.string().min(1),
  mediaTypes: z.array(z.string().min(1)).min(1),
  required: z.boolean().default(true),
  minBytes: z.number().int().nonnegative().default(1),
});
export type ArtifactContract = z.infer<typeof artifactContractSchema>;

const deterministicGraderSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('deterministic'),
  /** Versioned grader implementation, e.g. grader://document-contract/v1. */
  ref: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

const agentGraderSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('agent'),
  /** Canonical agent id or versioned grader URI. */
  ref: z.string().min(1),
  model: modelRefSchema,
  rubricRef: z.string().min(1),
  repetitions: z.number().int().positive().default(1),
  aggregate: z.enum(['all', 'majority', 'mean']).default('majority'),
  threshold: z.number().min(0).max(1).default(0.8),
  maxDepth: z.number().int().nonnegative().default(1),
  budget: graderBudgetSchema.optional(),
});

const externalGraderSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('external'),
  /** Adapter URI such as promptfoo://evals/report.yaml. */
  ref: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
});

export const graderSpecSchema = z.discriminatedUnion('kind', [
  deterministicGraderSchema,
  agentGraderSchema,
  externalGraderSchema,
]);
export type GraderSpec = z.infer<typeof graderSpecSchema>;

export const acceptanceAssertionSchema = z.object({
  id: z.string().min(1),
  grader: z.string().min(1),
  assertion: z.string().min(1),
  scoreAtLeast: z.number().min(0).max(1).optional(),
});
export type AcceptanceAssertion = z.infer<typeof acceptanceAssertionSchema>;

export const evaluationSpecSchema = z
  .object({
    apiVersion: z.literal('agent.platform/v1').default('agent.platform/v1'),
    kind: z.literal('EvaluationSpec').default('EvaluationSpec'),
    metadata: z.object({
      id: z.string().min(1),
      version: z.string().min(1),
    }),
    artifacts: z.array(artifactContractSchema).default([]),
    graders: z.array(graderSpecSchema).min(1),
    acceptance: z.object({
      all: z.array(acceptanceAssertionSchema).min(1),
    }),
  })
  .superRefine((spec, ctx) => {
    const graderIds = new Set<string>();
    for (const [index, grader] of spec.graders.entries()) {
      if (graderIds.has(grader.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['graders', index, 'id'],
          message: `duplicate grader id: ${grader.id}`,
        });
      }
      graderIds.add(grader.id);
    }
    for (const [index, assertion] of spec.acceptance.all.entries()) {
      if (!graderIds.has(assertion.grader)) {
        ctx.addIssue({
          code: 'custom',
          path: ['acceptance', 'all', index, 'grader'],
          message: `unknown grader: ${assertion.grader}`,
        });
      }
    }
  });
export type EvaluationSpec = z.infer<typeof evaluationSpecSchema>;

export const evaluationRefSchema = z.object({
  ref: z.string().min(1).default('./evaluation.json'),
  digest: z.string().min(1).optional(),
});
export type EvaluationRef = z.infer<typeof evaluationRefSchema>;
