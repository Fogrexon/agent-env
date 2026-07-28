import { z } from 'zod';
import { artifactHandleSchema } from './working-context.js';

/**
 * Protocol-neutral typed handoff between agents (Connection plane).
 * Payload is opaque JSON validated by the caller's Zod / JSON Schema;
 * this envelope carries the contract around it.
 */
export const handoffArtifactSchema = z.object({
  version: z.literal('1.0').default('1.0'),
  fromAgent: z.string().min(1),
  toAgent: z.string().min(1),
  objective: z.string().min(1),
  /** Digested handles of inputs the sender relied on. */
  inputArtifacts: z.array(artifactHandleSchema).default([]),
  /**
   * Logical schema id for the payload (e.g. artifact://schemas/evidence-bundle-v1).
   * Receivers may map this to a Zod schema locally.
   */
  outputSchema: z.string().min(1),
  /** Human-checkable done criteria; verifier / contract check may use them. */
  doneCriteria: z.array(z.string().min(1)).default([]),
  /** Bounded prose; full history must not go here. */
  contextSummary: z.string().default(''),
  /** Structured payload validated by the receiver against outputSchema. */
  payload: z.unknown(),
  /**
   * SHA-256 hex over a stable serialization of the handoff body
   * (everything except `digest` itself).
   */
  digest: z.string().min(16),
  createdAt: z.string().optional(),
});
export type HandoffArtifact = z.infer<typeof handoffArtifactSchema>;

export const handoffContractResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.string()).default([]),
  artifact: handoffArtifactSchema.optional(),
});
export type HandoffContractResult = z.infer<typeof handoffContractResultSchema>;
