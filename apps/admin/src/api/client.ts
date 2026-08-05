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
  QueueJob,
  RunSnapshot,
  RunSummary,
  ScheduleItem,
  WebhookTokenItem,
} from './types.js';

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json()) as T & { error?: string; ok?: boolean };
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `HTTP ${res.status}`,
    );
  }
  return data;
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

export async function getAgentParams(id: string): Promise<ParamsResponse> {
  return fetchJson<ParamsResponse>(`/api/agents/${encodeURIComponent(id)}/params`);
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
