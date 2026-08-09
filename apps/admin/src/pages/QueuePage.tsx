import { Renew } from '@carbon/icons-react';
import {
  Button,
  InlineNotification,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@carbon/react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listQueue, listRuns } from '../api/client.js';
import type { QueueJob, RunSummary } from '../api/types.js';
import { isTerminalRunStatus } from '../api/types.js';
import { OpsPanel } from '../ui/OpsPanel.js';
import { PageShell } from '../ui/PageShell.js';
import { StatusTag } from '../ui/StatusTag.js';

export function QueuePage() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [meta, setMeta] = useState({ maxSlots: 0, running: 0, queueDepth: 0 });
  const [filter, setFilter] = useState({ agent: '', status: '', trigger: '' });
  const [error, setError] = useState<string | null>(null);
  const [histPage, setHistPage] = useState(1);
  const pageSize = 25;

  const refresh = async () => {
    try {
      const [q, r] = await Promise.all([listQueue(), listRuns()]);
      setJobs(q.jobs);
      setMeta({
        maxSlots: q.maxSlots,
        running: q.running,
        queueDepth: q.queueDepth,
      });
      setRuns(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, []);

  const onCancelJob = async (jobId: string) => {
    try {
      await fetch(`/api/queue/${encodeURIComponent(jobId)}/cancel`, {
        method: 'POST',
      });
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const filteredHistory = useMemo(() => {
    return runs.filter((r) => {
      if (filter.agent && r.agentId !== filter.agent) return false;
      if (filter.status && r.status !== filter.status) return false;
      if (filter.trigger && r.trigger !== filter.trigger) return false;
      return true;
    });
  }, [runs, filter]);

  const agents = useMemo(
    () => [...new Set(runs.map((r) => r.agentId))].sort(),
    [runs],
  );

  const histPages = Math.max(1, Math.ceil(filteredHistory.length / pageSize));
  const safeHistPage = Math.min(histPage, histPages);
  const histRows = filteredHistory.slice(
    (safeHistPage - 1) * pageSize,
    safeHistPage * pageSize,
  );

  return (
    <PageShell
      title="Queue / Builds"
      subtitle={`slots ${meta.running}/${meta.maxSlots} · pending ${meta.queueDepth}`}
      crumbs={[{ title: 'Jobs', path: '/jobs' }, { title: 'Queue' }]}
      extra={
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={Renew}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
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

      <OpsPanel title="Active queue">
        {jobs.length === 0 ? (
          <p className="muted">Queue is empty</p>
        ) : (
          <Table size="sm">
            <TableHead>
              <TableRow>
                <TableHeader>Status</TableHeader>
                <TableHeader>Agent</TableHeader>
                <TableHeader>Trigger</TableHeader>
                <TableHeader>Pri</TableHeader>
                <TableHeader>Preview</TableHeader>
                <TableHeader />
              </TableRow>
            </TableHead>
            <TableBody>
              {jobs.map((j) => (
                <TableRow key={j.jobId}>
                  <TableCell>
                    <StatusTag status={j.status} />
                  </TableCell>
                  <TableCell>
                    <Link to={`/runs/${j.runId}`}>
                      <code>{j.agentId}</code>
                    </Link>
                  </TableCell>
                  <TableCell>{j.trigger}</TableCell>
                  <TableCell>{j.priority}</TableCell>
                  <TableCell className="ops-ellipsis">
                    {j.messagePreview ?? j.runId.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    {j.status === 'pending' ||
                    j.status === 'claimed' ||
                    j.status === 'running' ? (
                      <Button
                        kind="danger--tertiary"
                        size="sm"
                        onClick={() => void onCancelJob(j.jobId)}
                      >
                        Cancel
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </OpsPanel>

      <OpsPanel
        title="Build history"
        actions={
          <div className="ops-filter-row">
            <Select
              id="queue-filter-agent"
              labelText="Agent"
              hideLabel
              size="sm"
              value={filter.agent}
              onChange={(e) => {
                setFilter((f) => ({ ...f, agent: e.target.value }));
                setHistPage(1);
              }}
            >
              <SelectItem value="" text="All agents" />
              {agents.map((a) => (
                <SelectItem key={a} value={a} text={a} />
              ))}
            </Select>
            <Select
              id="queue-filter-status"
              labelText="Status"
              hideLabel
              size="sm"
              value={filter.status}
              onChange={(e) => {
                setFilter((f) => ({ ...f, status: e.target.value }));
                setHistPage(1);
              }}
            >
              <SelectItem value="" text="All status" />
              {[
                'queued',
                'running',
                'completed',
                'failed',
                'cancelled',
              ].map((s) => (
                <SelectItem key={s} value={s} text={s} />
              ))}
            </Select>
            <Select
              id="queue-filter-trigger"
              labelText="Trigger"
              hideLabel
              size="sm"
              value={filter.trigger}
              onChange={(e) => {
                setFilter((f) => ({ ...f, trigger: e.target.value }));
                setHistPage(1);
              }}
            >
              <SelectItem value="" text="All triggers" />
              {['manual', 'schedule', 'webhook'].map((t) => (
                <SelectItem key={t} value={t} text={t} />
              ))}
            </Select>
          </div>
        }
        className="ops-stack-gap"
      >
        <Table size="sm">
          <TableHead>
            <TableRow>
              <TableHeader>Status</TableHeader>
              <TableHeader>Agent</TableHeader>
              <TableHeader>Trigger</TableHeader>
              <TableHeader>When</TableHeader>
              <TableHeader>Preview</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {histRows.map((r) => {
              const base =
                r.messagePreview ?? r.finalTextPreview ?? r.runId.slice(0, 8);
              const err =
                isTerminalRunStatus(r.status) && r.error
                  ? ` / ${r.error.slice(0, 60)}`
                  : '';
              return (
                <TableRow key={r.runId}>
                  <TableCell>
                    <StatusTag status={r.status} />
                  </TableCell>
                  <TableCell>
                    <Link to={`/runs/${r.runId}`}>
                      <code>{r.agentId}</code>
                    </Link>
                  </TableCell>
                  <TableCell>{r.trigger ?? '—'}</TableCell>
                  <TableCell>
                    {new Date(r.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="ops-ellipsis">{`${base}${err}`}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {filteredHistory.length > pageSize ? (
          <div className="ops-pager">
            <Button
              kind="ghost"
              size="sm"
              disabled={safeHistPage <= 1}
              onClick={() => setHistPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <span className="muted">
              {safeHistPage} / {histPages}
            </span>
            <Button
              kind="ghost"
              size="sm"
              disabled={safeHistPage >= histPages}
              onClick={() => setHistPage((p) => Math.min(histPages, p + 1))}
            >
              Next
            </Button>
          </div>
        ) : null}
      </OpsPanel>
    </PageShell>
  );
}
