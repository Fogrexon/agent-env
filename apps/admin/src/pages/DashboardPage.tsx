import { Renew } from '@carbon/icons-react';
import {
  Button,
  Column,
  Grid,
  InlineNotification,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
} from '@carbon/react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getControlStats, listRuns } from '../api/client.js';
import type { ControlStats, RunSummary } from '../api/types.js';
import { OpsPanel } from '../ui/OpsPanel.js';
import { PageShell } from '../ui/PageShell.js';
import { StatusTag } from '../ui/StatusTag.js';

export function DashboardPage() {
  const [stats, setStats] = useState<ControlStats | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const [s, r] = await Promise.all([getControlStats(), listRuns()]);
      setStats(s);
      setRuns(r.slice(0, 20));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, []);

  const active = runs.filter(
    (r) => r.status === 'running' || r.status === 'queued',
  );

  return (
    <PageShell
      title="Dashboard"
      subtitle="Executor slots, queue depth, recent builds"
      crumbs={[{ title: 'Dashboard' }]}
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

      <Grid className="ops-metrics" condensed narrow>
        <Column sm={4} md={4} lg={4}>
          <Tile className="ops-metric">
            <div className="ops-metric-label">Slots in use</div>
            <div className="ops-metric-value">
              {loading && !stats
                ? '…'
                : stats
                  ? `${stats.running} / ${stats.maxSlots}`
                  : '—'}
            </div>
          </Tile>
        </Column>
        <Column sm={4} md={4} lg={4}>
          <Tile className="ops-metric">
            <div className="ops-metric-label">Queue depth</div>
            <div className="ops-metric-value">
              {loading && !stats ? '…' : (stats?.queueDepth ?? '—')}
            </div>
          </Tile>
        </Column>
        <Column sm={4} md={4} lg={4}>
          <Tile className="ops-metric">
            <div className="ops-metric-label">Failure rate</div>
            <div className="ops-metric-value">
              {loading && !stats
                ? '…'
                : stats?.failureRate
                  ? `${Math.round(stats.failureRate.rate * 100)}%`
                  : '—'}
            </div>
            {stats?.failureRate ? (
              <span className="ops-metric-hint">
                {stats.failureRate.failed}/{stats.failureRate.total} recent
              </span>
            ) : null}
          </Tile>
        </Column>
        <Column sm={4} md={4} lg={4}>
          <Tile className="ops-metric">
            <div className="ops-metric-label">Active builds</div>
            <div className="ops-metric-value">{active.length}</div>
          </Tile>
        </Column>
      </Grid>

      {stats?.triggers24h ? (
        <OpsPanel title="Triggers (24h)" className="ops-stack-gap">
          <div className="ops-chip-row">
            {Object.entries(stats.triggers24h).map(([k, v]) => (
              <Tag key={k} size="sm" type="gray">
                {k}: {Number(v)}
              </Tag>
            ))}
          </div>
        </OpsPanel>
      ) : null}

      <OpsPanel
        title="Running / queued"
        actions={<Link to="/queue">Open queue</Link>}
        className="ops-stack-gap"
      >
        <RunsTable rows={active} empty="No active builds" loading={false} />
      </OpsPanel>

      <OpsPanel
        title="Recent builds"
        actions={<Link to="/jobs">Job definitions</Link>}
        className="ops-stack-gap"
      >
        <RunsTable
          rows={runs}
          empty="No builds yet"
          loading={loading && runs.length === 0}
        />
      </OpsPanel>
    </PageShell>
  );
}

function RunsTable({
  rows,
  empty,
  loading,
}: {
  rows: RunSummary[];
  empty: string;
  loading: boolean;
}) {
  if (loading) {
    return <p className="muted">Loading…</p>;
  }
  if (rows.length === 0) {
    return <p className="muted">{empty}</p>;
  }
  return (
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
        {rows.map((row) => (
          <TableRow key={row.runId}>
            <TableCell>
              <StatusTag status={row.status} />
            </TableCell>
            <TableCell>
              <Link to={`/runs/${row.runId}`}>
                <code>{row.agentId}</code>
              </Link>
            </TableCell>
            <TableCell>{row.trigger ?? '—'}</TableCell>
            <TableCell>{new Date(row.createdAt).toLocaleString()}</TableCell>
            <TableCell className="ops-ellipsis">
              {row.messagePreview ??
                row.finalTextPreview ??
                row.runId.slice(0, 8)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
