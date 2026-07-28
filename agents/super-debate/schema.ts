import { z } from 'zod';

/** Multi-model panel turn (opening or rebuttal). */
export const PANEL_TURN_SCHEMA_ID = 'artifact://schemas/panel-turn-v1';

export const panelTurnSchema = z.object({
  panelistId: z.string().min(1),
  panelistLabel: z.string().min(1),
  round: z.enum(['opening', 'rebuttal']),
  stance: z.string().min(4),
  claims: z
    .array(
      z.object({
        text: z.string().min(1),
        warrant: z.string().optional(),
      }),
    )
    .min(1)
    .max(12),
  evidence: z
    .array(
      z.object({
        fact: z.string().min(1),
        source: z.string().optional(),
      }),
    )
    .default([]),
  /** For rebuttal: other panelist ids engaged. */
  engagement: z
    .array(
      z.object({
        panelistId: z.string().min(1),
        accept: z.string().optional(),
        reject: z.string().optional(),
        refine: z.string().optional(),
      }),
    )
    .default([]),
  closing: z.string().optional(),
});
export type PanelTurn = z.infer<typeof panelTurnSchema>;
