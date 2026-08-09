import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AgentProgressEvent } from '@agent-env/shared';
import { Button, InlineNotification } from '@carbon/react';
import { getRun, upsertEvent } from '../api/client.js';
import type { RunSnapshot, RunStage } from '../api/types.js';
import {
  isTerminalRunStatus,
} from '../api/types.js';
import { AgentGraphPanel } from '../components/AgentGraphPanel.js';
import { MarkdownReportReader } from '../components/ReportReader.js';
import { RunArtifactsPanel } from '../components/RunArtifactsPanel.js';
import { TimelineEventRow } from '../components/TimelineEventRow.js';
import { PageShell } from '../ui/PageShell.js';
import { OpsPanel } from '../ui/OpsPanel.js';
import { StatusTag } from '../ui/StatusTag.js';

function pendingApprovalsFromEvents(events: AgentProgressEvent[]) {
  const map = new Map<
    string,
    {
      approvalId: string;
      tool: string;
      riskClass: string;
      sideEffect?: string;
      input: Record<string, unknown>;
      message?: string;
    }
  >();
  for (const event of events) {
    if (event.kind === 'approval.requested') {
      const approvalId = String(event.payload?.['approvalId'] ?? '');
      if (!approvalId) continue;
      map.set(approvalId, {
        approvalId,
        tool: String(event.payload?.['tool'] ?? 'tool'),
        riskClass: String(event.payload?.['riskClass'] ?? ''),
        ...(event.payload?.['sideEffect'] !== undefined
          ? { sideEffect: String(event.payload['sideEffect']) }
          : {}),
        input:
          event.payload?.['input'] &&
          typeof event.payload['input'] === 'object' &&
          !Array.isArray(event.payload['input'])
            ? (event.payload['input'] as Record<string, unknown>)
            : {},
        message: event.message,
      });
    } else if (event.kind === 'approval.resolved') {
      const approvalId = String(event.payload?.['approvalId'] ?? '');
      if (approvalId) map.delete(approvalId);
    }
  }
  return [...map.values()];
}

export function RunDetailPage() {
  const { runId = '' } = useParams();
  const [snap, setSnap] = useState<RunSnapshot | null>(null);
  const [events, setEvents] = useState<AgentProgressEvent[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const closeStream = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const refresh = useCallback(async () => {
    if (!runId) return null;
    try {
      const data = await getRun(runId);
      setSnap(data);
      setStatus(data.status);
      setEvents(data.events ?? []);
      setError(null);
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, [runId]);

  const subscribe = useCallback(
    (id: string, after = -1) => {
      closeStream();
      const qs =
        after >= 0 ? `?after=${encodeURIComponent(String(after))}` : '';
      const es = new EventSource(`/api/runs/${id}/events${qs}`);
      esRef.current = es;
      es.addEventListener('progress', (ev) => {
        const data = JSON.parse(
          (ev as MessageEvent).data,
        ) as AgentProgressEvent;
        setEvents((prev) => upsertEvent(prev, data));
        if (data.state) setStatus(data.state);
      });
      es.addEventListener('status', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          status?: string;
        };
        if (data.status) setStatus(data.status);
      });
      es.addEventListener('terminal', () => {
        void refresh();
        closeStream();
      });
      es.onerror = () => {
        void refresh();
      };
    },
    [closeStream, refresh],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await refresh();
      if (cancelled || !data) return;
      if (data.status === 'queued') {
        pollRef.current = setInterval(async () => {
          const next = await refresh();
          if (next && next.status !== 'queued' && !next.fromDisk) {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            if (next.status === 'running') {
              subscribe(runId, next.events.at(-1)?.sequence ?? -1);
            }
          }
        }, 1000);
      } else if (data.status === 'running') {
        subscribe(runId, data.events.at(-1)?.sequence ?? -1);
      }
    })();
    return () => {
      cancelled = true;
      closeStream();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runId, refresh, subscribe, closeStream]);

  useEffect(() => {
    const el = timelineRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  const onCancel = async () => {
    await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
    });
    void refresh();
  };

  const onDecide = async (
    approvalId: string,
    decision: 'granted' | 'denied',
  ) => {
    setDeciding(approvalId);
    try {
      await fetch(
        `/api/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        },
      );
      void refresh();
    } finally {
      setDeciding(null);
    }
  };

  const pending = useMemo(
    () => pendingApprovalsFromEvents(events),
    [events],
  );
  const active =
    status === 'queued' || status === 'running' || status === 'cancelling';
  const finalText =
    snap?.result?.finalText ??
    events
      .slice()
      .reverse()
      .find((e) => e.kind === 'run.completed' || e.kind === 'run.failed')
      ?.message;

  const stages = snap?.stages ?? [];
  const budget = snap?.budgetConsumed;
  const recordState = snap?.recordState ?? snap?.result?.recordState;
  const graph = snap?.observedGraph ?? snap?.effectiveGraph ?? undefined;
  const graphIsObserved = Boolean(snap?.observedGraph);

  return (
    <PageShell
      title={snap?.agentId ?? '…'}
      subtitle={`${runId}${snap?.trigger ? ` · ${snap.trigger}` : ''}${
        snap?.jobId ? ` · job ${snap.jobId.slice(0, 8)}` : ''
      }`}
      crumbs={[
        { title: 'Jobs', path: '/jobs' },
        { title: 'Queue', path: '/queue' },
        { title: 'Run' },
      ]}
      extra={
        <div className="ops-inline-gap ops-wrap">
          {status ? <StatusTag status={status} /> : null}
          {active ? (
            <Button kind="danger" size="sm" onClick={() => void onCancel()}>
              Cancel
            </Button>
          ) : null}
          {snap?.agentId ? (
            <Link to={`/jobs/${snap.agentId}?fromRun=${encodeURIComponent(runId)}`}>
              Reuse on Jobs
            </Link>
          ) : (
            <Link to={`/jobs/${snap?.agentId ?? ''}`}>Rebuild job</Link>
          )}
        </div>
      }
    >
      {error ? (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={error}
          className="ops-inline-alert"
        />
      ) : null}

      {snap?.values ? (
        <OpsPanel title="Inputs" className="ops-stack-gap">
          <pre className="event-json">
            {JSON.stringify(snap.values, null, 2)}
          </pre>
          {snap.agentId ? (
            <div className="ops-action-row" style={{ marginTop: 8 }}>
              <Link
                to={`/jobs/${snap.agentId}?fromRun=${encodeURIComponent(runId)}`}
              >
                Reuse on Jobs
              </Link>
            </div>
          ) : null}
        </OpsPanel>
      ) : null}

      {stages.length > 0 ? (
        <OpsPanel title="Stages" className="ops-stack-gap">
          <ol className="ops-stages">
            {stages.map((s: RunStage, i: number) => (
              <li key={`${s.state}-${s.at}-${i}`}>
                <strong>{s.state}</strong>
                {s.phase ? ` / ${s.phase}` : ''}
                <span className="muted">
                  {' '}
                  {new Date(s.at).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ol>
        </OpsPanel>
      ) : null}

      <OpsPanel title="Budget" className="ops-stack-gap">
        {budget ? (
          <dl className="ops-desc">
            <div>
              <dt>toolCalls</dt>
              <dd>{budget.toolCalls}</dd>
            </div>
            <div>
              <dt>tokens</dt>
              <dd>{budget.tokens}</dd>
            </div>
            <div>
              <dt>wall</dt>
              <dd>{budget.wallSeconds.toFixed(1)}s</dd>
            </div>
            <div>
              <dt>cost</dt>
              <dd>${budget.costUsd.toFixed(4)}</dd>
            </div>
          </dl>
        ) : (
          <p className="muted">—</p>
        )}
        {recordState ? (
          <p className="muted">recordState: {recordState}</p>
        ) : null}
      </OpsPanel>

      {graph ? (
        <OpsPanel title="Graph" className="ops-stack-gap">
          <AgentGraphPanel graph={graph} observed={graphIsObserved} />
        </OpsPanel>
      ) : null}

      {pending.length > 0 ? (
        <OpsPanel title="Approvals" className="ops-stack-gap">
          {pending.map((a) => (
            <div key={a.approvalId} className="ops-approval">
              <p>
                <strong>{a.tool}</strong> / {a.riskClass}
                {a.sideEffect ? ` / ${a.sideEffect}` : ''}
              </p>
              <pre className="event-json">
                {JSON.stringify(a.input, null, 2)}
              </pre>
              <div className="ops-action-row">
                <Button
                  kind="primary"
                  size="sm"
                  disabled={deciding === a.approvalId}
                  onClick={() => void onDecide(a.approvalId, 'granted')}
                >
                  {deciding === a.approvalId ? '…' : 'Grant'}
                </Button>
                <Button
                  kind="secondary"
                  size="sm"
                  disabled={deciding === a.approvalId}
                  onClick={() => void onDecide(a.approvalId, 'denied')}
                >
                  Deny
                </Button>
              </div>
            </div>
          ))}
        </OpsPanel>
      ) : null}

      <OpsPanel title="Console" className="ops-stack-gap">
        <div className="timeline" ref={timelineRef}>
          {events.length === 0 ? (
            <p className="muted">
              {status === 'queued'
                ? 'Waiting in queue for a free slot…'
                : 'No events'}
            </p>
          ) : (
            events.map((ev) => (
              <TimelineEventRow
                key={`${ev.sequence}-${ev.kind}`}
                event={ev}
                runActive={active}
              />
            ))
          )}
        </div>
      </OpsPanel>

      {finalText && isTerminalRunStatus(status ?? '') ? (
        <OpsPanel title="Output" className="ops-stack-gap">
          <MarkdownReportReader title="final" content={finalText} />
        </OpsPanel>
      ) : null}

      {runId ? (
        <OpsPanel title="Artifacts" className="ops-stack-gap">
          <RunArtifactsPanel runId={runId} />
        </OpsPanel>
      ) : null}
    </PageShell>
  );
}
