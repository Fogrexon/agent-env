import { z } from 'zod';

/** Typed debate turn handed between PRO/CON rounds and the judge. */
export const DEBATE_TURN_SCHEMA_ID = 'artifact://schemas/debate-turn-v1';

export const debateTurnSchema = z.object({
  side: z.enum(['pro', 'con']),
  round: z.enum(['opening', 'rebuttal_1', 'rebuttal_2']),
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        warrant: z.string().optional(),
      }),
    )
    .min(1)
    .max(8),
  evidence: z
    .array(
      z.object({
        fact: z.string().min(1),
        source: z.string().optional(),
      }),
    )
    .default([]),
  /** Opponent claims this turn answers (rebuttal rounds). */
  targets: z.array(z.string()).default([]),
  closing: z.string().optional(),
});
export type DebateTurn = z.infer<typeof debateTurnSchema>;
