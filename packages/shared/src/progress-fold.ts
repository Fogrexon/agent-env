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

/** Tool / function-call rows must not replace an open LLM text stream. */
export function isToolishProgressEvent(event: AgentProgressEvent): boolean {
  if (event.author?.startsWith('tool:')) return true;
  if (event.payload && event.payload['tool'] !== undefined) return true;
  const ae = event.agentEvent;
  if (!ae) return false;
  return Boolean(
    (ae.functionCalls && ae.functionCalls.length > 0) ||
      (ae.functionResponses && ae.functionResponses.length > 0),
  );
}

function finalizeOpenStreamRow(row: AgentProgressEvent): AgentProgressEvent {
  return clearPartialAgentProgress(row);
}

/**
 * Fold streaming LLM chunks into one row per author/branch, and insert
 * parented mid-stream tool events immediately before their open LLM row
 * (so the still-running LLM stays below its tools without thrashing peers).
 *
 * Non-partial tool / function-call events for the same author never clobber
 * an open text stream — the text row is finalized and the tool is appended
 * (or inserted before the stream when `parentAuthor` is set).
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
      // Toolish completion on the same author/branch: keep streamed text,
      // then record the tool call as its own row instead of overwriting.
      if (
        !isPartialAgentProgress(event) &&
        isToolishProgressEvent(event) &&
        Boolean(row.agentEvent?.text)
      ) {
        const next = events.slice();
        next[rowIndex!] = finalizeOpenStreamRow(row);
        streamRowByAuthor.delete(key);
        // Prefer chronological: text that led to the call, then the call.
        next.splice(rowIndex! + 1, 0, event);
        shiftStreamRowsAfterInsert(streamRowByAuthor, rowIndex! + 1);
        return { events: next, notified: event };
      }

      const merged = isPartialAgentProgress(event)
        ? { ...event, sequence: row.sequence }
        : clearPartialAgentProgress({ ...event, sequence: row.sequence });
      // When finalizing a text stream, keep earlier tool bits if the final
      // chunk omitted them (ADK often sends text-only finals).
      if (
        !isPartialAgentProgress(event) &&
        row.agentEvent &&
        merged.agentEvent
      ) {
        const prevCalls = row.agentEvent.functionCalls;
        const prevResponses = row.agentEvent.functionResponses;
        if (
          prevCalls?.length &&
          !(merged.agentEvent.functionCalls?.length)
        ) {
          merged.agentEvent = {
            ...merged.agentEvent,
            functionCalls: prevCalls,
          };
        }
        if (
          prevResponses?.length &&
          !(merged.agentEvent.functionResponses?.length)
        ) {
          merged.agentEvent = {
            ...merged.agentEvent,
            functionResponses: prevResponses,
          };
        }
        if (!merged.agentEvent.text && row.agentEvent.text) {
          merged.agentEvent = {
            ...merged.agentEvent,
            text: row.agentEvent.text,
          };
        }
      }
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
