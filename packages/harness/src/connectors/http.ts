import type { ToolContractInput } from '@agent-env/shared';
import {
  createSearchConnector,
  toEvidenceItems,
  type ConnectorSearchInput,
  type DataSourceConnector,
} from './types.js';

export type HttpFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpMappedItem {
  title: string;
  snippet: string;
  uri?: string;
  score?: number;
}

export interface CreateHttpJsonConnectorOptions {
  id: string;
  title: string;
  description: string;
  tags?: string[];
  contract?: Partial<ToolContractInput>;
  /**
   * Build the HTTP request from the agent search input.
   * Inject auth headers here (env / secret manager — caller's choice).
   */
  buildRequest: (input: ConnectorSearchInput) => {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  /** Map JSON body → evidence rows. */
  mapResponse: (
    data: unknown,
    input: ConnectorSearchInput,
  ) => HttpMappedItem[];
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
}

function getAtPath(data: unknown, path: string): unknown {
  if (!path.trim()) return data;
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

/**
 * Generic HTTP JSON read connector.
 * Easiest way to plug REST/search APIs into the collector.
 */
export function createHttpJsonConnector(
  options: CreateHttpJsonConnectorOptions,
): DataSourceConnector {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  return createSearchConnector({
    id: options.id,
    title: options.title,
    description: options.description,
    kind: 'http',
    tags: options.tags ?? ['http'],
    contract: {
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs,
      ...options.contract,
    },
    search: async (input) => {
      const req = options.buildRequest(input);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(req.url, {
          method: req.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            ...req.headers,
          },
          body: req.body,
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status} ${response.statusText} for ${req.url}`,
          );
        }
        const data: unknown = await response.json();
        const rows = options.mapResponse(data, input).slice(0, input.limit ?? 5);
        return {
          sourceId: options.id,
          query: input.query,
          items: toEvidenceItems(options.id, rows),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}

export interface CreateSimpleHttpJsonConnectorOptions {
  id: string;
  title: string;
  description: string;
  tags?: string[];
  /** Exact URL, or template with `{query}` / `{limit}` placeholders. */
  url: string | ((input: ConnectorSearchInput) => string);
  /** Dot path to the array of items (default: root if array). */
  itemsPath?: string;
  titleKey?: string;
  snippetKey?: string;
  uriKey?: string;
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | undefined);
  fetchImpl?: HttpFetch;
  contract?: Partial<ToolContractInput>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(
  row: Record<string, unknown>,
  key: string | undefined,
  fallback: string,
): string {
  if (!key) return fallback;
  const value = row[key];
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

/**
 * Batteries-included HTTP connector for common list/search JSON APIs.
 *
 * @example
 * createSimpleHttpJsonConnector({
 *   id: 'posts',
 *   title: 'Posts API',
 *   description: 'JSONPlaceholder posts',
 *   url: 'https://jsonplaceholder.typicode.com/posts',
 *   titleKey: 'title',
 *   snippetKey: 'body',
 * })
 */
export function createSimpleHttpJsonConnector(
  options: CreateSimpleHttpJsonConnectorOptions,
): DataSourceConnector {
  const titleKey = options.titleKey ?? 'title';
  const snippetKey = options.snippetKey ?? 'body';
  const uriKey = options.uriKey;

  return createHttpJsonConnector({
    id: options.id,
    title: options.title,
    description: options.description,
    tags: options.tags,
    contract: options.contract,
    fetchImpl: options.fetchImpl,
    buildRequest: (input) => {
      const url =
        typeof options.url === 'function'
          ? options.url(input)
          : options.url
              .replaceAll('{query}', encodeURIComponent(input.query))
              .replaceAll('{limit}', String(input.limit ?? 5));
      const headers =
        typeof options.headers === 'function'
          ? options.headers()
          : options.headers;
      return { url, headers };
    },
    mapResponse: (data, input) => {
      const raw = options.itemsPath
        ? getAtPath(data, options.itemsPath)
        : data;
      const list = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
      const q = input.query.trim().toLowerCase();
      const mapped = list
        .map((entry, index) => {
          const row = asRecord(entry);
          if (!row) return null;
          const title = pickString(row, titleKey, `item-${index + 1}`);
          const snippet = pickString(row, snippetKey, JSON.stringify(row).slice(0, 280));
          const uri = uriKey ? pickString(row, uriKey, '') || undefined : undefined;
          const hay = `${title}\n${snippet}`.toLowerCase();
          const hit =
            !q ||
            hay.includes(q) ||
            q.split(/\s+/).some((w) => w && hay.includes(w));
          return {
            title,
            snippet,
            uri,
            score: hit ? 1 - index * 0.01 : 0.05,
            hit,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x != null);

      const hits = mapped.filter((m) => m.hit);
      const chosen = (hits.length > 0 ? hits : mapped).slice(
        0,
        input.limit ?? 5,
      );
      return chosen.map(({ title, snippet, uri, score }) => ({
        title,
        snippet,
        uri,
        score,
      }));
    },
  });
}
