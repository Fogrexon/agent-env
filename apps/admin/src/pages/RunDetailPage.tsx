import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AgentProgressEvent } from '@agent-env/shared';
import {
  Alert,
  Button,
  Col,
  Descriptions,
  Row,
  Space,
  Timeline,
  Typography,
} from 'antd';
import { getRun, upsertEvent } from '../api/client.js';
import type { RunSnapshot, RunStage } from '../api/types.js';
import {
  isTerminalRunStatus,
  verificationLabel,
} from '../api/types.js';
import { AgentGraphPanel } from '../components/AgentGraphPanel.js';
import { MarkdownReportReader } from '../components/ReportReader.js';
import { RunArtifactsPanel } from '../components/RunArtifactsPanel.js';
import { TimelineEventRow } from '../components/TimelineEventRow.js';
import { PageShell } from '../ui/PageShell.js';
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
  const verification = snap?.verification;
  const recordState = snap?.recordState ?? snap?.result?.recordState;
  const verifyLabel = verificationLabel(recordState);
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
        <Space wrap>
          {status ? <StatusTag status={status} /> : null}
          {verifyLabel ? (
            <Typography.Text
              type={recordState === 'SUCCEEDED' ? 'success' : 'secondary'}
              strong
            >
              {verifyLabel}
            </Typography.Text>
          ) : null}
          {active ? (
            <Button danger onClick={() => void onCancel()}>
              Cancel
            </Button>
          ) : null}
          <Link to={`/jobs/${snap?.agentId ?? ''}`}>Rebuild job</Link>
        </Space>
      }
    >
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      ) : null}

      {verifyLabel ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
          Verification: {verifyLabel}
        </Typography.Text>
      ) : null}

      {stages.length > 0 ? (
        <div className="ops-panel" style={{ marginBottom: 16 }}>
          <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
            Stages
          </Typography.Text>
          <Timeline
            items={stages.map((s: RunStage, i: number) => ({
              key: `${s.state}-${s.at}-${i}`,
              children: (
                <>
                  <Typography.Text strong>{s.state}</Typography.Text>
                  {s.phase ? ` / ${s.phase}` : ''}
                  <Typography.Text type="secondary">
                    {' '}
                    {new Date(s.at).toLocaleTimeString()}
                  </Typography.Text>
                </>
              ),
            }))}
          />
        </div>
      ) : null}

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={24} md={12}>
          <div className="ops-panel">
            <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
              Verification
            </Typography.Text>
            {verification ? (
              <>
                <Space style={{ marginBottom: 8 }}>
                  <StatusTag
                    status={verification.passed ? 'succeeded' : 'failed'}
                  />
                  <Typography.Text type="secondary">
                    {verification.graderVersion}
                  </Typography.Text>
                </Space>
                <ul className="ops-check-list">
                  {verification.checks.map(
                    (c: {
                      criterion: string;
                      passed: boolean;
                      detail?: string;
                    }) => (
                      <li key={c.criterion}>
                        {c.passed ? '[ok]' : '[ng]'} {c.criterion}
                        {c.detail ? (
                          <Typography.Text type="secondary">
                            {' '}
                            — {c.detail}
                          </Typography.Text>
                        ) : null}
                      </li>
                    ),
                  )}
                </ul>
              </>
            ) : (
              <Typography.Text type="secondary">
                {snap?.verificationPassed === true
                  ? 'passed'
                  : snap?.verificationPassed === false
                    ? 'failed'
                    : '—'}
              </Typography.Text>
            )}
          </div>
        </Col>
        <Col xs={24} md={12}>
          <div className="ops-panel">
            <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
              Budget
            </Typography.Text>
            {budget ? (
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="toolCalls">
                  {budget.toolCalls}
                </Descriptions.Item>
                <Descriptions.Item label="tokens">
                  {budget.tokens}
                </Descriptions.Item>
                <Descriptions.Item label="wall">
                  {budget.wallSeconds.toFixed(1)}s
                </Descriptions.Item>
                <Descriptions.Item label="cost">
                  ${budget.costUsd.toFixed(4)}
                </Descriptions.Item>
              </Descriptions>
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            )}
            {snap?.recordState || snap?.result?.recordState ? (
              <Typography.Text type="secondary">
                recordState: {snap.recordState ?? snap.result?.recordState}
                {verifyLabel ? ` (${verifyLabel})` : ''}
              </Typography.Text>
            ) : null}
          </div>
        </Col>
      </Row>

      {graph ? (
        <div className="ops-panel" style={{ marginBottom: 16 }}>
          <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
            Graph
          </Typography.Text>
          <AgentGraphPanel graph={graph} observed={graphIsObserved} />
        </div>
      ) : null}

      {pending.length > 0 ? (
        <div className="ops-panel" style={{ marginBottom: 16 }}>
          <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
            Approvals
          </Typography.Text>
          {pending.map((a) => (
            <div key={a.approvalId} className="ops-approval">
              <Typography.Paragraph>
                <Typography.Text strong>{a.tool}</Typography.Text> /{' '}
                {a.riskClass}
                {a.sideEffect ? ` / ${a.sideEffect}` : ''}
              </Typography.Paragraph>
              <pre className="event-json">
                {JSON.stringify(a.input, null, 2)}
              </pre>
              <Space>
                <Button
                  type="primary"
                  loading={deciding === a.approvalId}
                  onClick={() => void onDecide(a.approvalId, 'granted')}
                >
                  Grant
                </Button>
                <Button
                  loading={deciding === a.approvalId}
                  onClick={() => void onDecide(a.approvalId, 'denied')}
                >
                  Deny
                </Button>
              </Space>
            </div>
          ))}
        </div>
      ) : null}

      <div className="ops-panel" style={{ marginBottom: 16 }}>
        <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
          Console
        </Typography.Text>
        <div className="timeline" ref={timelineRef}>
          {events.length === 0 ? (
            <Typography.Text type="secondary">
              {status === 'queued'
                ? 'Waiting in queue for a free slot…'
                : 'No events'}
            </Typography.Text>
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
      </div>

      {finalText && isTerminalRunStatus(status ?? '') ? (
        <div className="ops-panel" style={{ marginBottom: 16 }}>
          <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
            Output
          </Typography.Text>
          <MarkdownReportReader title="final" content={finalText} />
        </div>
      ) : null}

      {runId ? (
        <div className="ops-panel">
          <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
            Artifacts
          </Typography.Text>
          <RunArtifactsPanel runId={runId} />
        </div>
      ) : null}
    </PageShell>
  );
}
