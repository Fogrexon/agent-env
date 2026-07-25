import { z } from 'zod';
import { agentAttachmentSchema } from './agent-params.js';
import { modelRefSchema } from './types.js';

/**
 * One invocation of a discovered agent.
 *
 * This is deliberately independent from the ADK agent graph. Callers provide
 * structured values; repo wiring resolves the agent definition and templates.
 */
export const agentRunRequestSchema = z.object({
  agentId: z.string().min(1),
  objective: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(agentAttachmentSchema).default([]),
  model: modelRefSchema.optional(),
  runId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

/** Resolved invocation data saved with the effective run intent. */
export const runInputSnapshotSchema = z.object({
  objective: z.string().min(1),
  inputs: z.record(z.string(), z.unknown()).default({}),
  attachments: z.array(agentAttachmentSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;
