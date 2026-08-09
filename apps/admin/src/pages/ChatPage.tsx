import { Add, Bot, Code, Send, Tools, TrashCan } from '@carbon/icons-react';
import type { AgentProgressEvent } from '@agent-env/shared';
import {
  Button,
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  TextArea,
} from '@carbon/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  deleteChatSession,
  getAgentParams,
  getChatSession,
  getRun,
  listAgents,
  listChatSessions,
  saveChatSession,
  upsertEvent,
} from '../api/client.js';
import {
  isTerminalRunStatus,
  type AgentListItem,
  type ChatSessionSummary,
  type ChatSessionTurn,
  type ParamsResponse,
} from '../api/types.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { ParamForm } from '../components/ParamForm.js';
import { AgentSelect } from '../ui/AgentSelect.js';
import { OpsPanel } from '../ui/OpsPanel.js';
import { PageShell } from '../ui/PageShell.js';
import {
  PickAgentEmpty,
  type RecentAgentLink,
} from '../ui/PickAgentEmpty.js';
import {
  assistantMarkdownContent,
  formatJsonDisplay,
  toolSummaryMessage,
} from '../utils/assistant-content.js';
import { groupAgentsByPack } from '../utils/agent-groups.js';

type TurnRole = 'user' | 'assistant';

interface SessionTurn {
  id: string;
  role: TurnRole;
  /** Final assistant text used for follow-up context. */
  text: string;
  runId?: string;
  pending?: boolean;
  streaming?: boolean;
  error?: string;
  /** Live folded progress for this turn (assistant only). */
  events?: AgentProgressEvent[];
}

type TurnSegment =
  | {
      type: 'text';
      key: string;
      author?: string;
      text: string;
      live: boolean;
    }
  | {
      type: 'tool';
      key: string;
      name: string;
      message?: string;
      input?: unknown;
      response?: unknown;
      live?: boolean;
    }
  | {
      type: 'note';
      key: string;
      label: string;
      live?: boolean;
    };

function interactiveAgents(agents: AgentListItem[]): AgentListItem[] {
  return agents.filter((a) => (a.mode ?? 'autonomous') === 'interactive');
}

function newSessionId(): string {
  return crypto.randomUUID();
}

function leanTurns(turns: SessionTurn[]): ChatSessionTurn[] {
  return turns
    // Keep an in-flight assistant turn once it has a run id. On page return,
    // hydrateEvents can recover its current/final state from durable run data.
    .filter((t) => !t.pending || Boolean(t.runId))
    .map((t) => {
      const row: ChatSessionTurn = {
        id: t.id,
        role: t.role,
        text: t.text,
      };
      if (t.runId) row.runId = t.runId;
      if (t.error) row.error = t.error;
      return row;
    });
}

function titleFromTurns(turns: SessionTurn[] | ChatSessionTurn[]): string {
  const firstUser = turns.find((t) => t.role === 'user');
  const raw = firstUser?.text.trim() ?? '';
  if (!raw) return 'Chat';
  return raw.length > 80 ? `${raw.slice(0, 77)}…` : raw;
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const sec = Math.round((Date.now() - t) / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

function storedToSessionTurns(turns: ChatSessionTurn[]): SessionTurn[] {
  return turns.map((t) => ({
    id: t.id,
    role: t.role,
    text: t.text,
    ...(t.runId ? { runId: t.runId } : {}),
    ...(t.error ? { error: t.error } : {}),
    events: [],
  }));
}

function buildTurnMessage(
  history: SessionTurn[],
  userText: string,
  objectiveField: string,
): Record<string, unknown> {
  const prior = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => !m.pending && !m.error)
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n');
  const composed = prior
    ? `${prior}\n\nUser: ${userText}\n\nAssistant:`
    : userText;
  return { [objectiveField]: composed };
}

function formatRunError(data: {
  error?: string;
  issues?: unknown;
}): string {
  const parts: string[] = [];
  if (data.error) parts.push(data.error);
  if (Array.isArray(data.issues)) {
    for (const issue of data.issues) {
      if (typeof issue === 'string') {
        parts.push(issue);
      } else if (issue && typeof issue === 'object') {
        const row = issue as {
          message?: unknown;
          path?: unknown;
        };
        const path = Array.isArray(row.path)
          ? row.path.map(String).join('.')
          : '';
        const message =
          typeof row.message === 'string' ? row.message : JSON.stringify(issue);
        parts.push(path ? `${path}: ${message}` : message);
      }
    }
  }
  return parts.filter(Boolean).join('\n') || 'Request failed';
}

function toolNameFromEvent(event: AgentProgressEvent): string {
  if (typeof event.payload?.['tool'] === 'string') {
    return event.payload['tool'];
  }
  if (event.author?.startsWith('tool:')) {
    return event.author.slice('tool:'.length);
  }
  return event.author ?? 'tool';
}

/**
 * Chronological transcript segments. Tool rows stay visible even after the
 * final assistant text arrives — they are never collapsed into one blob.
 */
function segmentsFromEvents(events: AgentProgressEvent[]): {
  segments: TurnSegment[];
  text: string;
  streaming: boolean;
  error?: string;
} {
  const segments: TurnSegment[] = [];
  let text = '';
  let streaming = false;
  let error: string | undefined;
  let finalText: string | undefined;

  const upsertTool = (seg: Extract<TurnSegment, { type: 'tool' }>) => {
    const existing = [...segments]
      .reverse()
      .find(
        (s): s is Extract<TurnSegment, { type: 'tool' }> =>
          s.type === 'tool' &&
          s.name === seg.name &&
          (seg.response !== undefined
            ? s.response === undefined
            : s.input === undefined || seg.input !== undefined),
      );
    if (
      existing &&
      ((seg.response !== undefined && existing.response === undefined) ||
        (seg.input !== undefined && existing.input === undefined))
    ) {
      existing.input = seg.input ?? existing.input;
      existing.response = seg.response ?? existing.response;
      existing.message = seg.message ?? existing.message;
      existing.live = seg.live;
      return;
    }
    segments.push(seg);
  };

  for (const event of events) {
    if (event.kind === 'run.failed') {
      streaming = false;
      error = event.message ?? 'Run failed';
      for (const seg of segments) {
        if (seg.type === 'text' || seg.type === 'tool') {
          seg.live = false;
        }
        if (seg.type === 'note') seg.live = false;
      }
      continue;
    }
    if (event.kind === 'run.completed') {
      streaming = false;
      if (typeof event.payload?.['finalText'] === 'string') {
        finalText = event.payload['finalText'];
      }
      for (const seg of segments) {
        if (seg.type === 'text' || seg.type === 'tool') {
          seg.live = false;
        }
        if (seg.type === 'note') seg.live = false;
      }
      continue;
    }
    if (event.kind !== 'agent.event') continue;

    const ae = event.agentEvent;
    const payloadTool =
      event.payload && typeof event.payload['tool'] === 'string'
        ? String(event.payload['tool'])
        : undefined;

    if (payloadTool || event.author?.startsWith('tool:')) {
      upsertTool({
        type: 'tool',
        key: `tool:${event.sequence}`,
        name: toolNameFromEvent(event),
        message: event.message,
        input: event.payload?.['input'],
        live: Boolean(ae?.partial),
      });
    }

    for (const call of ae?.functionCalls ?? []) {
      const name = call.name ?? 'tool';
      upsertTool({
        type: 'tool',
        key: `call:${name}:${event.sequence}`,
        name,
        input: call.args,
        live: Boolean(ae?.partial),
      });
    }

    for (const res of ae?.functionResponses ?? []) {
      const name = res.name ?? 'tool';
      upsertTool({
        type: 'tool',
        key: `result:${name}:${event.sequence}`,
        name,
        response: res.response,
        live: false,
      });
    }

    const author = ae?.author ?? event.author;
    if (
      author &&
      author !== 'system' &&
      author !== 'user' &&
      !author.startsWith('tool:') &&
      event.parentAuthor &&
      (ae?.functionCalls?.length ||
        ae?.functionResponses?.length ||
        ae?.text)
    ) {
      segments.push({
        type: 'note',
        key: `sub:${author}:${event.sequence}`,
        label: author,
        live: Boolean(ae?.partial),
      });
    }

    if (ae?.text) {
      text = ae.text;
      streaming = Boolean(ae.partial);
      const last = segments[segments.length - 1];
      if (
        last?.type === 'text' &&
        last.author === author &&
        (last.live || streaming)
      ) {
        last.text = ae.text;
        last.live = streaming;
      } else {
        segments.push({
          type: 'text',
          key: `text:${event.sequence}`,
          author,
          text: ae.text,
          live: streaming,
        });
      }
    }

    if (ae?.errorMessage) {
      error = ae.errorMessage;
    }
  }

  if (finalText && finalText.trim()) {
    const lastText = [...segments]
      .reverse()
      .find((s): s is Extract<TurnSegment, { type: 'text' }> => s.type === 'text');
    if (lastText) {
      // Prefer a longer streamed body over a short completion notice.
      if (finalText.length >= lastText.text.length) {
        lastText.text = finalText;
      }
      lastText.live = false;
      text = lastText.text;
    } else {
      segments.push({
        type: 'text',
        key: 'final-text',
        text: finalText,
        live: false,
      });
      text = finalText;
    }
    streaming = false;
  }

  return {
    segments,
    text,
    streaming,
    error,
  };
}

function waitForRunStart(
  runId: string,
  signal: AbortSignal,
): Promise<{ status: string; after: number; events: AgentProgressEvent[] }> {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      try {
        const snap = await getRun(runId);
        if (snap.status === 'queued') {
          window.setTimeout(() => void tick(), 400);
          return;
        }
        const events = snap.events ?? [];
        resolve({
          status: snap.status,
          after: events.at(-1)?.sequence ?? -1,
          events,
        });
      } catch (err) {
        reject(err);
      }
    };
    void tick();
  });
}

function preferRicherEvents(
  a: AgentProgressEvent[] | undefined,
  b: AgentProgressEvent[] | undefined,
): AgentProgressEvent[] {
  const left = a ?? [];
  const right = b ?? [];
  if (right.length > left.length) return right;
  if (left.length > right.length) return left;
  // Same length: prefer the side with more toolish / non-text rows.
  const score = (events: AgentProgressEvent[]) =>
    events.reduce((n, ev) => {
      if (ev.kind !== 'agent.event') return n;
      if (ev.author?.startsWith('tool:')) return n + 2;
      if (ev.payload?.['tool'] !== undefined) return n + 2;
      const ae = ev.agentEvent;
      if (ae?.functionCalls?.length || ae?.functionResponses?.length) {
        return n + 2;
      }
      return n + 1;
    }, 0);
  return score(right) > score(left) ? right : left;
}

function followRunEvents(
  runId: string,
  after: number,
  onEvent: (event: AgentProgressEvent) => void,
  signal: AbortSignal,
): Promise<{
  finalText?: string;
  error?: string;
  status: string;
  events: AgentProgressEvent[];
}> {
  return new Promise((resolve, reject) => {
    const es = new EventSource(
      `/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`,
    );
    let settled = false;

    const cleanup = () => {
      es.close();
      signal.removeEventListener('abort', onAbort);
    };

    const finish = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const snap = await getRun(runId);
        resolve({
          status: snap.status,
          finalText: snap.result?.finalText,
          error: snap.error ?? snap.result?.error,
          events: snap.events ?? [],
        });
      } catch (err) {
        reject(err);
      }
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort);

    es.addEventListener('progress', (ev) => {
      try {
        const data = JSON.parse(
          (ev as MessageEvent).data,
        ) as AgentProgressEvent;
        onEvent(data);
      } catch {
        /* ignore malformed chunk */
      }
    });

    es.addEventListener('terminal', () => {
      void finish();
    });

    es.onerror = () => {
      void finish();
    };
  });
}

function renderSegment(seg: TurnSegment): React.ReactNode {
  if (seg.type === 'text') {
    return (
      <div
        key={seg.key}
        className={`ops-agent-seg-text${seg.live ? ' is-live' : ''}`}
      >
        {seg.author && seg.author !== 'system' ? (
          <div className="ops-agent-seg-meta">{seg.author}</div>
        ) : null}
        <MarkdownView content={assistantMarkdownContent(seg.text)} />
        {seg.live ? <span className="ops-agent-caret" aria-hidden /> : null}
      </div>
    );
  }
  if (seg.type === 'tool') {
    const summaryMsg = toolSummaryMessage(seg.message);
    return (
      <details
        key={seg.key}
        className={`ops-agent-seg-tool${seg.live ? ' is-live' : ''}`}
        open={Boolean(seg.live)}
      >
        <summary>
          {seg.live ? (
            <span className="event-thinking-pulse" aria-hidden />
          ) : (
            <Tools size={14} />
          )}
          <span className="ops-agent-step-kind">tool</span>
          <code className="ops-agent-step-label">{seg.name}</code>
          {summaryMsg ? (
            <span className="ops-agent-seg-tool-msg">{summaryMsg}</span>
          ) : null}
        </summary>
        {seg.input !== undefined ? (
          <pre className="event-json">
            <span className="event-json-label">input</span>
            {formatJsonDisplay(seg.input)}
          </pre>
        ) : null}
        {seg.response !== undefined ? (
          <pre className="event-json">
            <span className="event-json-label">response</span>
            {formatJsonDisplay(seg.response)}
          </pre>
        ) : null}
      </details>
    );
  }
  return (
    <div
      key={seg.key}
      className={`ops-agent-step is-subagent${seg.live ? ' is-live' : ''}`}
    >
      {seg.live ? (
        <span className="event-thinking-pulse" aria-hidden />
      ) : (
        <Bot size={14} />
      )}
      <span className="ops-agent-step-kind">subagent</span>
      <code className="ops-agent-step-label">{seg.label}</code>
    </div>
  );
}

function TurnTranscript({
  segments,
  fallbackText,
  streaming,
  error,
}: {
  segments: TurnSegment[];
  fallbackText: string;
  streaming?: boolean;
  error?: string;
}) {
  const visible = segments.map((seg) => {
    if (!streaming && 'live' in seg && seg.live) {
      return { ...seg, live: false };
    }
    return seg;
  });
  const openMode = Boolean(streaming);

  if (error && visible.length === 0 && !fallbackText.trim()) {
    return <MarkdownView content={assistantMarkdownContent(error)} />;
  }

  if (visible.length === 0) {
    if (streaming) {
      return <span className="muted">Working…</span>;
    }
    if (fallbackText.trim()) {
      return (
        <MarkdownView content={assistantMarkdownContent(fallbackText)} />
      );
    }
    return null;
  }

  // While streaming: chronological (live markdown).
  // After: tuck progress away, keep the final answer as the primary surface.
  if (openMode) {
    return (
      <div className="ops-agent-transcript-segs">
        {visible.map((seg) => renderSegment(seg))}
      </div>
    );
  }

  let answerIndex = -1;
  for (let i = visible.length - 1; i >= 0; i--) {
    const seg = visible[i]!;
    if (seg.type === 'text' && seg.text.trim()) {
      answerIndex = i;
      break;
    }
  }

  const progress = visible.filter((_, i) => i !== answerIndex);
  const answerSeg =
    answerIndex >= 0
      ? (visible[answerIndex] as Extract<TurnSegment, { type: 'text' }>)
      : null;
  const answerText = answerSeg?.text.trim()
    ? answerSeg.text
    : fallbackText.trim()
      ? fallbackText
      : '';

  return (
    <div className="ops-agent-transcript-segs">
      {progress.length > 0 ? (
        <details className="ops-agent-progress">
          <summary>
            Progress · {progress.length} step{progress.length === 1 ? '' : 's'}
          </summary>
          <div className="ops-agent-progress-body">
            {progress.map((seg) => renderSegment(seg))}
          </div>
        </details>
      ) : null}
      {answerText ? (
        <div className="ops-agent-answer">
          <MarkdownView content={assistantMarkdownContent(answerText)} />
        </div>
      ) : null}
      {error ? (
        <MarkdownView content={assistantMarkdownContent(error)} />
      ) : null}
    </div>
  );
}

export function ChatPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [params, setParams] = useState<ParamsResponse | null>(null);
  /** Non-objective param values (gates etc.) — seeded from defaults, user-editable. */
  const [gateValues, setGateValues] = useState<Record<string, unknown>>({});
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(newSessionId);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentAgents, setRecentAgents] = useState<RecentAgentLink[]>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const hydrateGenRef = useRef(0);
  const wasSendingRef = useRef(false);

  const sessionAgents = useMemo(() => interactiveAgents(agents), [agents]);
  const sessionAgentGroups = useMemo(
    () => groupAgentsByPack(sessionAgents),
    [sessionAgents],
  );
  const selectedId =
    agentId && sessionAgents.some((a) => a.id === agentId)
      ? agentId
      : undefined;
  const selectedAgent = sessionAgents.find((a) => a.id === selectedId);
  const unknownAgentId =
    Boolean(agentId) && !loading && sessionAgents.length > 0 && !selectedId
      ? agentId
      : undefined;

  const gateFields = useMemo(() => {
    if (!params) return [];
    return params.spec.fields.filter((f) => f.id !== params.spec.objectiveField);
  }, [params]);

  const refreshSessions = async (agent: string) => {
    const list = await listChatSessions(agent);
    setSessions(list);
  };

  const persistSession = async (
    agent: string,
    activeSessionId: string,
    nextTurns: SessionTurn[],
  ) => {
    const lean = leanTurns(nextTurns);
    if (lean.length === 0) return;
    await saveChatSession({
      sessionId: activeSessionId,
      agentId: agent,
      title: titleFromTurns(lean),
      turns: lean,
    });
    await refreshSessions(agent);
  };

  const hydrateEvents = (
    mapped: SessionTurn[],
    agent: string,
    activeSessionId: string,
  ) => {
    const gen = ++hydrateGenRef.current;
    for (const turn of mapped) {
      if (turn.role !== 'assistant' || !turn.runId) continue;
      const runId = turn.runId;
      const turnId = turn.id;
      void getRun(runId)
        .then((snap) => {
          if (hydrateGenRef.current !== gen) return;
          const events = snap.events ?? [];
          const active = !isTerminalRunStatus(snap.status);
          const view = segmentsFromEvents(events);
          setTurns((prev) => {
            const hydrated = prev.map((row) =>
              row.id === turnId
                ? {
                    ...row,
                    events,
                    pending: active,
                    streaming: active,
                    text:
                      active
                        ? view.text || row.text
                        : snap.result?.finalText?.trim() ||
                          view.text ||
                          row.text,
                    error: snap.error ?? snap.result?.error ?? row.error,
                  }
                : row,
            );
            if (!active) {
              void persistSession(agent, activeSessionId, hydrated).catch(
                (err) => {
                  setError(err instanceof Error ? err.message : String(err));
                },
              );
            }
            return hydrated;
          });

          // Resume an in-flight run after navigation.
          const isLatestAssistant =
            [...mapped]
              .reverse()
              .find((t) => t.role === 'assistant' && t.runId)?.id === turnId;
          if (!active || !isLatestAssistant) return;
          if (abortRef.current && !abortRef.current.signal.aborted) {
            // Another resume/send already owns the stream.
            return;
          }
          const ac = new AbortController();
          abortRef.current = ac;
          setSending(true);
          let folded = events.slice();
          const after = folded.at(-1)?.sequence ?? -1;
          const onEvent = (event: AgentProgressEvent) => {
            folded = upsertEvent(folded, event);
            const next = segmentsFromEvents(folded);
            setTurns((prev) =>
              prev.map((row) =>
                row.id === turnId
                  ? {
                      ...row,
                      runId,
                      pending: true,
                      streaming: next.streaming,
                      text: next.text || row.text,
                      events: folded,
                      error: next.error,
                    }
                  : row,
              ),
            );
          };
          void followRunEvents(runId, after, onEvent, ac.signal)
            .then((result) => {
              if (hydrateGenRef.current !== gen) return;
              const merged = preferRicherEvents(result.events, folded);
              const done = segmentsFromEvents(merged);
              const reply =
                result.finalText?.trim() ||
                done.text.trim() ||
                result.error ||
                done.error ||
                `(run ${result.status})`;
              setTurns((prev) => {
                const finalTurns = prev.map((row) =>
                  row.id === turnId
                    ? {
                        ...row,
                        pending: false,
                        streaming: false,
                        runId,
                        text: reply,
                        events: merged,
                        error: result.error ?? done.error,
                      }
                    : row,
                );
                void persistSession(agent, activeSessionId, finalTurns).catch(
                  (err) => {
                    setError(
                      err instanceof Error ? err.message : String(err),
                    );
                  },
                );
                return finalTurns;
              });
            })
            .catch((err) => {
              if (err instanceof DOMException && err.name === 'AbortError') {
                return;
              }
              if (hydrateGenRef.current !== gen) return;
              const msg = err instanceof Error ? err.message : String(err);
              setTurns((prev) =>
                prev.map((row) =>
                  row.id === turnId
                    ? {
                        ...row,
                        pending: false,
                        streaming: false,
                        error: msg,
                        text: row.text || msg,
                      }
                    : row,
                ),
              );
            })
            .finally(() => {
              if (hydrateGenRef.current === gen) setSending(false);
            });
        })
        .catch(() => {
          /* tool history is optional */
        });
    }
  };

  const startFreshSession = () => {
    abortRef.current?.abort();
    hydrateGenRef.current += 1;
    setSessionId(newSessionId());
    setTurns([]);
    setDraft('');
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const a = await listAgents();
        if (cancelled) return;
        setAgents(a);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recent interactive agents (from saved chat sessions) for the empty state.
  useEffect(() => {
    if (selectedId || loading || sessionAgents.length === 0) {
      setRecentAgents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const rows = await Promise.all(
        sessionAgents.slice(0, 16).map(async (agent) => {
          try {
            const sessions = await listChatSessions(agent.id);
            const latest = sessions[0];
            if (!latest) return null;
            return {
              id: agent.id,
              title: agent.title ?? agent.name ?? agent.id,
              updatedAt: latest.updatedAt,
            };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const next = rows
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .sort(
          (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
        )
        .slice(0, 5)
        .map(({ id, title }) => ({ id, title }));
      setRecentAgents(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, loading, sessionAgents]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    abortRef.current?.abort();
    hydrateGenRef.current += 1;
    setSessionId(newSessionId());
    setTurns([]);
    setDraft('');
    setSessions([]);
    void (async () => {
      try {
        const [data, history] = await Promise.all([
          getAgentParams(selectedId),
          listChatSessions(selectedId),
        ]);
        if (cancelled) return;
        setParams(data);
        const gates: Record<string, unknown> = {};
        for (const field of data.spec.fields) {
          if (field.id === data.spec.objectiveField) continue;
          if (data.defaults[field.id] !== undefined) {
            gates[field.id] = data.defaults[field.id];
          }
        }
        setGateValues(gates);
        setSessions(history);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setParams(null);
          setGateValues({});
          setSessions([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns]);

  useEffect(() => {
    if (wasSendingRef.current && !sending) {
      window.requestAnimationFrame(() => {
        const node =
          composerRef.current ??
          (document.getElementById(
            'ops-agent-composer-input',
          ) as HTMLTextAreaElement | null);
        if (node && !node.disabled) node.focus();
      });
    }
    wasSendingRef.current = sending;
  }, [sending]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const onOpenSession = async (id: string) => {
    if (!selectedId || id === sessionId) return;
    abortRef.current?.abort();
    setSending(false);
    setError(null);
    try {
      const session = await getChatSession(id);
      const mapped = storedToSessionTurns(session.turns);
      setSessionId(session.id);
      setTurns(mapped);
      setDraft('');
      hydrateEvents(mapped, selectedId, session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDeleteSession = async (id: string) => {
    if (!selectedId) return;
    try {
      await deleteChatSession(id);
      if (id === sessionId) {
        startFreshSession();
      }
      await refreshSessions(selectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onSend = async () => {
    const text = draft.trim();
    if (!selectedId || !params || !text || sending) return;
    const activeSessionId = sessionId;
    setSending(true);
    setError(null);
    setDraft('');

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    const userTurn: SessionTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
    };
    const pendingId = `a-${Date.now()}`;
    const pending: SessionTurn = {
      id: pendingId,
      role: 'assistant',
      text: '',
      pending: true,
      streaming: true,
      events: [],
    };
    const nextHistory = [...turns, userTurn];
    setTurns([...nextHistory, pending]);

    const patchPending = (patch: Partial<SessionTurn>) => {
      setTurns((prev) =>
        prev.map((m) => (m.id === pendingId ? { ...m, ...patch } : m)),
      );
    };

    const finishTurn = (patch: Partial<SessionTurn>) => {
      setTurns((prev) => {
        const finalTurns = prev.map((m) => {
          if (m.id !== pendingId) return m;
          return {
            ...m,
            pending: false,
            streaming: false,
            ...patch,
            // Never drop streamed progress if a caller omits events.
            events: preferRicherEvents(patch.events, m.events),
          };
        });
        void persistSession(selectedId, activeSessionId, finalTurns).catch(
          (err) => {
            setError(err instanceof Error ? err.message : String(err));
          },
        );
        return finalTurns;
      });
    };

    try {
      // Persist the user's turn before enqueueing. A navigation during the
      // request must not roll the visible conversation back to the last
      // completed assistant turn.
      await persistSession(selectedId, activeSessionId, nextHistory);

      // Refresh defaults so a long-lived tab cannot keep stale allow* = false.
      const fresh = await getAgentParams(selectedId);
      setParams(fresh);
      const values = {
        ...fresh.defaults,
        ...gateValues,
        ...buildTurnMessage(nextHistory, text, fresh.spec.objectiveField),
      };
      const res = await fetch(`/api/agents/${selectedId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values, priority: 0 }),
        signal: ac.signal,
      });
      const data = (await res.json()) as {
        ok?: boolean;
        runId?: string;
        error?: string;
        issues?: unknown;
      };
      if (!res.ok || !data.ok || !data.runId) {
        const msg = formatRunError(data) || `HTTP ${res.status}`;
        finishTurn({
          error: msg,
          text: msg,
        });
        return;
      }

      const runId = data.runId;
      patchPending({ runId });
      // Persist the run association immediately. The assistant body can be
      // reconstructed from run events even if this page is now closed.
      await persistSession(selectedId, activeSessionId, [
        ...nextHistory,
        { ...pending, runId },
      ]);

      const started = await waitForRunStart(runId, ac.signal);
      if (isTerminalRunStatus(started.status)) {
        const snap = await getRun(runId);
        const reply =
          snap.result?.finalText?.trim() ||
          snap.error ||
          snap.result?.error ||
          `(run ${snap.status})`;
        finishTurn({
          runId,
          text: reply,
          events: preferRicherEvents(snap.events, started.events),
          error: snap.error ?? snap.result?.error,
        });
        return;
      }

      let folded: AgentProgressEvent[] = started.events.slice();
      if (folded.length > 0) {
        const seeded = segmentsFromEvents(folded);
        patchPending({
          runId,
          pending: true,
          streaming: seeded.streaming,
          text: seeded.text,
          events: folded,
          error: seeded.error,
        });
      }
      const onEvent = (event: AgentProgressEvent) => {
        folded = upsertEvent(folded, event);
        const view = segmentsFromEvents(folded);
        patchPending({
          runId,
          pending: true,
          streaming: view.streaming,
          text: view.text,
          events: folded,
          error: view.error,
        });
      };

      const result = await followRunEvents(
        runId,
        started.after,
        onEvent,
        ac.signal,
      );
      const events = preferRicherEvents(result.events, folded);
      const view = segmentsFromEvents(events);
      const reply =
        result.finalText?.trim() ||
        view.text.trim() ||
        result.error ||
        view.error ||
        `(run ${result.status})`;
      finishTurn({
        runId,
        text: reply,
        events,
        error: result.error ?? view.error,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      const msg = err instanceof Error ? err.message : String(err);
      finishTurn({
        error: msg,
        text: msg,
      });
    } finally {
      setSending(false);
    }
  };

  const title = selectedId
    ? (params?.spec.title ??
      selectedAgent?.title ??
      selectedId)
    : 'Chat';

  const subtitle = selectedId
    ? [selectedId, params?.spec.description ?? null].filter(Boolean).join(' · ')
    : 'Interactive workspace — pick an agent from Catalog to start.';

  return (
    <PageShell
      fill
      title={title}
      subtitle={subtitle}
      crumbs={[{ title: 'Chat' }]}
      extra={
        <div className="ops-page-extra-row">
          {selectedId ? (
            <>
              <AgentSelect
                id="chat-agent-select"
                labelText="Agent"
                hideLabel
                groups={sessionAgentGroups}
                selectedId={selectedId}
                disabled={loading || sending}
                onChange={(id) => {
                  abortRef.current?.abort();
                  navigate(`/chat/${id}`);
                }}
              />
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Add}
                disabled={sending}
                onClick={() => startFreshSession()}
              >
                New chat
              </Button>
            </>
          ) : null}
          <Link className="ops-browse-catalog" to="/catalog?mode=interactive">
            Browse catalog
          </Link>
        </div>
      }
    >
      {error ? (
        <InlineNotification
          kind="error"
          title={error}
          lowContrast
          onClose={() => setError(null)}
          className="ops-inline-alert"
        />
      ) : null}

      {!selectedId ? (
        <PickAgentEmpty
          mode="interactive"
          loading={loading}
          unknownId={unknownAgentId}
          noneAvailable={!loading && sessionAgents.length === 0}
          recentAgents={recentAgents}
        />
      ) : (
        <>
          <OpsPanel
            title="Sessions"
            actions={
              <span className="muted ops-panel-hint">
                Enter to run · Shift+Enter newline
              </span>
            }
          >
            {sessions.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                No saved chats yet.
              </p>
            ) : (
              <ContainedList
                label=""
                kind="on-page"
                size="sm"
                isInset
                className="ops-chat-history-list"
              >
                {sessions.map((s) => {
                  const active = s.id === sessionId;
                  return (
                    <ContainedListItem
                      key={s.id}
                      onClick={() => void onOpenSession(s.id)}
                      disabled={sending}
                      className={
                        active
                          ? 'ops-chat-history-item is-active'
                          : 'ops-chat-history-item'
                      }
                      action={
                        <IconButton
                          kind="ghost"
                          size="sm"
                          label="Delete chat"
                          disabled={sending}
                          onClick={(e) => {
                            e.stopPropagation();
                            void onDeleteSession(s.id);
                          }}
                        >
                          <TrashCan size={16} />
                        </IconButton>
                      }
                    >
                      <span className="ops-chat-history-title">
                        {s.title || 'Chat'}
                      </span>
                      <span className="ops-chat-history-meta muted">
                        {formatRelativeTime(s.updatedAt)}
                        {s.turnCount > 0 ? ` · ${s.turnCount} turns` : ''}
                      </span>
                    </ContainedListItem>
                  );
                })}
              </ContainedList>
            )}
          </OpsPanel>

          <OpsPanel
            title="Conversation"
            className="ops-stack-gap ops-chat-conversation"
          >
            <div className="ops-agent-transcript">
              {turns.length === 0 ? (
                <div className="ops-agent-empty">
                  <Code size={32} className="ops-agent-empty-icon" />
                  <h2 className="ops-agent-empty-title">Start a session</h2>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Instruct this agent. Tool calls and streamed text appear in
                    order as the turn runs.
                  </p>
                </div>
              ) : (
                turns.map((turn) => {
                  const view =
                    turn.role === 'assistant' && turn.events
                      ? segmentsFromEvents(turn.events)
                      : null;
                  const segments = view?.segments ?? [];
                  return (
                    <article
                      key={turn.id}
                      className={`ops-agent-turn is-${turn.role}${turn.error ? ' is-error' : ''}${turn.streaming ? ' is-streaming' : ''}`}
                    >
                      <div className="ops-agent-turn-rail">
                        <span className="ops-agent-turn-role">
                          {turn.role === 'user' ? 'You' : 'Agent'}
                        </span>
                        {turn.runId ? (
                          <Link
                            className="ops-agent-turn-run"
                            to={`/runs/${turn.runId}`}
                          >
                            run {turn.runId.slice(0, 8)}
                          </Link>
                        ) : null}
                        {turn.streaming ? (
                          <span className="ops-agent-turn-status">
                            streaming
                          </span>
                        ) : null}
                        {turn.pending && !turn.streaming ? (
                          <span className="ops-agent-turn-status">running</span>
                        ) : null}
                      </div>

                      <div className="ops-agent-turn-body">
                        {turn.role === 'user' ? (
                          <pre className="ops-agent-prompt">{turn.text}</pre>
                        ) : turn.error && !segments.length ? (
                          <MarkdownView
                            content={assistantMarkdownContent(turn.error)}
                          />
                        ) : (
                          <TurnTranscript
                            segments={segments}
                            fallbackText={turn.text}
                            streaming={turn.streaming}
                            error={turn.error}
                          />
                        )}
                      </div>
                    </article>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>

            <footer className="ops-agent-composer">
              {gateFields.length > 0 ? (
                <div className="ops-agent-composer-gates">
                  <ParamForm
                    fields={gateFields}
                    values={gateValues}
                    onChange={(id, value) =>
                      setGateValues((prev) => ({ ...prev, [id]: value }))
                    }
                    disabled={!params || sending}
                  />
                </div>
              ) : null}
              <TextArea
                id="ops-agent-composer-input"
                labelText="Instruct the agent"
                hideLabel
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Instruct the agent…"
                rows={3}
                disabled={!params || sending}
                className="ops-agent-composer-input"
                ref={composerRef}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
              />
              <div className="ops-agent-composer-bar">
                <Button
                  kind="primary"
                  renderIcon={Send}
                  disabled={!params || !draft.trim() || sending}
                  onClick={() => void onSend()}
                >
                  {sending ? 'Running…' : 'Run turn'}
                </Button>
              </div>
            </footer>
          </OpsPanel>
        </>
      )}
    </PageShell>
  );
}
