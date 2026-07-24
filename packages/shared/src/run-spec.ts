import { z } from 'zod';
import { modelRefSchema } from './types.js';

/** Tool risk classes (T0–T3). Distinct from replay levels R0–R5. */
export const toolRiskClassSchema = z.enum(['T0', 'T1', 'T2', 'T3']);
export type ToolRiskClass = z.infer<typeof toolRiskClassSchema>;

export const toolSideEffectSchema = z.enum([
  'none',
  'reversible',
  'irreversible',
]);
export type ToolSideEffect = z.infer<typeof toolSideEffectSchema>;

export const toolIdempotencySchema = z.enum([
  'required',
  'supported',
  'none',
]);
export type ToolIdempotency = z.infer<typeof toolIdempotencySchema>;

/** Typed tool contract metadata (authority boundary, not just a function list). */
export const toolContractSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).default('1.0'),
  sideEffect: toolSideEffectSchema.default('none'),
  idempotency: toolIdempotencySchema.default('none'),
  riskClass: toolRiskClassSchema.default('T0'),
  timeoutMs: z.number().int().positive().default(30_000),
  maxOutputBytes: z.number().int().positive().default(64_000),
  requiredCapabilities: z.array(z.string()).default([]),
});
export type ToolContract = z.infer<typeof toolContractSchema>;
export type ToolContractInput = z.input<typeof toolContractSchema>;

/**
 * Run state machine (research §6.2).
 * Terminal states are immutable; retries create a new run_id / attempt_id.
 */
export const runStateSchema = z.enum([
  'QUEUED',
  'PROVISIONING',
  'RUNNING',
  'WAITING_TOOL',
  'WAITING_APPROVAL',
  'CHECKPOINTING',
  'VERIFYING',
  'REPAIRING',
  'SUCCEEDED',
  'FAILED',
  'FAILED_INFRA',
  'BUDGET_EXHAUSTED',
  'POLICY_DENIED',
  'APPROVAL_EXPIRED',
  'CANCELLED',
  'UNKNOWN_EXTERNAL_EFFECT',
]);
export type RunState = z.infer<typeof runStateSchema>;

export const TERMINAL_RUN_STATES = [
  'SUCCEEDED',
  'FAILED',
  'FAILED_INFRA',
  'BUDGET_EXHAUSTED',
  'POLICY_DENIED',
  'APPROVAL_EXPIRED',
  'CANCELLED',
  'UNKNOWN_EXTERNAL_EFFECT',
] as const satisfies readonly RunState[];

export function isTerminalRunState(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

/** Workflow phase for scheduler metadata (ThunderAgent-inspired). */
export const runPhaseSchema = z.enum([
  'reasoning',
  'acting',
  'waiting',
  'verifying',
  'terminated',
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const budgetSpecSchema = z.object({
  maxCostUsd: z.number().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
  maxToolCalls: z.number().int().positive().default(40),
  maxWallSeconds: z.number().int().positive().default(600),
  verificationReservePercent: z.number().min(0).max(100).default(0),
});
export type BudgetSpec = z.infer<typeof budgetSpecSchema>;
export type BudgetSpecInput = z.input<typeof budgetSpecSchema>;

export const harnessPolicySpecSchema = z.object({
  policyRef: z.string().optional(),
  maxSteps: z.number().int().positive().default(20),
  maxRepairs: z.number().int().nonnegative().default(1),
  maxInfraRetries: z.number().int().nonnegative().default(1),
  maxToolRetries: z.number().int().nonnegative().default(2),
  maxCheckpointRetries: z.number().int().nonnegative().default(0),
  maxVerificationRetries: z.number().int().nonnegative().default(1),
});
export type HarnessPolicySpec = z.infer<typeof harnessPolicySpecSchema>;

/**
 * Postconditions evaluated by the independent verifier (not the agent).
 * Prefer deterministic types (test_suite / json_schema / artifact_*) over contains / llm_grade.
 */
export const successCriterionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('test_suite'),
    /** Registry key for a TestSuiteRunner supplied in VerifyContext. */
    ref: z.string().min(1),
  }),
  z.object({
    type: z.literal('json_schema'),
    /** Registry key for a Zod schema (or parseable validator) in VerifyContext. */
    schemaRef: z.string().min(1),
    /** Key into VerifyContext.artifacts. Default: "output". */
    artifactKey: z.string().min(1).default('output'),
  }),
  z.object({
    type: z.literal('artifact_equals'),
    key: z.string().min(1),
    expected: z.unknown(),
  }),
  z.object({
    type: z.literal('artifact_path_exists'),
    key: z.string().min(1),
  }),
  z.object({
    type: z.literal('contains'),
    text: z.string().min(1),
    caseInsensitive: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('custom'),
    verifierId: z.string().min(1),
  }),
  z.object({
    type: z.literal('llm_grade'),
    /**
     * Rubric / question for an injected grader model.
     * Cannot be the sole criterion unless evaluation.allowLlmGradeAlone is true.
     */
    rubric: z.string().min(1),
    passLabel: z.string().min(1).default('PASS'),
  }),
]);
export type SuccessCriterion = z.infer<typeof successCriterionSchema>;

/** Criterion types treated as deterministic (external evidence / code). */
export const DETERMINISTIC_CRITERION_TYPES = [
  'test_suite',
  'json_schema',
  'artifact_equals',
  'artifact_path_exists',
  'custom',
] as const;

/**
 * Versioned intent before execution (research §6.1).
 * Actuals belong in RunRecord, not here.
 */
export const runSpecSchema = z.object({
  apiVersion: z.literal('agent.platform/v1').default('agent.platform/v1'),
  kind: z.literal('RunSpec').default('RunSpec'),
  metadata: z.object({
    tenantId: z.string().default('local'),
    requestId: z.string().optional(),
    idempotencyKey: z.string().optional(),
    parentRunId: z.string().nullable().optional(),
  }).default({ tenantId: 'local' }),
  spec: z.object({
    task: z.object({
      taskId: z.string().min(1),
      revision: z.string().default('1'),
      objective: z.string().min(1),
      inputArtifactDigest: z.string().optional(),
      outputSchemaRef: z.string().optional(),
      successCriteria: z.array(successCriterionSchema).default([]),
    }),
    harness: harnessPolicySpecSchema.default({
      maxSteps: 20,
      maxRepairs: 1,
      maxInfraRetries: 1,
      maxToolRetries: 2,
      maxCheckpointRetries: 0,
      maxVerificationRetries: 1,
    }),
    model: z.object({
      primary: modelRefSchema,
      allowed: z.array(modelRefSchema).optional(),
    }),
    environment: z
      .object({
        backend: z.enum(['none', 'process', 'container', 'microvm']).default('none'),
        imageDigest: z.string().optional(),
        networkPolicy: z.enum(['allowlist', 'deny', 'unrestricted']).default('deny'),
        egressDomains: z.array(z.string()).default([]),
      })
      .default({
        backend: 'none',
        networkPolicy: 'deny',
        egressDomains: [],
      }),
    tools: z
      .object({
        allow: z.array(toolContractSchema).default([]),
      })
      .default({ allow: [] }),
    budget: budgetSpecSchema.default({
      maxToolCalls: 40,
      maxWallSeconds: 600,
      verificationReservePercent: 0,
    }),
    evaluation: z
      .object({
        graderVersion: z.string().default('local-v1'),
        seed: z.number().int().optional(),
        repetitions: z.number().int().positive().default(1),
        /**
         * When false (default), llm_grade alone cannot pass a run
         * (research: LLM-as-judge is not a sole release gate).
         */
        allowLlmGradeAlone: z.boolean().default(false),
      })
      .default({
        graderVersion: 'local-v1',
        repetitions: 1,
        allowLlmGradeAlone: false,
      }),
    retention: z
      .object({
        eventDays: z.number().int().positive().default(30),
        contentCapture: z.enum(['full', 'redacted', 'digest']).default('redacted'),
      })
      .default({ eventDays: 30, contentCapture: 'redacted' }),
  }),
});
export type RunSpec = z.infer<typeof runSpecSchema>;

/** Append-only evidence event (research §6.5). */
export const runEventTypeSchema = z.enum([
  'run.created',
  'run.started',
  'run.paused',
  'run.completed',
  'run.failed',
  'run.state_changed',
  'model.requested',
  'model.completed',
  'model.failed',
  'tool.proposed',
  'tool.approved',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'policy.evaluated',
  'policy.denied',
  'budget.reserved',
  'budget.consumed',
  'budget.exhausted',
  'sandbox.created',
  'sandbox.terminated',
  'checkpoint.requested',
  'checkpoint.completed',
  'artifact.created',
  'artifact.verified',
  'verification.started',
  'verification.result',
]);
export type RunEventType = z.infer<typeof runEventTypeSchema>;

export const runEventSchema = z.object({
  eventId: z.string().min(1),
  eventType: runEventTypeSchema,
  schemaVersion: z.literal('1.0').default('1.0'),
  occurredAt: z.string().min(1),
  recordedAt: z.string().min(1),
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  attemptId: z.string().min(1),
  stepId: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  actor: z
    .object({
      type: z.enum(['system', 'agent', 'human', 'verifier']),
      id: z.string(),
      version: z.string().optional(),
    })
    .default({ type: 'system', id: 'harness' }),
  causationId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  payloadDigest: z.string().optional(),
});
export type RunEvent = z.infer<typeof runEventSchema>;

export const verificationResultSchema = z.object({
  passed: z.boolean(),
  graderVersion: z.string(),
  checks: z.array(
    z.object({
      criterion: z.string(),
      passed: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
  evidenceRefs: z.array(z.string()).default([]),
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

/** Actuals for one attempt (separate from RunSpec intent). */
export const runRecordSchema = z.object({
  runId: z.string(),
  attemptId: z.string(),
  parentRunId: z.string().nullable().optional(),
  state: runStateSchema,
  phase: runPhaseSchema,
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  finalText: z.string().optional(),
  error: z.string().optional(),
  budgetConsumed: z.object({
    toolCalls: z.number().int().nonnegative().default(0),
    tokens: z.number().int().nonnegative().default(0),
    wallSeconds: z.number().nonnegative().default(0),
    costUsd: z.number().nonnegative().default(0),
  }),
  verification: verificationResultSchema.optional(),
  eventCount: z.number().int().nonnegative().default(0),
  specDigests: z
    .object({
      taskRevision: z.string().optional(),
      modelProvider: z.string().optional(),
      modelId: z.string().optional(),
      graderVersion: z.string().optional(),
    })
    .default({}),
});
export type RunRecord = z.infer<typeof runRecordSchema>;
