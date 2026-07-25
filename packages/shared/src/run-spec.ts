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

/** Base directory a verifier path/command resolves against. */
export const verifyBaseDirSchema = z.enum(['workspace', 'repo']);
export type VerifyBaseDir = z.infer<typeof verifyBaseDirSchema>;

export const successCriterionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('test_suite'),
    ref: z.string().min(1),
  }),
  /**
   * Strongest gate: run a fixed argv and require an exit code.
   * Evidence the agent cannot author by narrating (tests, build, linters).
   */
  z.object({
    type: z.literal('command'),
    bin: z.string().min(1),
    args: z.array(z.string()).default([]),
    baseDir: verifyBaseDirSchema.default('workspace'),
    /** Optional sub-path under baseDir to run in. */
    subdir: z.string().optional(),
    expectExitCode: z.number().int().default(0),
    /** Optional substring required in stdout+stderr. */
    outputContains: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().default(120_000),
    /** Run via platform shell. Only for fixed shims (e.g. npm.cmd). */
    shell: z.boolean().default(false),
  }),
  /** Artifacts actually written to disk (state, not prose). */
  z.object({
    type: z.literal('file_exists'),
    paths: z.array(z.string().min(1)).min(1),
    baseDir: verifyBaseDirSchema.default('workspace'),
    /** Each file must be at least this many bytes. */
    minBytes: z.number().int().nonnegative().default(1),
  }),
  z.object({
    type: z.literal('json_schema'),
    /** Repo-relative or absolute path to a JSON Schema document. */
    schemaRef: z.string().min(1),
    /**
     * Validate this file instead of the agent's final text.
     * Prefer this: a written artifact beats parsing prose.
     */
    sourcePath: z.string().optional(),
    baseDir: verifyBaseDirSchema.default('workspace'),
  }),
  z.object({
    type: z.literal('markdown_headings'),
    /** Required ATX heading titles (text after `#`…, compared case-insensitively). */
    headings: z.array(z.string().min(1)).min(1),
    /** Inclusive ATX level range, e.g. 2–2 matches `## Title` only. */
    minLevel: z.number().int().min(1).max(6).default(1),
    maxLevel: z.number().int().min(1).max(6).default(3),
    /**
     * Prefer reading this workspace/repo file over `finalText`.
     * Report format is per-agent — MD agents point at `report.md`.
     */
    sourcePath: z.string().optional(),
    baseDir: verifyBaseDirSchema.default('workspace'),
  }),
  /**
   * HTML report structure (agent may ship `report.html` instead of markdown).
   * Matches `<hN>…</hN>` titles case-insensitively after stripping nested tags.
   */
  z.object({
    type: z.literal('html_headings'),
    headings: z.array(z.string().min(1)).min(1),
    minLevel: z.number().int().min(1).max(6).default(1),
    maxLevel: z.number().int().min(1).max(6).default(3),
    /** Default `report.html` when omitted and `finalText` is empty — prefer explicit. */
    sourcePath: z.string().optional(),
    baseDir: verifyBaseDirSchema.default('workspace'),
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
]);
export type SuccessCriterion = z.infer<typeof successCriterionSchema>;

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
      /** Structured per-run values after params validation. */
      inputs: z.record(z.string(), z.unknown()).default({}),
      inputArtifactDigest: z.string().optional(),
      outputSchemaRef: z.string().optional(),
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
        ref: z.string().min(1).default('./evaluation.json'),
        digest: z.string().min(1).optional(),
      })
      .default({ ref: './evaluation.json' }),
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
