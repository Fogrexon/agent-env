import { z } from 'zod';
import { agentEventSummarySchema } from './types.js';
import { runPhaseSchema, runStateSchema } from './run-record.js';

/** Kinds of normalized live progress events from harness runs. */
export const agentProgressKindSchema = z.enum([
  'run.started',
  'agent.event',
  'run.state',
  'run.completed',
  'run.failed',
]);
export type AgentProgressKind = z.infer<typeof agentProgressKindSchema>;

/**
 * Agent-agnostic progress event for live sinks (CLI / SSE / admin).
 * `runId` correlates a stream; `sequence` is monotonic per run for replay.
 */
export const agentProgressEventSchema = z.object({
  kind: agentProgressKindSchema,
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  message: z.string().optional(),
  author: z.string().optional(),
  /**
   * When set (e.g. mid-stream tool progress), admin folds this event
   * immediately before the open LLM stream row for this agent author.
   */
  parentAuthor: z.string().min(1).optional(),
  phase: runPhaseSchema.optional(),
  state: runStateSchema.optional(),
  /** Normalized ADK event summary when kind is agent.event. */
  agentEvent: agentEventSummarySchema.optional(),
  /** Opaque extras (state transition, tool metadata, …). */
  payload: z.record(z.string(), z.unknown()).optional(),
});
export type AgentProgressEvent = z.infer<typeof agentProgressEventSchema>;

export type AgentProgressSink = (event: AgentProgressEvent) => void;

/** Helper to allocate monotonic sequences for a single run. */
export function createProgressSequencer(
  runId: string,
  onProgress?: AgentProgressSink,
  startSequence = 0,
): {
  emit: (
    kind: AgentProgressKind,
    partial?: Omit<
      AgentProgressEvent,
      'kind' | 'runId' | 'sequence' | 'timestamp'
    >,
  ) => AgentProgressEvent | undefined;
  nextSequence: () => number;
} {
  let sequence = startSequence;
  return {
    nextSequence: () => sequence,
    emit: (kind, partial = {}) => {
      if (!onProgress) return undefined;
      const event: AgentProgressEvent = {
        kind,
        runId,
        sequence: sequence++,
        timestamp: new Date().toISOString(),
        ...partial,
      };
      onProgress(event);
      return event;
    },
  };
}
