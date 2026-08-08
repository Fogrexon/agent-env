import { z } from 'zod';
import { verificationResultSchema } from './verification.js';

/**
 * Run state machine.
 * Terminal states are immutable; retries create a new run_id / attempt_id.
 *
 * - SUCCEEDED: required verification passed (or host required checks passed)
 * - COMPLETED: finished without required gates (no verification / advisory only)
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
  'COMPLETED',
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
  'COMPLETED',
  'FAILED',
  'FAILED_INFRA',
  'BUDGET_EXHAUSTED',
  'POLICY_DENIED',
  'APPROVAL_EXPIRED',
  'CANCELLED',
  'UNKNOWN_EXTERNAL_EFFECT',
] as const satisfies readonly RunState[];

export const SUCCESSFUL_RUN_STATES = [
  'SUCCEEDED',
  'COMPLETED',
] as const satisfies readonly RunState[];

export function isTerminalRunState(state: RunState): boolean {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

export function isSuccessfulRunState(state: RunState): boolean {
  return (SUCCESSFUL_RUN_STATES as readonly string[]).includes(state);
}

/** Workflow phase for scheduler metadata. */
export const runPhaseSchema = z.enum([
  'reasoning',
  'acting',
  'waiting',
  'verifying',
  'terminated',
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const agentExecutionLimitsSchema = z.object({
  maxSteps: z.number().int().positive().default(200),
  maxToolCalls: z.number().int().positive().default(200),
  maxWallSeconds: z.number().int().positive().default(1800),
  maxRepairs: z.number().int().nonnegative().default(3),
  maxSubagentDepth: z.number().int().nonnegative().default(3),
});
export type AgentExecutionLimits = z.infer<typeof agentExecutionLimitsSchema>;
export type AgentExecutionLimitsInput = z.input<
  typeof agentExecutionLimitsSchema
>;

/** Append-only evidence event. */
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

/** Actuals for one attempt. */
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
  /** Models observed during the run (provider:model strings). */
  modelsUsed: z.array(z.string().min(1)).default([]),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/**
 * Runtime-generated intent snapshot for a run (written as intent.json).
 */
export const agentRunIntentSchema = z.object({
  agentId: z.string().min(1),
  objective: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  attachmentPaths: z.array(z.string()).default([]),
  limits: agentExecutionLimitsSchema,
  verificationPlanId: z.string().optional(),
});
export type AgentRunIntent = z.infer<typeof agentRunIntentSchema>;
