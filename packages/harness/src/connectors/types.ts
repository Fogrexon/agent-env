import type { FunctionTool } from '@google/adk';
import type {
  DataSourceConnectorMeta,
  DataSourceKind,
  EvidenceBundle,
  ToolContractInput,
} from '@agent-env/shared';
import { dataSourceConnectorSchema } from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';

const searchParamsSchema = z.object({
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
  const toolName = `search_${options.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const meta = dataSourceConnectorSchema.parse({
    id: options.id,
    kind: options.kind ?? 'memory',
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

  const search = async (
    input: ConnectorSearchInput,
  ): Promise<EvidenceBundle> => {
    const q = input.query.trim().toLowerCase();
    const limit = input.limit ?? 5;
    const now = new Date().toISOString();
    const items = options.records
      .map((record, index) => {
        const hay = `${record.title}\n${record.body}`.toLowerCase();
        const hit = !q || hay.includes(q) || q.split(/\s+/).some((w) => hay.includes(w));
        if (!hit && q) return null;
        return {
          sourceId: options.id,
          title: record.title,
          snippet: record.body.slice(0, 280),
          uri: record.uri,
          score: hit ? 1 - index * 0.01 : 0,
          retrievedAt: now,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .slice(0, limit);

    // If nothing matched, return top-N as weak context (collector can still synthesize).
    const fallback =
      items.length > 0
        ? items
        : options.records.slice(0, limit).map((record, index) => ({
            sourceId: options.id,
            title: record.title,
            snippet: record.body.slice(0, 280),
            uri: record.uri,
            score: 0.1 - index * 0.01,
            retrievedAt: now,
          }));

    return {
      sourceId: options.id,
      query: input.query,
      items: fallback,
    };
  };

  return {
    meta,
    search,
    createTool() {
      return createGuardedTool({
        contract: meta.contract,
        description: `${meta.title}: ${meta.description}`,
        parameters: searchParamsSchema,
        execute: (input) => search(input),
      });
    },
  };
}
