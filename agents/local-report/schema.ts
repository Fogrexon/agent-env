import { z } from 'zod';

/** Compact evidence ledger handed from researcher → writer. */
export const LOCAL_EVIDENCE_SCHEMA_ID =
  'artifact://schemas/local-evidence-ledger-v1';

export const localEvidenceLedgerSchema = z.object({
  findings: z
    .array(
      z.object({
        text: z.string().min(8),
        url: z.string().optional(),
        topic: z.string().optional(),
      }),
    )
    .min(1)
    .max(40),
  sources: z
    .array(
      z.object({
        title: z.string().min(1),
        url: z.string().min(4),
      }),
    )
    .default([]),
  coverageGaps: z.array(z.string()).default([]),
});
export type LocalEvidenceLedger = z.infer<typeof localEvidenceLedgerSchema>;
