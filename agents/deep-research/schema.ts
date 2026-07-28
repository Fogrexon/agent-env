import { z } from 'zod';

export const RESEARCH_SCOPE_SCHEMA_ID = 'artifact://schemas/research-scope-v1';
export const RESEARCH_PLAN_SCHEMA_ID = 'artifact://schemas/research-plan-v1';
export const EVIDENCE_LEDGER_SCHEMA_ID =
  'artifact://schemas/evidence-ledger-v1';
export const GAP_FILL_SCHEMA_ID = 'artifact://schemas/gap-fill-v1';
export const DRAFT_REPORT_SCHEMA_ID = 'artifact://schemas/draft-report-v1';

export const researchScopeSchema = z.object({
  userIntent: z.string().min(8),
  audience: z.string().optional(),
  decisionFocus: z.string().optional(),
  successCriteria: z.array(z.string().min(8)).min(3).max(12),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        question: z.string().min(4),
        criterionRef: z.string().optional(),
      }),
    )
    .min(3)
    .max(12),
  outOfScope: z.array(z.string()).default([]),
});
export type ResearchScope = z.infer<typeof researchScopeSchema>;

export const researchPlanSchema = z.object({
  items: z
    .array(
      z.object({
        questionId: z.string().min(1),
        why: z.string().min(4),
        queries: z.array(z.string().min(2)).min(2).max(8),
        sourcePreferences: z.string().optional(),
      }),
    )
    .min(1),
  coverageChecklist: z.array(z.string()).default([]),
});
export type ResearchPlan = z.infer<typeof researchPlanSchema>;

export const evidenceLedgerSchema = z.object({
  byQuestion: z
    .array(
      z.object({
        questionId: z.string().min(1),
        findings: z.array(z.string().min(4)).min(1),
        coverage: z.enum(['strong', 'partial', 'weak']),
      }),
    )
    .min(1),
  sources: z
    .array(
      z.object({
        title: z.string().min(1),
        url: z.string().min(4),
      }),
    )
    .default([]),
  stillMissing: z.array(z.string()).default([]),
});
export type EvidenceLedger = z.infer<typeof evidenceLedgerSchema>;

export const gapFillSchema = z.object({
  assessments: z
    .array(
      z.object({
        criterion: z.string().min(4),
        status: z.enum(['COVERED', 'PARTIAL', 'MISSING']),
        reason: z.string().min(4),
      }),
    )
    .min(1),
  additionalFindings: z.array(z.string()).default([]),
  readyForWriting: z.boolean(),
  residualGaps: z.array(z.string()).default([]),
});
export type GapFill = z.infer<typeof gapFillSchema>;

export const draftReportSchema = z.object({
  markdown: z.string().min(80),
  suggestedFigures: z.array(z.string().url()).max(8).default([]),
});
export type DraftReport = z.infer<typeof draftReportSchema>;
