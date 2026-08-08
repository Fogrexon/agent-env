import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
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
import {
  getControlSettings,
  listAgents,
  listAudit,
  listWebhookTokens,
} from '../api/client.js';
import type { AgentListItem, WebhookTokenItem } from '../api/types.js';
import { PageShell } from '../ui/PageShell.js';

type AuditRow = {
  id: string;
  action: string;
  detailJson: string;
  createdAt: string;
};

export function SettingsPage() {
  const [settings, setSettings] = useState<{
    maxSlots: number;
    running: number;
    queueDepth: number;
    authEnabled: boolean;
    dbPath: string;
  } | null>(null);
  const [tokens, setTokens] = useState<WebhookTokenItem[]>([]);
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [createdRaw, setCreatedRaw] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: '',
    agentId: '',
    message: '',
    autoApprove: true,
  });

  const refresh = async () => {
    try {
      const [s, t, a, au] = await Promise.all([
        getControlSettings(),
        listWebhookTokens(),
        listAgents(),
        listAudit(40),
      ]);
      setSettings(s);
      setTokens(t);
      setAgents(a);
      setAudit(au);
      if (!form.agentId && a[0]) {
        setForm((f) => ({ ...f, agentId: a[0]!.id }));
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const onCreateToken = async () => {
    setCreatedRaw(null);
    try {
      const res = await fetch('/api/hooks/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name || `${form.agentId}-hook`,
          agentId: form.agentId,
          values: { message: form.message },
          autoApprove: form.autoApprove,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        rawToken?: string;
        hookPath?: string;
      };
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setCreatedRaw(
        data.hookPath
          ? `${window.location.origin.replace(':5173', ':8799')}${data.hookPath}`
          : (data.rawToken ?? null),
      );
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleToken = async (id: string, enabled: boolean) => {
    await fetch(`/api/hooks/tokens/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    void refresh();
  };

  const deleteToken = async (id: string) => {
    if (!window.confirm('Delete this webhook token?')) return;
    await fetch(`/api/hooks/tokens/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    void refresh();
  };

  const tokenColumns: ColumnsType<WebhookTokenItem> = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name: string, row) => (
        <Space>
          {name}
          {!row.enabled ? (
            <Typography.Text type="secondary">off</Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: 'Agent',
      dataIndex: 'agentId',
      render: (id: string) => <Typography.Text code>{id}</Typography.Text>,
    },
    {
      title: 'Prefix',
      dataIndex: 'tokenPrefix',
      render: (p: string) => <Typography.Text code>{p}…</Typography.Text>,
    },
    {
      title: 'Last used',
      dataIndex: 'lastUsedAt',
      render: (t?: string) => (t ? new Date(t).toLocaleString() : '—'),
    },
    {
      title: 'Enabled',
      width: 90,
      render: (_, row) => (
        <Switch
          size="small"
          checked={row.enabled}
          onChange={(v) => void toggleToken(row.id, v)}
        />
      ),
    },
    {
      title: '',
      width: 90,
      render: (_, row) => (
        <Button danger size="small" onClick={() => void deleteToken(row.id)}>
          Delete
        </Button>
      ),
    },
  ];

  const auditColumns: ColumnsType<AuditRow> = [
    {
      title: 'When',
      dataIndex: 'createdAt',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: 'Action',
      dataIndex: 'action',
      width: 160,
      render: (a: string) => <Typography.Text strong>{a}</Typography.Text>,
    },
    {
      title: 'Detail',
      dataIndex: 'detailJson',
      ellipsis: true,
    },
  ];

  return (
    <PageShell
      title="Settings"
      subtitle="Slots, auth, webhooks, audit"
      crumbs={[{ title: 'Settings' }]}
    >
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      ) : null}

      <div className="ops-panel">
        <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
          Control plane
        </Typography.Text>
        {settings ? (
          <Descriptions size="small" bordered column={1}>
            <Descriptions.Item label="maxSlots">
              <Typography.Text strong>{settings.maxSlots}</Typography.Text>{' '}
              <Typography.Text type="secondary">
                (env ADMIN_MAX_SLOTS)
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="running / queue">
              {settings.running} / {settings.queueDepth}
            </Descriptions.Item>
            <Descriptions.Item label="auth">
              <Typography.Text strong>
                {settings.authEnabled ? 'Basic enabled' : 'disabled'}
              </Typography.Text>{' '}
              <Typography.Text type="secondary">
                (ADMIN_BASIC_USER / ADMIN_BASIC_PASSWORD)
              </Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="db">
              <Typography.Text code>{settings.dbPath}</Typography.Text>
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">Loading…</Typography.Text>
        )}
      </div>

      <div className="ops-panel" style={{ marginTop: 16 }}>
        <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
          Webhook tokens
        </Typography.Text>
        <Form layout="vertical" style={{ maxWidth: 720, marginBottom: 16 }}>
          <Space wrap size="middle" align="start">
            <Form.Item label="Name" style={{ marginBottom: 12 }}>
              <Input
                value={form.name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name: e.target.value }))
                }
                style={{ minWidth: 180 }}
              />
            </Form.Item>
            <Form.Item label="Agent" style={{ marginBottom: 12 }}>
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
          </Space>
          <Form.Item label="Default message">
            <Input
              value={form.message}
              onChange={(e) =>
                setForm((f) => ({ ...f, message: e.target.value }))
              }
            />
          </Form.Item>
          <Checkbox
            checked={form.autoApprove}
            onChange={(e) =>
              setForm((f) => ({ ...f, autoApprove: e.target.checked }))
            }
            style={{ marginBottom: 12 }}
          >
            T2 auto-approve
          </Checkbox>
          <div>
            <Button type="primary" onClick={() => void onCreateToken()}>
              Issue token
            </Button>
          </div>
        </Form>
        {createdRaw ? (
          <Alert
            type="success"
            showIcon
            style={{ marginBottom: 12 }}
            message="POST once (save now)"
            description={<Typography.Text code>{createdRaw}</Typography.Text>}
          />
        ) : null}
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={tokens}
          columns={tokenColumns}
        />
      </div>

      <div className="ops-panel" style={{ marginTop: 16 }}>
        <Typography.Text strong style={{ display: 'block', marginBottom: 12 }}>
          Audit log
        </Typography.Text>
        <Table
          size="small"
          rowKey="id"
          pagination={{ pageSize: 20, size: 'small' }}
          dataSource={audit}
          columns={auditColumns}
        />
      </div>
    </PageShell>
  );
}
