import type { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';
import type { HttpFetch } from './http.js';

export interface AdminControlBasicAuth {
  user: string;
  password: string;
}

export interface CreateAdminControlToolsOptions {
  /** Admin API origin, for example `http://127.0.0.1:8787`. */
  baseUrl: string | (() => string);
  /** Optional Basic Auth injected by the execution host. */
  basicAuth?: () => AdminControlBasicAuth | undefined;
  /** Fail-closed switch for schedule / webhook mutations. */
  mutationsEnabled?: () => boolean;
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
}

export interface AdminControlTools {
  listAgents: FunctionTool;
  getAgentParams: FunctionTool;
  previewAgentGraph: FunctionTool;
  getControlSettings: FunctionTool;
  listSchedules: FunctionTool;
  createSchedule: FunctionTool;
  updateSchedule: FunctionTool;
  deleteSchedule: FunctionTool;
  listWebhookTokens: FunctionTool;
  createWebhookToken: FunctionTool;
  setWebhookEnabled: FunctionTool;
  deleteWebhookToken: FunctionTool;
}

const valuesSchema = z.record(z.string(), z.unknown());

function trimOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Tools for the local agent-env admin control plane.
 *
 * The factory owns reusable HTTP/API behavior; callers only inject the origin,
 * credentials, and mutation policy. It never reads process.env.
 */
export function createAdminControlTools(
  options: CreateAdminControlToolsOptions,
): AdminControlTools {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const request = async (
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> => {
    const origin = trimOrigin(
      typeof options.baseUrl === 'function'
        ? options.baseUrl()
        : options.baseUrl,
    );
    if (!origin) throw new Error('Admin control baseUrl is empty');

    const auth = options.basicAuth?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        ...init,
        headers: {
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(auth
            ? {
                Authorization: `Basic ${Buffer.from(
                  `${auth.user}:${auth.password}`,
                  'utf8',
                ).toString('base64')}`,
              }
            : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      const text = await response.text();
      let data: unknown = {};
      if (text.trim()) {
        try {
          data = JSON.parse(text) as unknown;
        } catch {
          data = { message: text.slice(0, 2_000) };
        }
      }
      if (!response.ok) {
        const detail =
          data && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : text.slice(0, 500);
        throw new Error(
          `Admin API ${init.method ?? 'GET'} ${path} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  };

  const assertMutationsEnabled = (): void => {
    if (!options.mutationsEnabled?.()) {
      throw new Error(
        'Admin control mutations are disabled by the agent configuration',
      );
    }
  };

  const readContract = (name: string) => ({
    name,
    version: '1.0',
    riskClass: 'T0' as const,
    sideEffect: 'none' as const,
    idempotency: 'supported' as const,
    timeoutMs,
  });
  const writeContract = (
    name: string,
    sideEffect: 'reversible' | 'irreversible' = 'reversible',
  ) => ({
    name,
    version: '1.0',
    riskClass: 'T2' as const,
    sideEffect,
    idempotency: 'none' as const,
    timeoutMs,
  });

  const listAgents = createGuardedTool({
    contract: readContract('admin_list_agents'),
    description:
      'List agent definitions currently discovered by the admin host.',
    parameters: z.object({}),
    publicConfig: {
      baseUrl:
        typeof options.baseUrl === 'string'
          ? trimOrigin(options.baseUrl)
          : '(dynamic)',
    },
    execute: () => request('/api/agents'),
  });

  const getAgentParams = createGuardedTool({
    contract: readContract('admin_get_agent_params'),
    description:
      'Read an agent params schema and defaults before configuring schedule or webhook values.',
    parameters: z.object({
      agentId: z.string().min(1).describe('Discovered agent id'),
    }),
    execute: ({ agentId }) =>
      request(`/api/agents/${encodeURIComponent(agentId)}/params`),
  });

  const previewAgentGraph = createGuardedTool({
    contract: readContract('admin_preview_agent_graph'),
    description:
      'Build and inspect an agent graph with validated params without starting an agent run.',
    parameters: z.object({
      agentId: z.string().min(1).describe('Discovered agent id'),
      values: valuesSchema
        .optional()
        .describe('Values matching the target agent params schema'),
    }),
    execute: ({ agentId, values }) =>
      request(`/api/agents/${encodeURIComponent(agentId)}/graph`, {
        method: 'POST',
        body: JSON.stringify({ values: values ?? {} }),
      }),
  });

  const getControlSettings = createGuardedTool({
    contract: readContract('admin_get_control_settings'),
    description:
      'Read admin control-plane settings such as max slots, queue depth, and auth state.',
    parameters: z.object({}),
    execute: () => request('/api/control/settings'),
  });

  const listSchedules = createGuardedTool({
    contract: readContract('admin_list_schedules'),
    description:
      'List cron schedules, including ids, expressions, values, enabled state, and next run time.',
    parameters: z.object({}),
    execute: () => request('/api/schedules'),
  });

  const createSchedule = createGuardedTool({
    contract: writeContract('admin_create_schedule'),
    description:
      'Create an admin cron schedule for a discovered agent. Requires mutation permission.',
    parameters: z.object({
      agentId: z.string().min(1),
      cron: z.string().min(1).describe('Croner-compatible cron expression'),
      values: valuesSchema
        .optional()
        .describe('Values matching the target agent params schema'),
      enabled: z.boolean().optional(),
    }),
    execute: async (input) => {
      assertMutationsEnabled();
      return request('/api/schedules', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
  });

  const updateSchedule = createGuardedTool({
    contract: writeContract('admin_update_schedule'),
    description:
      'Update cron, values, or enabled state for an existing schedule.',
    parameters: z.object({
      scheduleId: z.string().min(1),
      cron: z.string().min(1).optional(),
      values: valuesSchema.optional(),
      enabled: z.boolean().optional(),
    }),
    execute: async ({ scheduleId, ...patch }) => {
      assertMutationsEnabled();
      return request(`/api/schedules/${encodeURIComponent(scheduleId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },
  });

  const deleteSchedule = createGuardedTool({
    contract: writeContract('admin_delete_schedule', 'irreversible'),
    description: 'Delete an admin cron schedule by id.',
    parameters: z.object({ scheduleId: z.string().min(1) }),
    execute: async ({ scheduleId }) => {
      assertMutationsEnabled();
      return request(`/api/schedules/${encodeURIComponent(scheduleId)}`, {
        method: 'DELETE',
      });
    },
  });

  const listWebhookTokens = createGuardedTool({
    contract: readContract('admin_list_webhook_tokens'),
    description:
      'List webhook trigger configurations. Secret token values are never returned.',
    parameters: z.object({}),
    execute: () => request('/api/hooks/tokens'),
  });

  const createWebhookToken = createGuardedTool({
    contract: writeContract('admin_create_webhook_token'),
    description:
      'Create a webhook trigger for an agent. The raw token is returned once and must be stored securely.',
    parameters: z.object({
      name: z.string().min(1),
      agentId: z.string().min(1),
      values: valuesSchema.optional(),
    }),
    execute: async (input) => {
      assertMutationsEnabled();
      return request('/api/hooks/tokens', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
  });

  const setWebhookEnabled = createGuardedTool({
    contract: writeContract('admin_set_webhook_enabled'),
    description: 'Enable or disable an existing webhook trigger.',
    parameters: z.object({
      tokenId: z.string().min(1),
      enabled: z.boolean(),
    }),
    execute: async ({ tokenId, enabled }) => {
      assertMutationsEnabled();
      return request(`/api/hooks/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      });
    },
  });

  const deleteWebhookToken = createGuardedTool({
    contract: writeContract('admin_delete_webhook_token', 'irreversible'),
    description: 'Delete an existing webhook trigger token configuration.',
    parameters: z.object({ tokenId: z.string().min(1) }),
    execute: async ({ tokenId }) => {
      assertMutationsEnabled();
      return request(`/api/hooks/tokens/${encodeURIComponent(tokenId)}`, {
        method: 'DELETE',
      });
    },
  });

  return {
    listAgents,
    getAgentParams,
    previewAgentGraph,
    getControlSettings,
    listSchedules,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    listWebhookTokens,
    createWebhookToken,
    setWebhookEnabled,
    deleteWebhookToken,
  };
}
