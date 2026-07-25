import type { FunctionTool } from '@google/adk';
import type { ToolContractInput } from '@agent-env/shared';
import { resolveSecret, type SecretSource } from '@agent-env/llm';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';
import type { HttpFetch } from './http.js';

export const tavilyExtractParamsSchema = z.object({
  urls: z
    .array(z.string().min(8))
    .min(1)
    .max(5)
    .describe('Absolute URLs to extract readable content from'),
  maxCharsPerUrl: z
    .number()
    .int()
    .min(500)
    .max(20_000)
    .optional()
    .describe('Max characters per URL (default 8000)'),
});

export type TavilyExtractInput = z.infer<typeof tavilyExtractParamsSchema>;

export interface CreateTavilyExtractToolOptions {
  /** Tool name. Default: "fetch_pages". */
  name?: string;
  description?: string;
  contract?: Partial<ToolContractInput>;
  /**
   * Tavily API key — string or lazy getter.
   * Inject from env / secret manager at the call site; this factory does not read env.
   */
  apiKey: SecretSource;
  /** Inject for tests; defaults to global fetch. */
  fetchImpl?: HttpFetch;
  timeoutMs?: number;
  /** Default max chars when the tool call omits maxCharsPerUrl. */
  defaultMaxCharsPerUrl?: number;
}

/**
 * Tavily Extract as a reusable harness tool (connector-shaped capability).
 * Agents must not reimplement this HTTP call locally — wire secrets here instead.
 */
export function createTavilyExtractTool(
  options: CreateTavilyExtractToolOptions,
): FunctionTool {
  const name = options.name ?? 'fetch_pages';
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const defaultMaxChars = options.defaultMaxCharsPerUrl ?? 8_000;

  return createGuardedTool({
    contract: {
      version: '1.0',
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs,
      ...options.contract,
      name,
    },
    description:
      options.description ??
      'Extract full readable page content for up to 5 URLs via the Tavily Extract API.',
    parameters: tavilyExtractParamsSchema,
    publicConfig: {
      provider: 'tavily',
      timeoutMs,
      defaultMaxCharsPerUrl: defaultMaxChars,
    },
    execute: async ({ urls, maxCharsPerUrl }) => {
      const apiKey = resolveSecret(options.apiKey);
      if (!apiKey) {
        return {
          status: 'error',
          message: `Tool "${name}" has no API key. Pass apiKey when calling createTavilyExtractTool().`,
        };
      }

      const limit = maxCharsPerUrl ?? defaultMaxChars;
      const batch = urls.slice(0, 5);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl('https://api.tavily.com/extract', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ api_key: apiKey, urls: batch }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          return {
            status: 'error',
            message: `Tavily extract HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
          };
        }
        const data = (await response.json()) as {
          results?: Array<{ url?: string; raw_content?: string }>;
          failed_results?: Array<{ url?: string; error?: string }>;
        };
        return {
          status: 'success',
          pages: (data.results ?? []).map((r) => ({
            url: r.url,
            content: (r.raw_content ?? '').slice(0, limit),
            truncated: (r.raw_content?.length ?? 0) > limit,
          })),
          failed: data.failed_results ?? [],
        };
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
