import type {

  AgentGraph,

  AgentManifest,

  AgentParamsSpec,

  AgentProgressEvent,

  ObservedAgentGraph,

} from '@agent-env/shared';



export interface AgentListItem {

  id: string;

  name: string;

  description: string;

  title?: string;

  runMode?: string;

  fieldCount?: number;

  paramsFile?: string;

  models?: AgentManifest['models'];

}



export interface ProviderMediaInfo {

  id: string;

  kind?: string;

  configured: boolean;

  categories: string[];

  mimeTypes: string[];

  maxBytesPerFile?: number;

  notes?: string;

}



export interface ParamsResponse {

  manifest: AgentManifest;

  spec: AgentParamsSpec;

  defaults: Record<string, unknown>;

}



export interface AgentGraphPreview {

  graph: AgentGraph;

}



export interface RunSummary {

  runId: string;

  agentId: string;

  runMode: string;

  status: string;

  createdAt: string;

  updatedAt: string;

  messagePreview?: string;

  error?: string;

  finalTextPreview?: string;

  jobId?: string;

  trigger?: string;

  jobStatus?: string;

}



export interface QueueJob {

  jobId: string;

  runId: string;

  agentId: string;

  status: string;

  trigger: string;

  priority: number;

  messagePreview?: string | null;

  error?: string | null;

  createdAt: string;

  updatedAt: string;

  startedAt?: string | null;

  finishedAt?: string | null;

  autoApprove?: boolean;

}



export interface RunStage {

  state: string;

  phase?: string;

  at: string;

}



export interface RunSnapshot {

  runId: string;

  agentId: string;

  runMode: string;

  status: string;

  messagePreview?: string;

  events: AgentProgressEvent[];

  result?: {

    status: string;

    finalText?: string;

    sessionId?: string;

    agentName?: string;

    error?: string;

    recordState?: string;

    verificationPassed?: boolean;

  };

  error?: string;

  createdAt?: string;

  updatedAt?: string;

  stages?: RunStage[];

  recordState?: string;

  verificationPassed?: boolean;

  budgetConsumed?: {

    toolCalls: number;

    tokens: number;

    wallSeconds: number;

    costUsd: number;

  };

  verification?: {

    passed: boolean;

    graderVersion: string;

    checks: Array<{

      criterion: string;

      passed: boolean;

      detail?: string;

    }>;

  };

  jobId?: string;

  trigger?: string;

  jobStatus?: string;

  pendingApprovals?: Array<{

    approvalId: string;

    tool: string;

    riskClass: string;

    sideEffect?: string;

    input: Record<string, unknown>;

    createdAt: string;

  }>;

  fromDisk?: boolean;

  historyDir?: string;

  effectiveGraph?: AgentGraph;

  observedGraph?: ObservedAgentGraph;

  intent?: unknown;

}



export interface ControlStats {

  maxSlots: number;

  running: number;

  queueDepth: number;

  pending: number;

  claimed: number;

  runningJobs: number;

  triggers24h?: Record<string, number>;

  failureRate?: { total: number; failed: number; rate: number };

}



export interface ScheduleItem {

  id: string;

  agentId: string;

  cron: string;

  values: Record<string, unknown>;

  autoApprove: boolean;

  enabled: boolean;

  nextRunAt: string | null;

  lastJobId: string | null;

  createdAt: string;

  updatedAt: string;

}



export interface WebhookTokenItem {

  id: string;

  name: string;

  agentId: string;

  values: Record<string, unknown>;

  autoApprove: boolean;

  tokenPrefix: string;

  enabled: boolean;

  createdAt: string;

  lastUsedAt: string | null;

}



export function previewMessage(text: unknown, max = 120): string | undefined {

  if (typeof text !== 'string') return undefined;

  const compact = text.replace(/\s+/g, ' ').trim();

  if (!compact) return undefined;

  if (compact.length <= max) return compact;

  return `${compact.slice(0, max - 1)}…`;

}



export function isTerminalRunStatus(status: string): boolean {

  return (

    status === 'completed' || status === 'failed' || status === 'cancelled'

  );

}



export function statusBadgeClass(status: string): string {

  return `badge badge-${status}`;

}



/** Map run-record state to a short verification label. */

export function verificationLabel(recordState: string | undefined): string | null {

  if (recordState === 'SUCCEEDED') return 'Verified';

  if (recordState === 'COMPLETED') return 'Unverified';

  return null;

}

