import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  Select,
  Space,
  Switch,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listAgents, listSchedules } from '../api/client.js';
import type { AgentListItem, ScheduleItem } from '../api/types.js';
import { PageShell } from '../ui/PageShell.js';

export function SchedulesPage() {
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    agentId: '',
    cron: '0 * * * *',
    message: '',
    autoApprove: true,
    enabled: true,
  });

  const refresh = async () => {
    try {
      const [s, a] = await Promise.all([listSchedules(), listAgents()]);
      const autonomous = a.filter(
        (x) => (x.mode ?? 'autonomous') === 'autonomous',
      );
      setSchedules(s);
      setAgents(autonomous);
      if (!form.agentId && autonomous[0]) {
        setForm((f) => ({ ...f, agentId: autonomous[0]!.id }));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreate = async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: form.agentId,
          cron: form.cron,
          values: { message: form.message },
          autoApprove: form.autoApprove,
          enabled: form.enabled,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const toggle = async (id: string, enabled: boolean) => {
    await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    void refresh();
  };

  const onDelete = async (id: string) => {
    if (!window.confirm('Delete this schedule?')) return;
    await fetch(`/api/schedules/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    void refresh();
  };

  const columns: ColumnsType<ScheduleItem> = [
    {
      title: 'Agent',
      dataIndex: 'agentId',
      render: (id: string, row) => (
        <Space>
          <Link to={`/jobs/${id}`}>
            <Typography.Text code>{id}</Typography.Text>
          </Link>
          {!row.enabled ? <Typography.Text type="secondary">off</Typography.Text> : null}
        </Space>
      ),
    },
    {
      title: 'Cron',
      dataIndex: 'cron',
      render: (c: string) => <Typography.Text code>{c}</Typography.Text>,
    },
    {
      title: 'Next',
      dataIndex: 'nextRunAt',
      render: (t?: string) => (t ? new Date(t).toLocaleString() : '—'),
    },
    {
      title: 'Last job',
      dataIndex: 'lastJobId',
      render: (id?: string) =>
        id ? <Typography.Text code>{id.slice(0, 8)}</Typography.Text> : '—',
    },
    {
      title: 'Enabled',
      dataIndex: 'enabled',
      width: 90,
      render: (enabled: boolean, row) => (
        <Switch
          size="small"
          checked={enabled}
          onChange={(v) => void toggle(row.id, v)}
        />
      ),
    },
    {
      title: '',
      width: 90,
      render: (_, row) => (
        <Button danger size="small" onClick={() => void onDelete(row.id)}>
          Delete
        </Button>
      ),
    },
  ];

  return (
    <PageShell
      title="Schedules"
      subtitle="Enqueue jobs on a cron expression"
      crumbs={[{ title: 'Jobs', path: '/jobs' }, { title: 'Schedules' }]}
    >
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      ) : null}

      <div className="ops-panel">
        <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
          New schedule
        </Typography.Text>
        <Form layout="vertical" style={{ maxWidth: 720 }}>
          <Space wrap size="middle" style={{ width: '100%' }} align="start">
            <Form.Item label="Agent" style={{ minWidth: 200, marginBottom: 12 }}>
              <Select
                value={form.agentId || undefined}
                onChange={(v) => setForm((f) => ({ ...f, agentId: v }))}
                options={agents.map((a) => ({
                  value: a.id,
                  label: a.title ?? a.id,
                }))}
                style={{ minWidth: 200 }}
              />
            </Form.Item>
            <Form.Item label="Cron" style={{ minWidth: 160, marginBottom: 12 }}>
              <Input
                value={form.cron}
                onChange={(e) =>
                  setForm((f) => ({ ...f, cron: e.target.value }))
                }
                placeholder="0 * * * *"
              />
            </Form.Item>
          </Space>
          <Form.Item label="Message (objective)">
            <Input
              value={form.message}
              onChange={(e) =>
                setForm((f) => ({ ...f, message: e.target.value }))
              }
            />
          </Form.Item>
          <Space wrap style={{ marginBottom: 12 }}>
            <Checkbox
              checked={form.autoApprove}
              onChange={(e) =>
                setForm((f) => ({ ...f, autoApprove: e.target.checked }))
              }
            >
              T2 auto-approve
            </Checkbox>
            <Checkbox
              checked={form.enabled}
              onChange={(e) =>
                setForm((f) => ({ ...f, enabled: e.target.checked }))
              }
            >
              Enabled
            </Checkbox>
          </Space>
          <div>
            <Button
              type="primary"
              loading={submitting}
              onClick={() => void onCreate()}
            >
              Create
            </Button>
          </div>
        </Form>
      </div>

      <div className="ops-panel" style={{ marginTop: 16 }}>
        <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
          Configured
        </Typography.Text>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          locale={{ emptyText: 'No schedules' }}
          dataSource={schedules}
          columns={columns}
        />
      </div>
    </PageShell>
  );
}
