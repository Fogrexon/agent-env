import { randomUUID } from 'node:crypto';
import {
  runEventSchema,
  type RunEvent,
  type RunEventType,
} from '@agent-env/shared';

export interface AppendEventInput {
  eventType: RunEventType;
  runId: string;
  attemptId: string;
  tenantId: string;
  stepId?: string;
  actor?: RunEvent['actor'];
  causationId?: string;
  payload?: Record<string, unknown>;
  occurredAt?: string;
}

/**
 * Append-only in-memory event store (Phase A).
 * Swap for durable storage later; consumers should treat delivery as at-least-once.
 */
export class InMemoryEventStore {
  readonly #events: RunEvent[] = [];

  append(input: AppendEventInput): RunEvent {
    const now = new Date().toISOString();
    const event = runEventSchema.parse({
      eventId: randomUUID(),
      eventType: input.eventType,
      schemaVersion: '1.0',
      occurredAt: input.occurredAt ?? now,
      recordedAt: now,
      tenantId: input.tenantId,
      runId: input.runId,
      attemptId: input.attemptId,
      stepId: input.stepId,
      sequence: this.#events.length,
      actor: input.actor ?? { type: 'system', id: 'harness' },
      causationId: input.causationId,
      payload: input.payload ?? {},
    });
    this.#events.push(event);
    return event;
  }

  list(runId?: string): readonly RunEvent[] {
    if (!runId) return this.#events;
    return this.#events.filter((e) => e.runId === runId);
  }

  get size(): number {
    return this.#events.length;
  }
}
