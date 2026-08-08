import {
  Alert,
  Button,
  Checkbox,
  Flex,
  InputNumber,
  Layout,
  List,
  Space,
  Spin,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getAgentParams,
  listAgents,
  listProviders,
  previewAgentGraph,
} from '../api/client.js';
import {
  previewMessage,
  type AgentGraphPreview,
  type AgentListItem,
  type ParamsResponse,
  type ProviderMediaInfo,
} from '../api/types.js';
import { AgentGraphPanel } from '../components/AgentGraphPanel.js';
import { ParamForm } from '../components/ParamForm.js';
import { PageShell } from '../ui/PageShell.js';

const { Sider, Content } = Layout;

function autonomousAgents(agents: AgentListItem[]): AgentListItem[] {
  return agents.filter((a) => (a.mode ?? 'autonomous') === 'autonomous');
}

export function JobsPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [providers, setProviders] = useState<ProviderMediaInfo[]>([]);
  const [params, setParams] = useState<ParamsResponse | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [autoApprove, setAutoApprove] = useState(true);
  const [priority, setPriority] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [graphPreview, setGraphPreview] = useState<AgentGraphPreview | null>(
    null,
  );
  const [graphLoading, setGraphLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const jobAgents = useMemo(() => autonomousAgents(agents), [agents]);
  const selectedId =
    agentId && jobAgents.some((a) => a.id === agentId)
      ? agentId
      : jobAgents[0]?.id;

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [a, p] = await Promise.all([listAgents(), listProviders()]);
        setAgents(a);
        setProviders(p);
        const jobs = autonomousAgents(a);
        if (!agentId && jobs[0]) {
          navigate(`/jobs/${jobs[0].id}`, { replace: true });
        } else if (agentId && !jobs.some((j) => j.id === agentId) && jobs[0]) {
          navigate(`/jobs/${jobs[0].id}`, { replace: true });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [agentId, navigate]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await getAgentParams(selectedId);
        if (cancelled) return;
        setParams(data);
        setValues(data.defaults);
        setGraphPreview(null);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setParams(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const onFieldChange = useCallback((id: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [id]: value }));
  }, []);

  const onPreviewGraph = async () => {
    if (!selectedId) return;
    setGraphLoading(true);
    setError(null);
    try {
      const data = await previewAgentGraph(selectedId, values);
      setGraphPreview(data);
    } catch (err) {
      setGraphPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGraphLoading(false);
    }
  };

  const onBuild = async () => {
    if (!selectedId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${selectedId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values, autoApprove, priority }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        runId?: string;
        error?: string;
        issues?: string[];
      };
      if (!res.ok || !data.ok || !data.runId) {
        setError(
          [data.error, ...(data.issues ?? [])].filter(Boolean).join('\n') ||
            `HTTP ${res.status}`,
        );
        return;
      }
      navigate(`/runs/${data.runId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    params?.spec.title ??
    jobAgents.find((a) => a.id === selectedId)?.title ??
    selectedId ??
    'Job';

  return (
    <PageShell
      title="Jobs"
      subtitle="Autonomous agents — one-shot / batch enqueue into the control queue."
      crumbs={[{ title: 'Catalog', path: '/catalog' }, { title: 'Jobs' }, { title: 'Run' }]}
    >
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      ) : null}

      <Layout className="ops-jobs-layout">
        <Sider width={260} theme="light" className="ops-jobs-sider">
          <Typography.Text
            strong
            type="secondary"
            style={{ display: 'block', marginBottom: 8, fontSize: 12 }}
          >
            AUTONOMOUS
          </Typography.Text>
          {loading ? (
            <Spin size="small" />
          ) : jobAgents.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              No autonomous agents. Interactive ones live under Chat.
            </Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={jobAgents}
              renderItem={(agent) => (
                <List.Item
                  className={
                    agent.id === selectedId
                      ? 'ops-job-item is-active'
                      : 'ops-job-item'
                  }
                  onClick={() => navigate(`/jobs/${agent.id}`)}
                >
                  <List.Item.Meta
                    title={
                      <Typography.Text code>
                        {agent.title ?? agent.id}
                      </Typography.Text>
                    }
                    description={
                      <Typography.Paragraph
                        ellipsis={{ rows: 2 }}
                        type="secondary"
                        style={{ marginBottom: 0, fontSize: 12 }}
                      >
                        {agent.description}
                      </Typography.Paragraph>
                    }
                  />
                </List.Item>
              )}
            />
          )}
          {providers.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <Typography.Text
                strong
                type="secondary"
                style={{ display: 'block', marginBottom: 8, fontSize: 12 }}
              >
                PROVIDERS
              </Typography.Text>
              <List
                size="small"
                dataSource={providers}
                renderItem={(p) => (
                  <List.Item style={{ padding: '4px 0' }}>
                    <Typography.Text code>
                      {p.id}
                      {p.configured ? '' : ' (off)'}
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {p.categories.join(' / ') || 'text'}
                    </Typography.Text>
                  </List.Item>
                )}
              />
            </div>
          ) : null}
        </Sider>

        <Content className="ops-jobs-content">
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            {title}
          </Typography.Title>
          {!params ? (
            <Typography.Text type="secondary">Select a job</Typography.Text>
          ) : (
            <>
              <ParamForm
                fields={params.spec.fields}
                values={values}
                onChange={onFieldChange}
              />
              <Flex gap={16} wrap="wrap" align="center" style={{ marginTop: 12 }}>
                <Checkbox
                  checked={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.checked)}
                >
                  Auto-approve T2
                </Checkbox>
                <Space>
                  <Typography.Text type="secondary">Priority</Typography.Text>
                  <InputNumber
                    size="small"
                    value={priority}
                    onChange={(v) => setPriority(Number(v) || 0)}
                  />
                </Space>
              </Flex>
              <Space wrap style={{ marginTop: 16 }}>
                <Button
                  type="primary"
                  loading={submitting}
                  onClick={() => void onBuild()}
                >
                  Build
                </Button>
                <Button
                  loading={graphLoading}
                  onClick={() => void onPreviewGraph()}
                >
                  {graphPreview ? 'Refresh graph' : 'Show graph'}
                </Button>
                <Link to="/queue">View queue</Link>
              </Space>
              <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                preview:{' '}
                {previewMessage(values[params.spec.objectiveField]) ?? '—'}
              </Typography.Paragraph>
              {graphPreview ? (
                <div className="ops-panel" style={{ marginTop: 8 }}>
                  <Typography.Text strong>Graph</Typography.Text>
                  <div style={{ marginTop: 8 }}>
                    <AgentGraphPanel graph={graphPreview.graph} />
                  </div>
                </div>
              ) : null}
            </>
          )}
        </Content>
      </Layout>
    </PageShell>
  );
}
