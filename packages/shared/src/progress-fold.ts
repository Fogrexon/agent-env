import type { AgentProgressEvent } from './progress.js';

/** Rows are keyed by author (+branch) so parallel branches never share one. */
export function progressStreamKey(event: AgentProgressEvent): string {
  return `${event.author ?? ''}::${event.agentEvent?.branch ?? ''}`;
}

export function isPartialAgentProgress(event: AgentProgressEvent): boolean {
  return event.kind === 'agent.event' && Boolean(event.agentEvent?.partial);
}

export function clearPartialAgentProgress(
  event: AgentProgressEvent,
): AgentProgressEvent {
  if (!event.agentEvent?.partial) return event;
  const { partial: _partial, ...agentEvent } = event.agentEvent;
  return { ...event, agentEvent };
}

/**
 * Open stream row index for a parent agent author (highest index if several
 * branches are in flight).
 */
export function findOpenStreamIndexForParent(
  streamRowByAuthor: Map<string, number>,
  parentAuthor: string,
): number | undefined {
  const prefix = `${parentAuthor}::`;
  let best: number | undefined;
  for (const [key, idx] of streamRowByAuthor) {
    if (!key.startsWith(prefix)) continue;
    if (best === undefined || idx > best) best = idx;
  }
  return best;
}

function shiftStreamRowsAfterInsert(
  streamRowByAuthor: Map<string, number>,
  insertAt: number,
): void {
  for (const [key, idx] of streamRowByAuthor) {
    if (idx >= insertAt) streamRowByAuthor.set(key, idx + 1);
  }
}

/**
 * Rebuild in-flight stream row indices from the current event list.
 * Useful for clients that do not keep a persistent map across upserts.
 */
export function rebuildProgressStreamRows(
  events: readonly AgentProgressEvent[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (isPartialAgentProgress(event)) {
      map.set(progressStreamKey(event), i);
    }
  }
  return map;
}

export interface FoldProgressAppendResult {
  events: AgentProgressEvent[];
  /** Event to broadcast (may reuse an older sequence when folding chunks). */
  notified: AgentProgressEvent;
}

/**
 * Fold streaming LLM chunks into one row per author/branch, and insert
 * parented mid-stream tool events immediately before their open LLM row
 * (so the still-running LLM stays below its tools without thrashing peers).
 *
 * Mutates `streamRowByAuthor` in place to match the returned `events`.
 */
export function appendFoldedProgressEvent(
  events: AgentProgressEvent[],
  streamRowByAuthor: Map<string, number>,
  event: AgentProgressEvent,
): FoldProgressAppendResult {
  if (event.kind === 'agent.event' && event.agentEvent) {
    const key = progressStreamKey(event);
    const rowIndex = streamRowByAuthor.get(key);
    const row = rowIndex === undefined ? undefined : events[rowIndex];

    if (row) {
      const merged = isPartialAgentProgress(event)
        ? { ...event, sequence: row.sequence }
        : clearPartialAgentProgress({ ...event, sequence: row.sequence });
      if (!isPartialAgentProgress(event)) {
        streamRowByAuthor.delete(key);
      }
      const next = events.slice();
      next[rowIndex!] = merged;
      return { events: next, notified: merged };
    }

    if (isPartialAgentProgress(event)) {
      const next = [...events, event];
      streamRowByAuthor.set(key, next.length - 1);
      return { events: next, notified: event };
    }
  }

  const parentAuthor = event.parentAuthor;
  if (parentAuthor) {
    const insertAt = findOpenStreamIndexForParent(
      streamRowByAuthor,
      parentAuthor,
    );
    if (insertAt !== undefined) {
      const next = events.slice();
      next.splice(insertAt, 0, event);
      shiftStreamRowsAfterInsert(streamRowByAuthor, insertAt);
      return { events: next, notified: event };
    }
  }

  return { events: [...events, event], notified: event };
}
