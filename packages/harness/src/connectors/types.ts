import type { FunctionTool } from '@google/adk';
import type {
  DataSourceConnectorMeta,
  DataSourceKind,
  EvidenceBundle,
  EvidenceItem,
  ToolContractInput,
} from '@agent-env/shared';
import { dataSourceConnectorSchema } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';

export const searchParamsSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Search / lookup query against this data source'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('Max evidence items to return'),
});

export type ConnectorSearchInput = z.infer<typeof searchParamsSchema>;

export interface DataSourceConnector {
  readonly meta: DataSourceConnectorMeta;
  /** ADK tool bound to this connector (read path). */
  createTool(): FunctionTool;
  /** Direct search for tests / non-LLM callers. */
  search(input: ConnectorSearchInput): Promise<EvidenceBundle>;
}

export interface CreateSearchConnectorOptions {
  id: string;
  title: string;
  description: string;
  kind: DataSourceKind;
  tags?: string[];
  contract?: Partial<ToolContractInput>;
  /**
   * Non-secret factory knobs shown in live progress when the search tool runs.
   */
  publicConfig?: Record<string, unknown>;
  search: (input: ConnectorSearchInput) => Promise<EvidenceBundle>;
}

/** Shared factory: metadata + guarded search tool around a search() impl. */
export function createSearchConnector(
  options: CreateSearchConnectorOptions,
): DataSourceConnector {
  const toolName = `search_${options.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const meta = dataSourceConnectorSchema.parse({
    id: options.id,
    kind: options.kind,
    title: options.title,
    description: options.description,
    tags: options.tags ?? [],
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      ...options.contract,
      name: toolName,
    },
  });

  return {
    meta,
    search: options.search,
    createTool() {
      return createGuardedTool({
        contract: meta.contract,
        description: `${meta.title}: ${meta.description}`,
        parameters: searchParamsSchema,
        publicConfig: {
          connectorId: meta.id,
          kind: meta.kind,
          title: meta.title,
          tags: meta.tags,
          ...options.publicConfig,
        },
        execute: (input) => options.search(input),
      });
    },
  };
}

export function toEvidenceItems(
  sourceId: string,
  rows: Array<{
    title: string;
    snippet: string;
    uri?: string;
    score?: number;
  }>,
): EvidenceItem[] {
  const now = new Date().toISOString();
  return rows.map((row) => ({
    sourceId,
    title: row.title,
    snippet: row.snippet,
    uri: row.uri,
    score: row.score,
    retrievedAt: now,
  }));
}

export interface CreateMemoryConnectorOptions {
  id: string;
  title: string;
  description: string;
  kind?: DataSourceKind;
  tags?: string[];
  /** Static records searched by simple substring match. */
  records: Array<{ title: string; body: string; uri?: string }>;
  contract?: Partial<ToolContractInput>;
}

/**
 * In-process / fixture-backed connector.
 * Use this pattern for real sources: close over credentials in the factory,
 * expose only a typed search tool to agents.
 */
export function createMemoryConnector(
  options: CreateMemoryConnectorOptions,
): DataSourceConnector {
  return createSearchConnector({
    id: options.id,
    title: options.title,
    description: options.description,
    kind: options.kind ?? 'memory',
    tags: options.tags,
    contract: options.contract,
    search: async (input) => {
      const q = input.query.trim().toLowerCase();
      const limit = input.limit ?? 5;
      const matched = options.records
        .map((record, index) => {
          const hay = `${record.title}\n${record.body}`.toLowerCase();
          const hit =
            !q ||
            hay.includes(q) ||
            q.split(/\s+/).some((w) => hay.includes(w));
          if (!hit && q) return null;
          return {
            title: record.title,
            snippet: record.body,
            uri: record.uri,
            score: hit ? 1 - index * 0.01 : 0,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null)
        .slice(0, limit);

      const rows =
        matched.length > 0
          ? matched
          : options.records.slice(0, limit).map((record, index) => ({
              title: record.title,
              snippet: record.body,
              uri: record.uri,
              score: 0.1 - index * 0.01,
            }));

      return {
        sourceId: options.id,
        query: input.query,
        items: toEvidenceItems(options.id, rows),
      };
    },
  });
}
