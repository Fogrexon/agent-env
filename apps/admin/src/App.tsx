import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  appendFoldedProgressEvent,
  rebuildProgressStreamRows,
  type AgentManifest,
  type AgentParamsSpec,
  type AgentProgressEvent,
  type ModelRef,
} from '@agent-env/shared';
import { ParamForm } from './components/ParamForm';
import { MarkdownReportReader } from './components/ReportReader';
import { RunArtifactsPanel } from './components/RunArtifactsPanel';
import { MarkdownView } from './components/MarkdownView';

interface AgentListItem {
  id: string;
  name: string;
  description: string;
  title?: string;
  runMode?: string;
  fieldCount?: number;
  paramsFile?: string;
  models?: AgentManifest['models'];
}

interface RunSpecModels {
  primary: ModelRef;
  allowed: ModelRef[];
}

/** Mirrors ProviderMediaInfo from @agent-env/llm (kept local to stay browser-light). */
interface ProviderMediaInfo {
  id: string;
  kind?: string;
  configured: boolean;
  categories: string[];
  mimeTypes: string[];
  maxBytesPerFile?: number;
  notes?: string;
}

interface ParamsResponse {
  manifest: AgentManifest;
  spec: AgentParamsSpec;
  defaults: Record<string, unknown>;
  runspecModels?: RunSpecModels;
}

interface StartRunResponse {
  ok: boolean;
  runId?: string;
  agentId?: string;
  runMode?: string;
  status?: string;
  error?: string;
  issues?: string[];
}

interface RunSnapshot {
  runId: string;
  agentId: string;
  runMode: string;
  status: string;
  messagePreview?: string;
  events: AgentProgressEvent[];
  result?: {
    status: string;
    finalText?: string;
    sessionId?: string;
    agentName?: string;
    error?: string;
    recordState?: string;
    verificationPassed?: boolean;
  };
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface RunSummary {
  runId: string;
  agentId: string;
  runMode: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  messagePreview?: string;
  error?: string;
  finalTextPreview?: string;
}

function modelKey(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

function parseModelKey(key: string): ModelRef | undefined {
  const colon = key.indexOf(':');
  if (colon <= 0) return undefined;
  const provider = key.slice(0, colon).trim();
  const model = key.slice(colon + 1).trim();
  if (!provider || !model) return undefined;
  return { provider, model };
}

function readQuery(): { agent?: string; run?: string } {
  const params = new URLSearchParams(window.location.search);
  return {
    agent: params.get('agent') ?? undefined,
    run: params.get('run') ?? undefined,
  };
}

function writeQuery(agentId: string | null, runId: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (agentId) params.set('agent', agentId);
  else params.delete('agent');
  if (runId) params.set('run', runId);
  else params.delete('run');
  const qs = params.toString();
  const next = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
  window.history.replaceState(null, '', next);
}

function previewMessage(text: unknown, max = 120): string | undefined {
  if (typeof text !== 'string') return undefined;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function upsertEvent(
  prev: AgentProgressEvent[],
  data: AgentProgressEvent,
): AgentProgressEvent[] {
  const streamRows = rebuildProgressStreamRows(prev);
  return appendFoldedProgressEvent(prev, streamRows, data).events;
}

function eventBody(event: AgentProgressEvent): string {
  return (
    event.message ??
    event.agentEvent?.text ??
    event.agentEvent?.errorMessage ??
    '—'
  );
}

function eventFullText(event: AgentProgressEvent): string {
  return event.agentEvent?.text ?? event.message ?? '';
}

function previewSnippet(text: string, max = 96): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

/**
 * Newest end of cumulative text for a live ticker.
 * Prefer the last non-empty line; fall back to a trailing window.
 */
function streamTickerText(text: string, max = 220): string {
  const normalized = text.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return normalized.slice(-max);
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function FoldToggle({
  open,
  onToggle,
  labelOpen = '閉じる',
  labelClosed = '開く',
}: {
  open: boolean;
  onToggle: () => void;
  labelOpen?: string;
  labelClosed?: string;
}) {
  return (
    <button type="button" className="event-toggle" onClick={onToggle}>
      {open ? labelOpen : labelClosed}
    </button>
  );
}

/**
 * Progress rows stay short: default = delta / one-line summary.
 * Full stream text and tool config only appear after 開く.
 */
function TimelineEventRow({
  event,
  runActive,
}: {
  event: AgentProgressEvent;
  runActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tickerRef = useRef<HTMLDivElement | null>(null);
  const [tickerOverflows, setTickerOverflows] = useState(false);
  const full = eventFullText(event);
  const payload = event.payload;
  const hasToolPayload = Boolean(
    payload &&
      (payload['config'] !== undefined ||
        payload['input'] !== undefined ||
        payload['tool'] !== undefined),
  );
  const isTextStream =
    event.kind === 'agent.event' &&
    Boolean(event.agentEvent?.text) &&
    !hasToolPayload;
  const live = Boolean(event.agentEvent?.partial) && runActive;
  const liveTicker = streamTickerText(full);
  const doneHint = previewSnippet(full) || eventBody(event);
  const isTerminal =
    event.kind === 'run.completed' || event.kind === 'run.failed';
  const terminalSummary =
    event.kind === 'run.completed'
      ? `completed${
          typeof payload?.['finalTextChars'] === 'number'
            ? ` · ${Number(payload['finalTextChars']).toLocaleString()} 文字`
            : ''
        }`
      : previewSnippet(event.message ?? 'failed', 96) || 'failed';

  useEffect(() => {
    if (!live) {
      setTickerOverflows(false);
      return;
    }
    const el = tickerRef.current;
    if (!el) return;
    const measure = () => {
      setTickerOverflows(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [live, liveTicker]);

  return (
    <div
      className={`event kind-${event.kind.replace(/\./g, '-')}${
        live ? ' partial' : ''
      }${open ? ' expanded' : ''}`}
    >
      <div className="author">
        #{event.sequence} · {event.kind}
        {event.author ? ` · ${event.author}` : ''}
        {event.state ? ` · ${event.state}` : ''}
        {event.phase ? ` · ${event.phase}` : ''}
        {isTextStream || hasToolPayload ? (
          <FoldToggle open={open} onToggle={() => setOpen((v) => !v)} />
        ) : null}
        <span className="ts">
          {' '}
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>

      {hasToolPayload ? (
        <div className="event-fold">
          <div className="event-fold-summary">
            {live ? (
              <span className="event-thinking-pulse" aria-hidden />
            ) : null}
            <span>{event.message ?? 'tool'}</span>
            {!open && payload?.['tool'] ? (
              <span className="event-fold-meta">
                {String(payload['tool'])}
              </span>
            ) : null}
          </div>
          {open ? (
            <div className="event-tool">
              {payload?.['input'] !== undefined ? (
                <pre className="event-json">
                  <span className="event-json-label">input</span>
                  {formatJson(payload['input'])}
                </pre>
              ) : null}
              {payload?.['config'] !== undefined ? (
                <pre className="event-json">
                  <span className="event-json-label">config</span>
                  {formatJson(payload['config'])}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : isTextStream ? (
        <div className={`event-fold${live ? ' is-live' : ''}`}>
          <div className="event-fold-summary">
            {live ? <span className="event-thinking-pulse" aria-hidden /> : null}
            {live ? (
              <div
                ref={tickerRef}
                className={`event-stream-ticker${
                  tickerOverflows ? '' : ' is-short'
                }`}
                title={liveTicker}
              >
                <span>{liveTicker}</span>
              </div>
            ) : (
              <span className="event-fold-delta">{doneHint}</span>
            )}
            <span className="event-fold-meta">
              {full.length.toLocaleString()} 文字
            </span>
          </div>
          {open ? (
            <MarkdownView content={full} className="markdown-view compact event-fold-body" />
          ) : null}
        </div>
      ) : isTerminal ? (
        <div className="event-plain">{terminalSummary}</div>
      ) : (
        <div className="event-plain">{previewSnippet(eventBody(event), 120)}</div>
      )}

      {event.agentEvent?.functionCalls?.length && !hasToolPayload && open ? (
        <pre className="event-json">
          <span className="event-json-label">functionCalls</span>
          {formatJson(event.agentEvent.functionCalls)}
        </pre>
      ) : null}
      {event.agentEvent?.functionResponses?.length && open ? (
        <pre className="event-json">
          <span className="event-json-label">functionResponses</span>
          {formatJson(event.agentEvent.functionResponses)}
        </pre>
      ) : null}
    </div>
  );
}

export function App() {
  const initialQuery = useMemo(() => readQuery(), []);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [providers, setProviders] = useState<ProviderMediaInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialQuery.agent ?? null,
  );
  const [params, setParams] = useState<ParamsResponse | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [selectedModelKey, setSelectedModelKey] = useState<string>('');
  const [loadingList, setLoadingList] = useState(true);
  const [loadingParams, setLoadingParams] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(initialQuery.run ?? null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [liveEvents, setLiveEvents] = useState<AgentProgressEvent[]>([]);
  const [runSnapshot, setRunSnapshot] = useState<RunSnapshot | null>(null);
  const [taskRuns, setTaskRuns] = useState<RunSummary[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const restoredRunRef = useRef(false);

  const closeStream = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  const refreshTaskList = useCallback(async () => {
    try {
      const res = await fetch('/api/runs');
      if (!res.ok) return;
      const data = (await res.json()) as { runs?: RunSummary[] };
      setTaskRuns(data.runs ?? []);
    } catch {
      // task list is best-effort; optimistic entries remain until next success
    }
  }, []);

  const clearRunView = useCallback(() => {
    closeStream();
    setRunId(null);
    setRunStatus(null);
    setLiveEvents([]);
    setRunSnapshot(null);
    setRunning(false);
  }, [closeStream]);

  const refreshRun = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}`);
    if (!res.ok) return null;
    const data = (await res.json()) as RunSnapshot;
    setRunSnapshot(data);
    setRunStatus(data.status);
    setLiveEvents(data.events ?? []);
    setRunning(data.status === 'queued' || data.status === 'running');
    return data;
  }, []);

  const subscribeRun = useCallback(
    (id: string, afterSequence = -1) => {
      closeStream();
      const qs =
        afterSequence >= 0 ? `?after=${encodeURIComponent(String(afterSequence))}` : '';
      const es = new EventSource(`/api/runs/${id}/events${qs}`);
      eventSourceRef.current = es;

      es.addEventListener('progress', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as AgentProgressEvent;
        setLiveEvents((prev) => upsertEvent(prev, data));
        if (data.kind === 'run.state' && data.state) {
          setRunStatus(data.state);
        }
        void refreshTaskList();
      });

      es.addEventListener('status', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          status?: string;
        };
        if (data.status) {
          setRunStatus(data.status);
          setTaskRuns((prev) =>
            prev.map((task) =>
              task.runId === id
                ? { ...task, status: data.status!, updatedAt: new Date().toISOString() }
                : task,
            ),
          );
        }
      });

      es.addEventListener('terminal', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          status?: string;
        };
        if (data.status) {
          setRunStatus(data.status);
          setTaskRuns((prev) =>
            prev.map((task) =>
              task.runId === id
                ? { ...task, status: data.status!, updatedAt: new Date().toISOString() }
                : task,
            ),
          );
        }
        void refreshRun(id);
        void refreshTaskList();
        setRunning(false);
        closeStream();
      });

      es.onerror = () => {
        void refreshRun(id).finally(() => {
          const current = eventSourceRef.current;
          if (current?.readyState === EventSource.CLOSED) {
            setRunning(false);
          }
        });
      };
    },
    [closeStream, refreshRun, refreshTaskList],
  );

  const openRun = useCallback(
    async (id: string, opts?: { selectAgent?: boolean }) => {
      closeStream();
      setError(null);
      setRunId(id);
      const snap = await refreshRun(id);
      if (!snap) {
        setError(`Unknown run: ${id}`);
        setRunId(null);
        writeQuery(selectedId, null);
        return;
      }
      if (opts?.selectAgent !== false) {
        setSelectedId(snap.agentId);
      }
      writeQuery(snap.agentId, id);
      if (snap.status === 'queued' || snap.status === 'running') {
        const after = snap.events.at(-1)?.sequence ?? -1;
        subscribeRun(id, after);
      }
    },
    [closeStream, refreshRun, selectedId, subscribeRun],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingList(true);
      try {
        const res = await fetch('/api/agents');
        const data = (await res.json()) as { agents: AgentListItem[] };
        if (cancelled) return;
        setAgents(data.agents);
        const fromQuery = initialQuery.agent;
        if (fromQuery && data.agents.some((a) => a.id === fromQuery)) {
          setSelectedId(fromQuery);
        } else if (!selectedId && data.agents[0]) {
          setSelectedId(data.agents[0].id);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bootstrap once
  }, []);

  useEffect(() => {
    void refreshTaskList();
    const timer = setInterval(() => void refreshTaskList(), 5000);
    return () => clearInterval(timer);
  }, [refreshTaskList]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/providers');
        const data = (await res.json()) as { providers?: ProviderMediaInfo[] };
        if (!cancelled && data.providers) setProviders(data.providers);
      } catch {
        // media panel is informational; ignore failures
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    (async () => {
      setLoadingParams(true);
      setError(null);
      try {
        const res = await fetch(`/api/agents/${selectedId}/params`);
        const data = (await res.json()) as ParamsResponse & { error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        if (cancelled) return;
        setParams(data);
        setValues(data.defaults);
        setSelectedModelKey(
          data.runspecModels ? modelKey(data.runspecModels.primary) : '',
        );
      } catch (err) {
        if (!cancelled) {
          setParams(null);
          setSelectedModelKey('');
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setLoadingParams(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  useEffect(() => {
    if (restoredRunRef.current) return;
    if (!initialQuery.run) {
      restoredRunRef.current = true;
      return;
    }
    restoredRunRef.current = true;
    void openRun(initialQuery.run);
  }, [initialQuery.run, openRun]);

  useEffect(() => {
    return () => {
      closeStream();
    };
  }, [closeStream]);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [liveEvents]);

  const onFieldChange = useCallback((id: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  const onSelectAgent = (id: string) => {
    if (id === selectedId) return;
    // Detach the detail panel from any previous run; tasks stay in the sidebar.
    clearRunView();
    setError(null);
    setSelectedId(id);
    writeQuery(id, null);
  };

  const onRun = async () => {
    if (!selectedId) return;
    closeStream();
    setRunning(true);
    setError(null);
    setLiveEvents([]);
    setRunSnapshot(null);
    setRunStatus('queued');
    try {
      const model =
        params?.runspecModels && selectedModelKey
          ? parseModelKey(selectedModelKey)
          : undefined;
      const res = await fetch(`/api/agents/${selectedId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values, ...(model ? { model } : {}) }),
      });
      const data = (await res.json()) as StartRunResponse;
      if (!res.ok || !data.ok || !data.runId) {
        setError(
          [data.error, ...(data.issues ?? [])].filter(Boolean).join('\n') ||
            `HTTP ${res.status}`,
        );
        setRunning(false);
        setRunStatus(null);
        return;
      }
      const now = new Date().toISOString();
      const messageField = params?.spec.fields.find(
        (f) => f.id === params.spec.objectiveField,
      );
      const preview =
        previewMessage(messageField ? values[messageField.id] : undefined) ??
        previewMessage(
          Object.values(values).find((v) => typeof v === 'string' && v.trim()),
        );
      setTaskRuns((prev) => [
        {
          runId: data.runId!,
          agentId: selectedId,
          runMode: data.runMode ?? 'runspec',
          status: data.status ?? 'queued',
          createdAt: now,
          updatedAt: now,
          messagePreview: preview,
        },
        ...prev.filter((r) => r.runId !== data.runId),
      ]);
      setRunId(data.runId);
      setRunStatus(data.status ?? 'queued');
      writeQuery(selectedId, data.runId);
      void refreshTaskList();
      subscribeRun(data.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
      setRunStatus(null);
    }
  };

  const onCancel = async () => {
    if (!runId) return;
    try {
      await fetch(`/api/runs/${runId}/cancel`, { method: 'POST' });
      setRunStatus('cancelling');
      void refreshTaskList();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const title =
    params?.spec.title ??
    agents.find((a) => a.id === selectedId)?.title ??
    selectedId ??
    'agent-env';

  const finalText =
    runSnapshot?.result?.finalText ??
    liveEvents
      .slice()
      .reverse()
      .find((e) => e.kind === 'run.completed' || e.kind === 'run.failed')
      ?.message;

  return (
    <div className="app">
      <aside className="sidebar">
        <p className="brand">agent-env / admin</p>
        <p>
          エージェントを選び実行します。進捗と LLM 本文は SSE でライブ表示され、実行はタスクリストに残ります。
        </p>
        {loadingList ? (
          <p className="empty">Loading…</p>
        ) : (
          <ul className="agent-list">
            {agents.map((agent) => (
              <li key={agent.id}>
                <button
                  type="button"
                  className={agent.id === selectedId ? 'active' : undefined}
                  onClick={() => onSelectAgent(agent.id)}
                >
                  <span className="id">{agent.title ?? agent.id}</span>
                  <span className="desc">
                    {agent.runMode ? `${agent.runMode} · ` : ''}
                    {agent.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="task-list">
          <p className="brand">実行タスク</p>
          {taskRuns.length === 0 ? (
            <p className="empty">まだ実行がありません</p>
          ) : (
            <ul className="agent-list">
              {taskRuns.map((task) => (
                <li key={task.runId}>
                  <button
                    type="button"
                    className={task.runId === runId ? 'active' : undefined}
                    onClick={() => void openRun(task.runId)}
                  >
                    <span className="id">
                      {task.agentId}
                      <span className={`badge badge-${task.status}`}>
                        {task.status}
                      </span>
                    </span>
                    <span className="desc">
                      {task.messagePreview || task.finalTextPreview || task.runId.slice(0, 8)}
                      {' · '}
                      {new Date(task.createdAt).toLocaleTimeString()}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {providers.length > 0 ? (
          <div className="provider-media">
            <p className="brand">対応メディア（provider 別）</p>
            <ul>
              {providers.map((provider) => (
                <li key={provider.id} title={provider.mimeTypes.join('\n')}>
                  <span className="id">
                    {provider.id}
                    {provider.configured ? '' : ' (unconfigured)'}
                  </span>
                  <span className="desc">
                    {provider.categories.length > 0
                      ? provider.categories.join(' / ')
                      : 'テキストのみ（添付不可）'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="hint">
              delivery: content の添付は、実行する provider が対応する MIME
              のみ送信されます。非対応ならエラーで停止します。
            </p>
          </div>
        ) : null}
      </aside>

      <main className="main">
        <section className="panel">
          <h1>{title}</h1>
          <p className="lede">
            {params?.spec.description ??
              agents.find((a) => a.id === selectedId)?.description ??
              'Select an agent.'}
            {selectedId ? ` · RunSpec: agents/${selectedId}/runspec.json` : null}
          </p>

          {loadingParams ? <p className="empty">Loading params…</p> : null}

          {params ? (
            <>
              {params.runspecModels ? (
                <div className="field model-override">
                  <label htmlFor="runspec-model">モデル（有効 RunSpec へ merge）</label>
                  <div className="hint">
                    テンプレートの primary / allowed から選択し、実行用 RunSpec の
                    model.primary に反映します。未変更時は primary（
                    {modelKey(params.runspecModels.primary)}）。
                  </div>
                  <select
                    id="runspec-model"
                    disabled={running}
                    value={selectedModelKey}
                    onChange={(e) => setSelectedModelKey(e.target.value)}
                  >
                    {params.runspecModels.allowed.map((ref) => {
                      const key = modelKey(ref);
                      const isPrimary =
                        key === modelKey(params.runspecModels!.primary);
                      return (
                        <option key={key} value={key}>
                          {key}
                          {isPrimary ? ' (primary)' : ''}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ) : null}
              <ParamForm
                fields={params.spec.fields}
                values={values}
                onChange={onFieldChange}
                disabled={running}
              />
              <div className="actions">
                <button
                  type="button"
                  className="primary"
                  disabled={running || !selectedId}
                  onClick={() => void onRun()}
                >
                  {running ? '実行中…' : '実行'}
                </button>
                {running ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void onCancel()}
                  >
                    キャンセル
                  </button>
                ) : null}
                <span className="status">
                  {runStatus ? (
                    <span className={`badge badge-${runStatus}`}>
                      {runStatus}
                    </span>
                  ) : null}
                  {runId ? ` · run ${runId.slice(0, 8)}` : null}
                  {params.manifest.paramsFile
                    ? ` · ${params.manifest.paramsFile}`
                    : null}
                </span>
              </div>
            </>
          ) : null}

          {error ? <p className="error">{error}</p> : null}

          {liveEvents.length > 0 || runSnapshot ? (
            <div className="result">
              <h2>
                ライブ進捗
                {runSnapshot?.result?.recordState
                  ? ` · ${runSnapshot.result.recordState}`
                  : ''}
                {runSnapshot?.result?.verificationPassed !== undefined
                  ? ` · verify=${String(runSnapshot.result.verificationPassed)}`
                  : ''}
              </h2>

              <div className="timeline" ref={timelineRef}>
                {liveEvents.map((event) => (
                  <TimelineEventRow
                    event={event}
                    runActive={running}
                    key={event.sequence}
                  />
                ))}
              </div>

              {runId &&
              (runStatus === 'completed' ||
                runStatus === 'failed' ||
                runStatus === 'cancelled' ||
                runSnapshot?.result) ? (
                <RunArtifactsPanel
                  runId={runId}
                  fallbackFinalText={finalText}
                />
              ) : finalText ? (
                <MarkdownReportReader
                  title="最終結果"
                  content={finalText}
                  assetBaseUrl={
                    runId
                      ? `/api/runs/${runId}/files/workspace/`
                      : undefined
                  }
                />
              ) : null}
              {runSnapshot?.result?.error ? (
                <p className="error">{runSnapshot.result.error}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      </main>
    </div>
  );
}
