/**
 * Offline smoke for AgentProgressEvent sequencing + stream fold order.
 */
import {
  appendFoldedProgressEvent,
  createProgressSequencer,
  rebuildProgressStreamRows,
  type AgentProgressEvent,
} from '@agent-env/shared';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}: ${String(actual)} !== ${String(expected)}`);
  }
}

const events: AgentProgressEvent[] = [];
const progress = createProgressSequencer('run-1', (e) => events.push(e));

progress.emit('run.started', { message: 'start' });
progress.emit('agent.event', {
  author: 'demo',
  message: 'hello',
  agentEvent: { author: 'demo', isFinal: false, text: 'hello' },
});
progress.emit('run.state', { state: 'RUNNING', phase: 'reasoning' });
progress.emit('run.completed', { message: 'done' });

assert(events.length === 4, 'expected 4 events');
assert(events[0]?.sequence === 0, 'seq0');
assert(events[1]?.sequence === 1, 'seq1');
assert(events[2]?.sequence === 2, 'seq2');
assert(events[3]?.sequence === 3, 'seq3');
assert(events.every((e) => e.runId === 'run-1'), 'runId');
assert(events[3]?.kind === 'run.completed', 'terminal');

// --- fold: tool with parentAuthor inserts before open LLM row ---
{
  const folded: AgentProgressEvent[] = [];
  const streamRows = new Map<string, number>();
  const runId = 'fold-1';
  let seq = 0;
  const push = (event: Omit<AgentProgressEvent, 'runId' | 'sequence' | 'timestamp'>) => {
    const full: AgentProgressEvent = {
      ...event,
      runId,
      sequence: seq++,
      timestamp: new Date().toISOString(),
    };
    const result = appendFoldedProgressEvent(folded, streamRows, full);
    folded.length = 0;
    folded.push(...result.events);
  };

  push({
    kind: 'agent.event',
    author: 'agentA',
    message: 'a…',
    agentEvent: {
      author: 'agentA',
      isFinal: false,
      partial: true,
      text: 'a…',
    },
  });
  push({
    kind: 'agent.event',
    author: 'agentB',
    message: 'b…',
    agentEvent: {
      author: 'agentB',
      isFinal: false,
      partial: true,
      text: 'b…',
    },
  });
  assertEq(folded.length, 2, 'two parallel streams');
  assertEq(folded[0]?.author, 'agentA', 'A first');
  assertEq(folded[1]?.author, 'agentB', 'B second');

  push({
    kind: 'agent.event',
    author: 'tool:search',
    parentAuthor: 'agentA',
    message: 'invoke search',
    payload: { tool: 'search' },
  });
  assertEq(folded.length, 3, 'tool inserted');
  assertEq(folded[0]?.author, 'tool:search', 'tool before A');
  assertEq(folded[1]?.author, 'agentA', 'A after tool');
  assertEq(folded[2]?.author, 'agentB', 'B stays last among peers');

  // Further A tokens must not reorder peers
  push({
    kind: 'agent.event',
    author: 'agentA',
    message: 'a… more',
    agentEvent: {
      author: 'agentA',
      isFinal: false,
      partial: true,
      text: 'a… more',
    },
  });
  assertEq(folded[0]?.author, 'tool:search', 'tool still first');
  assertEq(folded[1]?.author, 'agentA', 'A still middle');
  assertEq(folded[1]?.agentEvent?.text, 'a… more', 'A text updated');
  assertEq(folded[2]?.author, 'agentB', 'B still last');

  // Client rebuild path matches
  const rebuilt = rebuildProgressStreamRows(folded);
  assertEq(rebuilt.get('agentA::'), 1, 'rebuild A index');
  assertEq(rebuilt.get('agentB::'), 2, 'rebuild B index');
}

console.log('✓ smoke-progress passed');
