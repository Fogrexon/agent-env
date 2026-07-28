import { z } from 'zod';
import { artifactHandleSchema } from './working-context.js';

/** Lifecycle of a memory entry (write gate). */
export const memoryEntryStatusSchema = z.enum([
  'proposed',
  'validated',
  'accepted',
]);
export type MemoryEntryStatus = z.infer<typeof memoryEntryStatusSchema>;

export const memoryKindSchema = z.enum([
  'fact',
  'preference',
  'procedure',
  'entity',
  'other',
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memoryEntrySchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  kind: memoryKindSchema.default('fact'),
  status: memoryEntryStatusSchema,
  scope: z.string().min(1).default('default'),
  source: artifactHandleSchema.optional(),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

/** Typed memory mutation space (Memory-R1 compatible surface). */
export const memoryOperationKindSchema = z.enum([
  'ADD',
  'UPDATE',
  'DELETE',
  'NOOP',
]);
export type MemoryOperationKind = z.infer<typeof memoryOperationKindSchema>;

export const memoryOperationSchema = z.object({
  op: memoryOperationKindSchema,
  /** Required for UPDATE / DELETE; optional for ADD (auto-id when omitted). */
  id: z.string().min(1).optional(),
  content: z.string().min(1).optional(),
  kind: memoryKindSchema.optional(),
  scope: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  source: artifactHandleSchema.optional(),
  reason: z.string().optional(),
});
export type MemoryOperation = z.infer<typeof memoryOperationSchema>;

export const memoryCandidateSchema = z.object({
  content: z.string().min(1),
  kind: memoryKindSchema.default('fact'),
  scope: z.string().min(1).default('default'),
  tags: z.array(z.string()).default([]),
  source: artifactHandleSchema.optional(),
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
