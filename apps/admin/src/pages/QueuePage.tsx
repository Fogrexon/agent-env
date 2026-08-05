import { ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Select,
  Space,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { listQueue, listRuns } from '../api/client.js';
import type { QueueJob, RunSummary } from '../api/types.js';
import { isTerminalRunStatus } from '../api/types.js';
import { PageShell } from '../ui/PageShell.js';
import { StatusTag } from '../ui/StatusTag.js';

export function QueuePage() {
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [meta, setMeta] = useState({ maxSlots: 0, running: 0, queueDepth: 0 });
  const [filter, setFilter] = useState({ agent: '', status: '', trigger: '' });
  const [error, setError] = useState<string | null>(null);

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

  const jobColumns: ColumnsType<QueueJob> = [
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
    { title: 'Trigger', dataIndex: 'trigger', width: 100 },
    { title: 'Pri', dataIndex: 'priority', width: 60 },
    {
      title: 'Preview',
      ellipsis: true,
      render: (_, j) => j.messagePreview ?? j.runId.slice(0, 8),
    },
    {
      title: '',
      width: 100,
      render: (_, j) =>
        j.status === 'pending' ||
        j.status === 'claimed' ||
        j.status === 'running' ? (
          <Button
            danger
            size="small"
            onClick={() => void onCancelJob(j.jobId)}
          >
            Cancel
          </Button>
        ) : null,
    },
  ];

  const historyColumns: ColumnsType<RunSummary> = [
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
      render: (_, r) => {
        const base =
          r.messagePreview ?? r.finalTextPreview ?? r.runId.slice(0, 8);
        const err =
          isTerminalRunStatus(r.status) && r.error
            ? ` / ${r.error.slice(0, 60)}`
            : '';
        return `${base}${err}`;
      },
    },
  ];

  return (
    <PageShell
      title="Queue / Builds"
      subtitle={`slots ${meta.running}/${meta.maxSlots} · pending ${meta.queueDepth}`}
      crumbs={[{ title: 'Control' }, { title: 'Queue' }]}
      extra={
        <Button icon={<ReloadOutlined />} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      ) : null}

      <div className="ops-panel">
        <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
          Active queue
        </Typography.Text>
        <Table
          size="small"
          rowKey="jobId"
          pagination={false}
          locale={{ emptyText: 'Queue is empty' }}
          dataSource={jobs}
          columns={jobColumns}
        />
      </div>

      <div className="ops-panel" style={{ marginTop: 16 }}>
        <Space
          wrap
          style={{
            width: '100%',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <Typography.Text strong>Build history</Typography.Text>
          <Space wrap>
            <Select
              allowClear
              placeholder="All agents"
              style={{ minWidth: 140 }}
              value={filter.agent || undefined}
              onChange={(v) => setFilter((f) => ({ ...f, agent: v ?? '' }))}
              options={agents.map((a) => ({ value: a, label: a }))}
            />
            <Select
              allowClear
              placeholder="All status"
              style={{ minWidth: 130 }}
              value={filter.status || undefined}
              onChange={(v) => setFilter((f) => ({ ...f, status: v ?? '' }))}
              options={[
                'queued',
                'running',
                'completed',
                'failed',
                'cancelled',
              ].map((s) => ({ value: s, label: s }))}
            />
            <Select
              allowClear
              placeholder="All triggers"
              style={{ minWidth: 130 }}
              value={filter.trigger || undefined}
              onChange={(v) => setFilter((f) => ({ ...f, trigger: v ?? '' }))}
              options={['manual', 'schedule', 'webhook'].map((t) => ({
                value: t,
                label: t,
              }))}
            />
          </Space>
        </Space>
        <Table
          size="small"
          rowKey="runId"
          pagination={{ pageSize: 25, size: 'small' }}
          dataSource={filteredHistory}
          columns={historyColumns}
        />
      </div>
    </PageShell>
  );
}
