import { z } from 'zod';

export const TASK_BATCH_SCHEMA_ID = 'artifact://schemas/hypothesis-task-batch-v1';
export const WORKER_RESULT_SCHEMA_ID =
  'artifact://schemas/hypothesis-worker-result-v1';
export const KNOWLEDGE_LEDGER_SCHEMA_ID =
  'artifact://schemas/hypothesis-knowledge-ledger-v1';
export const WORK_PRODUCT_SCHEMA_ID =
  'artifact://schemas/hypothesis-work-product-v1';
export const CHALLENGE_BRIEF_SCHEMA_ID =
  'artifact://schemas/hypothesis-challenge-brief-v1';

export const taskItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(4),
  linkedHypothesisId: z.string().optional(),
  /** Why this dig is worth doing (from Director guidance). */
  digReason: z.string().optional(),
  instructions: z.string().min(8),
  acceptance: z.string().min(4),
});

export const taskBatchSchema = z.object({
  batchIndex: z.number().int().min(0),
  mode: z.literal('explore'),
  tasks: z.array(taskItemSchema).min(1).max(8),
  deferredTasks: z.array(taskItemSchema).default([]),
  rationale: z.string().min(8),
});
export type TaskBatch = z.infer<typeof taskBatchSchema>;

export const workerResultSchema = z.object({
  taskId: z.string().min(1),
  findings: z.array(z.string().min(4)).min(1),
  artifactPaths: z.array(z.string()).default([]),
  confidence: z.enum(['high', 'medium', 'low']),
  gapsNoticed: z.array(z.string()).default([]),
});
export type WorkerResult = z.infer<typeof workerResultSchema>;

export const hypothesisEntrySchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(8),
  status: z.enum(['open', 'supported', 'rejected', 'inconclusive']),
  evidence: z.array(z.string()).default([]),
  notes: z.string().optional(),
});

export const knowledgeLedgerSchema = z.object({
  goal: z.string().min(4),
  successCriteria: z.array(z.string().min(4)).default([]),
  facts: z.array(z.string().min(4)).default([]),
  openQuestions: z.array(z.string()).default([]),
  coveredTopics: z.array(z.string()).default([]),
  hypotheses: z.array(hypothesisEntrySchema).default([]),
  /** Dig-deeper themes already pursued (avoid repeating shallow passes). */
  digHistory: z
    .array(
      z.object({
        theme: z.string().min(4),
        outcome: z.string().min(4),
      }),
    )
    .default([]),
  deferredTasks: z.array(taskItemSchema).default([]),
  batchHistory: z
    .array(
      z.object({
        batchIndex: z.number().int().min(0),
        summary: z.string().min(4),
        taskIds: z.array(z.string()).default([]),
      }),
    )
    .default([]),
});
export type KnowledgeLedger = z.infer<typeof knowledgeLedgerSchema>;

export const workProductSchema = z.object({
  summary: z.string().min(20),
  htmlPath: z.string().min(4),
  ledgerPath: z.string().min(4),
  claimIndex: z.array(z.string().min(4)).min(1),
});
export type WorkProduct = z.infer<typeof workProductSchema>;

export const digDeeperPointSchema = z.object({
  id: z.string().min(1),
  /** Passage / claim in the current report that is thin or consequential. */
  reportAnchor: z.string().min(8),
  /** Why digging here moves the goal forward. */
  whyItMatters: z.string().min(8),
  /** Concrete unknown to resolve. */
  openQuestion: z.string().min(8),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
});

export const challengeHypothesisSchema = z.object({
  id: z.string().min(1),
  claim: z.string().min(8),
  rationale: z.string().min(8),
  howToFalsify: z.string().min(8),
  linkedDigId: z.string().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
});

export const nextInvestigationSchema = z.object({
  title: z.string().min(4),
  /** Executable by workers (web queries, files, comparisons). */
  instructions: z.string().min(8),
  acceptance: z.string().min(4),
  linkedDigId: z.string().optional(),
  linkedHypothesisId: z.string().optional(),
});

/**
 * Director output: dig-deeper guidance for the next exploration cycle.
 * NOT a formatting checklist.
 */
export const challengeBriefSchema = z.object({
  stance: z.enum(['dig_deeper', 'accept', 'blocked']),
  /** 2–5 places in the report worth going deeper. Required when dig_deeper. */
  digDeeperPoints: z.array(digDeeperPointSchema).default([]),
  hypotheses: z.array(challengeHypothesisSchema).default([]),
  /** Ordered work for the parent to turn into the next TaskBatch. */
  nextInvestigations: z.array(nextInvestigationSchema).default([]),
  /** One paragraph of senior guidance to the field team. */
  guidance: z.string().min(40),
  acceptRationale: z.string().optional(),
});
export type ChallengeBrief = z.infer<typeof challengeBriefSchema>;

export const HTML_REPORT_SECTIONS = [
  'Goal / Success criteria',
  'Executive summary',
  'Findings to date',
  'Hypothesis log',
  'Evidence tables',
  'Open questions & next investigations',
  'Residual uncertainties',
  'Sources / file references',
] as const;
