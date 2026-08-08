import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Col, Row, Space, Statistic, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getControlStats, listRuns } from '../api/client.js';
import type { ControlStats, RunSummary } from '../api/types.js';
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

  const columns: ColumnsType<RunSummary> = [
    {
      title: 'Status',
      dataIndex: 'status',
      width: 110,
      render: (s: string) => <StatusTag status={s} />,
    },
    {
      title: 'Agent',
      dataIndex: 'agentId',
      render: (id: string, row) => (
        <Link to={`/runs/${row.runId}`}>
          <Typography.Text code>{id}</Typography.Text>
        </Link>
      ),
    },
    {
      title: 'Trigger',
      dataIndex: 'trigger',
      width: 100,
      render: (t?: string) => t ?? '—',
    },
    {
      title: 'When',
      dataIndex: 'createdAt',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: 'Preview',
      ellipsis: true,
      render: (_, row) =>
        row.messagePreview ?? row.finalTextPreview ?? row.runId.slice(0, 8),
    },
  ];

  return (
    <PageShell
      title="Dashboard"
      subtitle="Executor slots, queue depth, recent builds"
      crumbs={[{ title: 'Dashboard' }]}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      ) : null}

      <Row gutter={[12, 12]} className="ops-metrics">
        <Col xs={12} sm={8} md={6}>
          <div className="ops-metric">
            <Statistic
              title="Slots in use"
              value={stats ? `${stats.running} / ${stats.maxSlots}` : '—'}
              loading={loading && !stats}
            />
          </div>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <div className="ops-metric">
            <Statistic
              title="Queue depth"
              value={stats?.queueDepth ?? '—'}
              loading={loading && !stats}
            />
          </div>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <div className="ops-metric">
            <Statistic
              title="Failure rate"
              value={
                stats?.failureRate
                  ? Math.round(stats.failureRate.rate * 100)
                  : '—'
              }
              suffix={stats?.failureRate ? '%' : undefined}
              loading={loading && !stats}
            />
            {stats?.failureRate ? (
              <Typography.Text type="secondary" className="ops-metric-hint">
                {stats.failureRate.failed}/{stats.failureRate.total} recent
              </Typography.Text>
            ) : null}
          </div>
        </Col>
        <Col xs={12} sm={8} md={6}>
          <div className="ops-metric">
            <Statistic title="Active builds" value={active.length} />
          </div>
        </Col>
      </Row>

      {stats?.triggers24h ? (
        <div className="ops-panel" style={{ marginTop: 16 }}>
          <Typography.Text strong>Triggers (24h)</Typography.Text>
          <Space wrap size={[8, 8]} style={{ marginTop: 8, display: 'flex' }}>
            {Object.entries(stats.triggers24h).map(([k, v]) => (
              <Typography.Text key={k} code>
                {k}: {Number(v)}
              </Typography.Text>
            ))}
          </Space>
        </div>
      ) : null}

      <div className="ops-panel" style={{ marginTop: 16 }}>
        <FlexHead
          title="Running / queued"
          link={{ to: '/queue', label: 'Open queue' }}
        />
        <Table
          size="small"
          rowKey="runId"
          pagination={false}
          locale={{ emptyText: 'No active builds' }}
          dataSource={active}
          columns={columns}
        />
      </div>

      <div className="ops-panel" style={{ marginTop: 16 }}>
        <FlexHead
          title="Recent builds"
          link={{ to: '/jobs', label: 'Job definitions' }}
        />
        <Table
          size="small"
          rowKey="runId"
          pagination={false}
          loading={loading && runs.length === 0}
          dataSource={runs}
          columns={columns}
        />
      </div>
    </PageShell>
  );
}

function FlexHead({
  title,
  link,
}: {
  title: string;
  link: { to: string; label: string };
}) {
  return (
    <Space
      style={{
        width: '100%',
        justifyContent: 'space-between',
        marginBottom: 12,
      }}
    >
      <Typography.Text strong>{title}</Typography.Text>
      <Link to={link.to}>{link.label}</Link>
    </Space>
  );
}
