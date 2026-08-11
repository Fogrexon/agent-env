import {
  appendFoldedProgressEvent,
  rebuildProgressStreamRows,
  type AgentProgressEvent,
} from '@agent-env/shared';
import type {
  AgentListItem,
  AgentGraphPreview,
  ControlStats,
  ParamsResponse,
  ProviderMediaInfo,
  ProviderModelOption,
  QueueJob,
  RunSnapshot,
  RunSummary,
  ScheduleItem,
  WebhookTokenItem,
  RecentInputItem,
  ChatSession,
  ChatSessionSummary,
  ChatSessionTurn,
} from './types.js';

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      res.ok
        ? `Invalid JSON from ${url}`
        : `HTTP ${res.status} from ${url}: ${text.slice(0, 120) || res.statusText}`,
    );
  }
  if (!res.ok) {
    const errMsg =
      data &&
      typeof data === 'object' &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    throw new Error(errMsg);
  }
  return data as T;
}

export function upsertEvent(
  prev: AgentProgressEvent[],
  data: AgentProgressEvent,
): AgentProgressEvent[] {
  const streamRows = rebuildProgressStreamRows(prev);
  return appendFoldedProgressEvent(prev, streamRows, data).events;
}

export async function listAgents(): Promise<AgentListItem[]> {
  const data = await fetchJson<{ agents: AgentListItem[] }>('/api/agents');
  return data.agents;
}

export async function listProviders(): Promise<ProviderMediaInfo[]> {
  const data = await fetchJson<{ providers?: ProviderMediaInfo[] }>(
    '/api/providers',
  );
  return data.providers ?? [];
}

export async function listProviderModels(
  providers?: readonly string[],
): Promise<ProviderModelOption[]> {
  const qs =
    providers?.length && providers.some(Boolean)
      ? `?providers=${encodeURIComponent(providers.filter(Boolean).join(','))}`
      : '';
  const data = await fetchJson<{ models?: ProviderModelOption[] }>(
    `/api/providers/models${qs}`,
  );
  return data.models ?? [];
}

export async function getAgentParams(id: string): Promise<ParamsResponse> {
  return fetchJson<ParamsResponse>(`/api/agents/${encodeURIComponent(id)}/params`);
}

export async function listRecentInputs(
  agentId: string,
  limit = 20,
): Promise<RecentInputItem[]> {
  const data = await fetchJson<{ inputs: RecentInputItem[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/recent-inputs?limit=${encodeURIComponent(String(limit))}`,
  );
  return data.inputs;
}

export async function listChatSessions(
  agentId: string,
): Promise<ChatSessionSummary[]> {
  const data = await fetchJson<{ sessions: ChatSessionSummary[] }>(
    `/api/agents/${encodeURIComponent(agentId)}/chat-sessions`,
  );
  return data.sessions;
}

export async function getChatSession(sessionId: string): Promise<ChatSession> {
  const data = await fetchJson<{ session: ChatSession }>(
    `/api/chat-sessions/${encodeURIComponent(sessionId)}`,
  );
  return data.session;
}

export async function saveChatSession(input: {
  sessionId?: string;
  agentId: string;
  title?: string;
  turns: ChatSessionTurn[];
}): Promise<ChatSession> {
  if (input.sessionId) {
    const data = await fetchJson<{ session: ChatSession }>(
      `/api/chat-sessions/${encodeURIComponent(input.sessionId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: input.agentId,
          title: input.title,
          turns: input.turns,
        }),
      },
    );
    return data.session;
  }
  const data = await fetchJson<{ session: ChatSession }>(
    `/api/agents/${encodeURIComponent(input.agentId)}/chat-sessions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        turns: input.turns,
      }),
    },
  );
  return data.session;
}

export async function deleteChatSession(sessionId: string): Promise<void> {
  await fetchJson(`/api/chat-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export async function previewAgentGraph(
  id: string,
  values: Record<string, unknown>,
): Promise<AgentGraphPreview> {
  return fetchJson<AgentGraphPreview>(
    `/api/agents/${encodeURIComponent(id)}/graph`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    },
  );
}

export async function listRuns(): Promise<RunSummary[]> {
  const data = await fetchJson<{ runs: RunSummary[] }>('/api/runs');
  return data.runs;
}

export async function getRun(id: string): Promise<RunSnapshot> {
  return fetchJson<RunSnapshot>(`/api/runs/${encodeURIComponent(id)}`);
}

export async function listQueue(): Promise<{
  jobs: QueueJob[];
  maxSlots: number;
  running: number;
  queueDepth: number;
}> {
  return fetchJson('/api/queue');
}

export async function getControlStats(): Promise<ControlStats> {
  return fetchJson('/api/control/stats');
}

export async function getControlSettings(): Promise<{
  maxSlots: number;
  running: number;
  queueDepth: number;
  authEnabled: boolean;
  dbPath: string;
}> {
  return fetchJson('/api/control/settings');
}

export async function listSchedules(): Promise<ScheduleItem[]> {
  const data = await fetchJson<{ schedules: ScheduleItem[] }>('/api/schedules');
  return data.schedules;
}

export async function listWebhookTokens(): Promise<WebhookTokenItem[]> {
  const data = await fetchJson<{ tokens: WebhookTokenItem[] }>(
    '/api/hooks/tokens',
  );
  return data.tokens;
}

export async function listAudit(limit = 50): Promise<
  Array<{ id: string; action: string; detailJson: string; createdAt: string }>
> {
  const data = await fetchJson<{
    entries: Array<{
      id: string;
      action: string;
      detailJson: string;
      createdAt: string;
    }>;
  }>(`/api/control/audit?limit=${limit}`);
  return data.entries;
}
