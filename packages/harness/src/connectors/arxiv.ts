import type { ToolContractInput } from '@agent-env/shared';
import {
  createSearchConnector,
  toEvidenceItems,
  type ConnectorSearchInput,
  type DataSourceConnector,
} from './types.js';
import type { HttpFetch } from './http.js';

export type ArxivSortBy =
  | 'relevance'
  | 'lastUpdatedDate'
  | 'submittedDate';

export type ArxivSortOrder = 'ascending' | 'descending';

export interface CreateArxivConnectorOptions {
  /** Registry id. Default: "arxiv". */
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  contract?: Partial<ToolContractInput>;
  /**
   * Atom API endpoint.
   * Default: `https://export.arxiv.org/api/query`
   */
  baseUrl?: string;
  /**
   * Optional category filters (e.g. `cs.AI`, `cs.LG`).
   * Combined with the free-text query via AND.
   */
  categories?: string[];
  /** Default: relevance. */
  sortBy?: ArxivSortBy;
  /** Default: descending when sortBy is a date field. */
  sortOrder?: ArxivSortOrder;
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
  /**
   * User-Agent sent to arXiv (they request a descriptive UA).
   * Override from the call site if you need a contact address.
   */
  userAgent?: string;
}

const DEFAULT_BASE_URL = 'https://export.arxiv.org/api/query';
const DEFAULT_USER_AGENT =
  'agent-env-arxiv-connector/0.1 (+https://github.com/Fogrexon/agent-env)';

const FIELD_QUERY_RE =
  /\b(ti|au|abs|co|jr|cat|all|rn|id):\S|\b(AND|OR|ANDNOT)\b/i;

function decodeXmlEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, '&');
}

function stripTags(text: string): string {
  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function firstTagContent(xml: string, localName: string): string {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${localName}>`,
    'i',
  );
  const match = re.exec(xml);
  if (!match?.[1]) return '';
  return stripTags(decodeXmlEntities(match[1]));
}

function firstAttr(
  xml: string,
  localName: string,
  attr: string,
): string | undefined {
  const re = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*\\b${attr}=["']([^"']+)["'][^>]*\\/?>`,
    'i',
  );
  const match = re.exec(xml);
  return match?.[1] ? decodeXmlEntities(match[1]) : undefined;
}

function absUrlFromId(id: string): string | undefined {
  const trimmed = id.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace('http://arxiv.org/', 'https://arxiv.org/');
  }
  const bare = trimmed.replace(/^arxiv:/i, '');
  return `https://arxiv.org/abs/${bare}`;
}

/**
 * Build an arXiv `search_query` string.
 * Free text becomes `all:"..."` (or AND of tokens); field queries pass through.
 */
export function buildArxivSearchQuery(
  query: string,
  categories: string[] = [],
): string {
  const q = query.trim();
  let core: string;
  if (!q) {
    core = '';
  } else if (FIELD_QUERY_RE.test(q)) {
    core = q;
  } else if (/\s/.test(q)) {
    core = `all:"${q.replace(/"/g, '')}"`;
  } else {
    core = `all:${q}`;
  }

  const cats = categories
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => (c.startsWith('cat:') ? c : `cat:${c}`));

  if (cats.length === 0) return core;
  const catClause = cats.length === 1 ? cats[0]! : `(${cats.join(' OR ')})`;
  return core ? `${core} AND ${catClause}` : catClause;
}

export interface ArxivAtomRow {
  title: string;
  snippet: string;
  uri?: string;
  score?: number;
}

/**
 * Parse arXiv Atom XML into evidence rows (exported for offline smoke tests).
 */
export function parseArxivAtom(atomXml: string, limit: number): ArxivAtomRow[] {
  const entries = atomXml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  return entries.slice(0, limit).map((entry, index) => {
    const title =
      firstTagContent(entry, 'title') || `arxiv-result-${index + 1}`;
    const summary = firstTagContent(entry, 'summary');
    const authors = [
      ...entry.matchAll(
        /<(?:[A-Za-z_][\w.-]*:)?name(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?name>/gi,
      ),
    ]
      .map((m) => stripTags(decodeXmlEntities(m[1] ?? '')))
      .filter(Boolean);
    const published = firstTagContent(entry, 'published');
    const id = firstTagContent(entry, 'id');
    const htmlLink = firstAttr(entry, 'link', 'href');
    const uri = absUrlFromId(id) ?? htmlLink;
    const metaBits = [
      authors.length > 0 ? authors.slice(0, 3).join(', ') : '',
      published ? published.slice(0, 10) : '',
    ].filter(Boolean);
    const snippet = [metaBits.join(' · '), summary || title]
      .filter(Boolean)
      .join('\n')
      .trim();

    return {
      title,
      snippet,
      uri,
      score: 1 - index * 0.01,
    };
  });
}

/**
 * arXiv preprint search via the public Atom API (no API key).
 *
 * @example
 * createArxivConnector({ categories: ['cs.AI', 'cs.LG'] })
 */
export function createArxivConnector(
  options: CreateArxivConnectorOptions = {},
): DataSourceConnector {
  const id = options.id ?? 'arxiv';
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const categories = options.categories ?? [];

  return createSearchConnector({
    id,
    title: options.title ?? 'arXiv preprints',
    description:
      options.description ??
      'Search arXiv paper metadata via the public Atom API.',
    kind: 'arxiv',
    tags: options.tags ?? ['arxiv', 'papers', 'research'],
    contract: {
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs,
      ...options.contract,
    },
    publicConfig: {
      baseUrl,
      timeoutMs,
      ...(categories.length > 0 ? { categories } : {}),
      ...(options.sortBy ? { sortBy: options.sortBy } : {}),
    },
    search: async (input: ConnectorSearchInput) => {
      const limit = input.limit ?? 5;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const url = new URL(baseUrl);
        url.searchParams.set(
          'search_query',
          buildArxivSearchQuery(input.query, categories),
        );
        url.searchParams.set('start', '0');
        url.searchParams.set('max_results', String(Math.min(limit, 20)));
        if (options.sortBy) {
          url.searchParams.set('sortBy', options.sortBy);
        }
        if (options.sortOrder) {
          url.searchParams.set('sortOrder', options.sortOrder);
        } else if (
          options.sortBy === 'submittedDate' ||
          options.sortBy === 'lastUpdatedDate'
        ) {
          url.searchParams.set('sortOrder', 'descending');
        }

        const response = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: {
            Accept: 'application/atom+xml',
            'User-Agent': userAgent,
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `arXiv HTTP ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`,
          );
        }

        const rows = parseArxivAtom(await response.text(), limit);
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
