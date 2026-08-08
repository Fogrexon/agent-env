import {
  MessageOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Input,
  Segmented,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listAgents } from '../api/client.js';
import type { AgentListItem } from '../api/types.js';
import { PageShell } from '../ui/PageShell.js';

type ModeFilter = 'all' | 'interactive' | 'autonomous';

function modeOf(agent: AgentListItem): 'interactive' | 'autonomous' {
  return agent.mode ?? 'autonomous';
}

export function CatalogPage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');

  const refresh = async () => {
    setLoading(true);
    try {
      const list = await listAgents();
      setAgents(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      const mode = modeOf(a);
      if (modeFilter !== 'all' && mode !== modeFilter) return false;
      if (!q) return true;
      const hay = `${a.id} ${a.title ?? ''} ${a.name} ${a.description}`.toLowerCase();
      return hay.includes(q);
    });
  }, [agents, query, modeFilter]);

  const columns: ColumnsType<AgentListItem> = [
    {
      title: 'Agent',
      key: 'agent',
      render: (_, row) => (
        <Space direction="vertical" size={0}>
          <Typography.Text code>{row.id}</Typography.Text>
          <Typography.Text strong>{row.title ?? row.name}</Typography.Text>
        </Space>
      ),
    },
    {
      title: 'Mode',
      key: 'mode',
      width: 130,
      render: (_, row) => {
        const mode = modeOf(row);
        return (
          <Tag color={mode === 'interactive' ? 'blue' : 'purple'}>{mode}</Tag>
        );
      },
    },
    {
      title: 'Description',
      dataIndex: 'description',
      ellipsis: true,
      render: (text: string) => (
        <Typography.Text type="secondary">{text || '—'}</Typography.Text>
      ),
    },
    {
      title: 'Fields',
      dataIndex: 'fieldCount',
      width: 80,
      render: (n?: number) => n ?? '—',
    },
    {
      title: 'Open',
      key: 'actions',
      width: 220,
      render: (_, row) => {
        const mode = modeOf(row);
        if (mode === 'interactive') {
          return (
            <Button
              type="primary"
              size="small"
              icon={<MessageOutlined />}
              onClick={() => navigate(`/chat/${row.id}`)}
            >
              Open in Chat
            </Button>
          );
        }
        return (
          <Button
            type="primary"
            size="small"
            icon={<PlayCircleOutlined />}
            onClick={() => navigate(`/jobs/${row.id}`)}
          >
            Run as Job
          </Button>
        );
      },
    },
  ];

  return (
    <PageShell
      title="Catalog"
      subtitle="Discovered workflow definitions — open interactive agents in Chat, autonomous ones as Jobs."
      crumbs={[{ title: 'Catalog', path: '/catalog' }]}
      extra={
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void refresh()}
          loading={loading}
        >
          Refresh
        </Button>
      }
    >
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      ) : null}

      <Space wrap style={{ marginBottom: 16 }} size="middle">
        <Input.Search
          allowClear
          placeholder="Filter by id / title / description"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 320 }}
        />
        <Segmented
          value={modeFilter}
          onChange={(v) => setModeFilter(v as ModeFilter)}
          options={[
            { label: 'All', value: 'all' },
            { label: 'Interactive', value: 'interactive' },
            { label: 'Autonomous', value: 'autonomous' },
          ]}
        />
        <Typography.Text type="secondary">
          {filtered.length} / {agents.length}
        </Typography.Text>
      </Space>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={filtered}
        pagination={{ pageSize: 20, showSizeChanger: true }}
        locale={{
          emptyText: (
            <Typography.Text type="secondary">
              No agents. Add packs under{' '}
              <Typography.Text code>plugins/</Typography.Text> or builtin{' '}
              <Typography.Text code>agents/</Typography.Text>. See{' '}
              <Link to="/chat">Chat</Link> / <Link to="/jobs">Jobs</Link>.
            </Typography.Text>
          ),
        }}
      />
    </PageShell>
  );
}
