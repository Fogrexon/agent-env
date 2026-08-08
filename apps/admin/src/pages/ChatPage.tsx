import { MessageOutlined, SendOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Flex,
  Input,
  Layout,
  List,
  Space,
  Spin,
  Typography,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { getAgentParams, getRun, listAgents } from '../api/client.js';
import {
  isTerminalRunStatus,
  type AgentListItem,
  type ParamsResponse,
} from '../api/types.js';
import { MarkdownView } from '../components/MarkdownView.js';
import { PageShell } from '../ui/PageShell.js';

const { Sider, Content } = Layout;
const { TextArea } = Input;

type ChatRole = 'user' | 'assistant' | 'system';

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  runId?: string;
  pending?: boolean;
  error?: string;
}

function interactiveAgents(agents: AgentListItem[]): AgentListItem[] {
  return agents.filter((a) => (a.mode ?? 'autonomous') === 'interactive');
}

function buildTurnMessage(
  history: ChatMessage[],
  userText: string,
  objectiveField: string,
): Record<string, unknown> {
  const prior = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => !m.pending && !m.error)
    .slice(-8)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n\n');
  const composed = prior
    ? `${prior}\n\nUser: ${userText}\n\nAssistant:`
    : userText;
  return { [objectiveField]: composed };
}

async function waitForRun(runId: string): Promise<{
  finalText?: string;
  error?: string;
  status: string;
}> {
  for (;;) {
    const snap = await getRun(runId);
    if (isTerminalRunStatus(snap.status)) {
      return {
        status: snap.status,
        finalText: snap.result?.finalText,
        error: snap.error ?? snap.result?.error,
      };
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

export function ChatPage() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  const [params, setParams] = useState<ParamsResponse | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const chatAgents = useMemo(() => interactiveAgents(agents), [agents]);
  const selectedId = agentId ?? chatAgents[0]?.id;

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const a = await listAgents();
        setAgents(a);
        const interactive = interactiveAgents(a);
        if (!agentId && interactive[0]) {
          navigate(`/chat/${interactive[0].id}`, { replace: true });
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
        setMessages([]);
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

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const onSend = async () => {
    const text = draft.trim();
    if (!selectedId || !params || !text || sending) return;
    setSending(true);
    setError(null);
    setDraft('');

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
    };
    const pendingId = `a-${Date.now()}`;
    const pending: ChatMessage = {
      id: pendingId,
      role: 'assistant',
      text: '…',
      pending: true,
    };
    const nextHistory = [...messages, userMsg];
    setMessages([...nextHistory, pending]);

    try {
      const values = {
        ...params.defaults,
        ...buildTurnMessage(nextHistory, text, params.spec.objectiveField),
      };
      const res = await fetch(`/api/agents/${selectedId}/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values, autoApprove: false, priority: 0 }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        runId?: string;
        error?: string;
        issues?: string[];
      };
      if (!res.ok || !data.ok || !data.runId) {
        const msg =
          [data.error, ...(data.issues ?? [])].filter(Boolean).join('\n') ||
          `HTTP ${res.status}`;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === pendingId
              ? { ...m, pending: false, error: msg, text: msg }
              : m,
          ),
        );
        return;
      }

      const runId = data.runId;
      setMessages((prev) =>
        prev.map((m) => (m.id === pendingId ? { ...m, runId } : m)),
      );

      const result = await waitForRun(runId);
      const reply =
        result.finalText?.trim() ||
        result.error ||
        `(run ${result.status})`;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                ...m,
                pending: false,
                runId,
                text: reply,
                error: result.error,
              }
            : m,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? { ...m, pending: false, error: msg, text: msg }
            : m,
        ),
      );
    } finally {
      setSending(false);
    }
  };

  const title =
    params?.spec.title ??
    chatAgents.find((a) => a.id === selectedId)?.title ??
    selectedId ??
    'Chat';

  return (
    <PageShell
      title="Chat"
      subtitle="Interactive agents — converse while tools and subagents bound purpose and permissions."
      crumbs={[{ title: 'Catalog', path: '/catalog' }, { title: 'Chat' }]}
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
            INTERACTIVE
          </Typography.Text>
          {loading ? (
            <Spin size="small" />
          ) : chatAgents.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              No interactive agents. Set{' '}
              <Typography.Text code>mode: &apos;interactive&apos;</Typography.Text>{' '}
              on agentDefinition.
            </Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={chatAgents}
              renderItem={(agent) => (
                <List.Item
                  className={
                    agent.id === selectedId
                      ? 'ops-job-item is-active'
                      : 'ops-job-item'
                  }
                  onClick={() => {
                    navigate(`/chat/${agent.id}`);
                    setMessages([]);
                  }}
                >
                  <List.Item.Meta
                    avatar={<MessageOutlined />}
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
        </Sider>

        <Content className="ops-jobs-content ops-chat-content">
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            {title}
          </Typography.Title>
          <div className="ops-chat-thread">
            {messages.length === 0 ? (
              <Typography.Text type="secondary">
                Send a message to start. Each turn runs the agent; recent
                history is included in the next objective.
              </Typography.Text>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`ops-chat-bubble is-${m.role}${m.error ? ' is-error' : ''}`}
                >
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 11, display: 'block', marginBottom: 4 }}
                  >
                    {m.role}
                    {m.runId ? (
                      <>
                        {' · '}
                        <Link to={`/runs/${m.runId}`}>{m.runId.slice(0, 8)}</Link>
                      </>
                    ) : null}
                    {m.pending ? ' · running…' : null}
                  </Typography.Text>
                  {m.role === 'assistant' && !m.pending && !m.error ? (
                    <MarkdownView content={m.text} />
                  ) : (
                    <Typography.Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                      {m.text}
                    </Typography.Paragraph>
                  )}
                </div>
              ))
            )}
            <div ref={bottomRef} />
          </div>
          <Flex gap={8} align="flex-end" className="ops-chat-composer">
            <TextArea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Message…"
              autoSize={{ minRows: 2, maxRows: 6 }}
              disabled={!params || sending}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={sending}
              disabled={!params || !draft.trim()}
              onClick={() => void onSend()}
            >
              Send
            </Button>
          </Flex>
          <Space style={{ marginTop: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              T2/T3 approvals open on the run page when requested.
            </Typography.Text>
          </Space>
        </Content>
      </Layout>
    </PageShell>
  );
}
