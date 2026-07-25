import type { ToolContractInput } from '@agent-env/shared';
import { resolveSecret, type SecretSource } from '@agent-env/llm';
import {
  createSearchConnector,
  toEvidenceItems,
  type ConnectorSearchInput,
  type DataSourceConnector,
} from './types.js';
import type { HttpFetch } from './http.js';

export type WebSearchProviderId = 'brave' | 'tavily';

export interface CreateWebSearchConnectorOptions {
  /** Registry id. Default: "web". */
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  contract?: Partial<ToolContractInput>;
  /** Search backend. */
  provider: WebSearchProviderId;
  /**
   * API key — string or lazy getter.
   * Do not hardcode; inject from env / secret manager at the call site.
   */
  apiKey: SecretSource;
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
  /** Brave: ISO country code (e.g. "JP"). */
  country?: string;
  /** Brave: search language (e.g. "jp"). */
  searchLang?: string;
  /** Tavily: search depth. Default: API default ("basic"). */
  searchDepth?: 'basic' | 'advanced';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function pickString(
  row: Record<string, unknown>,
  keys: string[],
  fallback = '',
): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return fallback;
}

function mapBraveResults(
  data: unknown,
  limit: number,
): Array<{ title: string; snippet: string; uri?: string; score?: number }> {
  const root = asRecord(data);
  const web = asRecord(root?.['web']);
  const list = Array.isArray(web?.['results']) ? web!['results'] : [];
  return list.slice(0, limit).map((entry, index) => {
    const row = asRecord(entry) ?? {};
    const title = pickString(row, ['title'], `result-${index + 1}`);
    const snippet = stripHtml(
      pickString(row, ['description', 'snippet'], title),
    );
    const uri = pickString(row, ['url', 'uri']) || undefined;
    return { title, snippet, uri, score: 1 - index * 0.01 };
  });
}

function mapTavilyResults(
  data: unknown,
  limit: number,
): Array<{ title: string; snippet: string; uri?: string; score?: number }> {
  const root = asRecord(data);
  const list = Array.isArray(root?.['results']) ? root!['results'] : [];
  return list.slice(0, limit).map((entry, index) => {
    const row = asRecord(entry) ?? {};
    const title = pickString(row, ['title'], `result-${index + 1}`);
    const snippet = pickString(row, ['content', 'snippet'], title);
    const uri = pickString(row, ['url', 'uri']) || undefined;
    const rawScore = row['score'];
    const score =
      typeof rawScore === 'number' ? rawScore : 1 - index * 0.01;
    return { title, snippet, uri, score };
  });
}

/**
 * Web search connector (Brave Search API or Tavily).
 * Secrets are injected by the caller — this factory does not read env itself.
 *
 * @example
 * createWebSearchConnector({
 *   provider: 'tavily',
 *   apiKey: () => mySecrets.tavily, // caller-owned; env is one option
 * })
 */
export function createWebSearchConnector(
  options: CreateWebSearchConnectorOptions,
): DataSourceConnector {
  const id = options.id ?? 'web';
  const provider = options.provider;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  const title =
    options.title ??
    (provider === 'brave' ? 'Web search (Brave)' : 'Web search (Tavily)');
  const description =
    options.description ??
    (provider === 'brave'
      ? 'Search the public web via Brave Search API.'
      : 'Search the public web via Tavily Search API.');

  return createSearchConnector({
    id,
    title,
    description,
    kind: 'web',
    tags: options.tags ?? ['web', 'search', provider],
    contract: {
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs,
      ...options.contract,
    },
    publicConfig: {
      provider,
      timeoutMs,
      ...(options.country ? { country: options.country } : {}),
      ...(options.searchLang ? { searchLang: options.searchLang } : {}),
      ...(options.searchDepth ? { searchDepth: options.searchDepth } : {}),
    },
    search: async (input: ConnectorSearchInput) => {
      const apiKey = resolveSecret(options.apiKey);
      if (!apiKey) {
        throw new Error(
          `Web search connector "${id}" (${provider}) has no API key. Pass apiKey when calling createWebSearchConnector().`,
        );
      }

      const limit = input.limit ?? 5;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let response: Response;
        if (provider === 'brave') {
          const url = new URL(
            'https://api.search.brave.com/res/v1/web/search',
          );
          url.searchParams.set('q', input.query);
          url.searchParams.set('count', String(Math.min(limit, 20)));
          if (options.country) {
            url.searchParams.set('country', options.country);
          }
          if (options.searchLang) {
            url.searchParams.set('search_lang', options.searchLang);
          }
          response = await fetchImpl(url.toString(), {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              'X-Subscription-Token': apiKey,
            },
            signal: controller.signal,
          });
        } else {
          response = await fetchImpl('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              api_key: apiKey,
              query: input.query,
              max_results: Math.min(limit, 20),
              include_answer: false,
              ...(options.searchDepth
                ? { search_depth: options.searchDepth }
                : {}),
            }),
            signal: controller.signal,
          });
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `Web search (${provider}) HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
          );
        }

        const data: unknown = await response.json();
        const rows =
          provider === 'brave'
            ? mapBraveResults(data, limit)
            : mapTavilyResults(data, limit);

        return {
          sourceId: id,
          query: input.query,
          items: toEvidenceItems(id, rows),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
