import { z } from 'zod';

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
