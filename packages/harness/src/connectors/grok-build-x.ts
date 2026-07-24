import { spawn } from 'node:child_process';
import type { ToolContractInput } from '@agent-env/shared';
import {
  createSearchConnector,
  toEvidenceItems,
  type ConnectorSearchInput,
  type DataSourceConnector,
} from './types.js';

export type GrokRunner = (
  args: string[],
  options?: { cwd?: string },
) => Promise<string>;

export interface CreateGrokBuildXSearchConnectorOptions {
  /** Registry id. Default: "x". */
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  contract?: Partial<ToolContractInput>;
  /** Path to grok binary. Default: "grok". */
  grokBin?: string;
  /** Working directory for the headless run. */
  cwd?: string;
  /** Optional model id (`-m`). */
  model?: string;
  /**
   * Auto-approve tool calls (`--always-approve`). Default true —
   * required for unattended X search in headless mode.
   */
  alwaysApprove?: boolean;
  timeoutMs?: number;
  /** Inject for tests. */
  runGrok?: GrokRunner;
  /**
   * Env for the `grok` child process. Default: inherit (Node spawn default).
   * Auth should already be configured via `grok login` on the host.
   */
  env?: NodeJS.ProcessEnv;
  /** Hint handles for the prompt (max ~20 on the X Search tool). */
  allowedXHandles?: string[];
  excludedXHandles?: string[];
}

async function defaultRunGrok(
  args: string[],
  options: {
    cwd?: string;
    grokBin?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<string> {
  const grokBin = options.grokBin ?? 'grok';
  const timeoutMs = options.timeoutMs ?? 120_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(grokBin, args, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`grok timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `grok ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

/** Pull assistant text out of grok `--output-format json` payloads. */
export function extractGrokPlainText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const root = asRecord(parsed);
    if (!root) return trimmed;
    for (const key of ['result', 'text', 'message', 'output', 'content']) {
      const value = root[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    const nested = asRecord(root['data']);
    if (nested) {
      for (const key of ['result', 'text', 'message', 'output']) {
        const value = nested[key];
        if (typeof value === 'string' && value.trim()) return value;
      }
    }
  } catch {
    // plain / mixed stdout
  }
  return trimmed;
}

function extractJsonCandidate(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }
  try {
    return JSON.parse(text.trim());
  } catch {
    // continue
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function parseGrokXSearchEvidence(
  stdout: string,
  limit: number,
): Array<{ title: string; snippet: string; uri?: string; score?: number }> {
  const text = extractGrokPlainText(stdout);
  const data = extractJsonCandidate(text);
  const root = asRecord(data);
  const list = Array.isArray(root?.['items'])
    ? root!['items']
    : Array.isArray(root?.['results'])
      ? root!['results']
      : Array.isArray(data)
        ? data
        : undefined;

  if (list) {
    return list.slice(0, limit).map((entry, index) => {
      const row = asRecord(entry) ?? {};
      const title = pickString(row, ['title', 'name'], `x-post-${index + 1}`);
      const snippet = pickString(
        row,
        ['snippet', 'content', 'text', 'body'],
        title,
      );
      const uri = pickString(row, ['uri', 'url', 'link']) || undefined;
      const rawScore = row['score'];
      const score =
        typeof rawScore === 'number' ? rawScore : 1 - index * 0.01;
      return { title, snippet, uri, score };
    });
  }

  const fallback = text.trim();
  if (!fallback) return [];
  return [
    {
      title: 'X search summary (Grok Build)',
      snippet: fallback.slice(0, 500),
      score: 0.5,
    },
  ];
}

function buildXSearchPrompt(input: ConnectorSearchInput, options: {
  allowedXHandles?: string[];
  excludedXHandles?: string[];
}): string {
  const limit = input.limit ?? 5;
  const handleLines: string[] = [];
  if (options.allowedXHandles?.length) {
    handleLines.push(
      `Prefer posts from these handles: ${options.allowedXHandles.join(', ')}.`,
    );
  }
  if (options.excludedXHandles?.length) {
    handleLines.push(
      `Exclude posts from: ${options.excludedXHandles.join(', ')}.`,
    );
  }

  return [
    'You are an X (Twitter) search worker running inside Grok Build.',
    'Use ONLY X Search / x_search tools. Do NOT use web search, code edit, or shell.',
    'Do not modify files.',
    `Search X for: ${JSON.stringify(input.query)}`,
    ...handleLines,
    `Return at most ${limit} posts.`,
    'Respond with a single JSON object only (no markdown, no prose) of the form:',
    '{"items":[{"title":"@handle — short label","snippet":"post text","uri":"https://x.com/...","score":0.0}]}',
    'uri should be an x.com or twitter.com status URL when available.',
    'If nothing relevant is found, return {"items":[]}.',
  ].join('\n');
}

/**
 * X Search connector backed by Grok Build headless CLI (`grok -p`).
 * Auth is whatever `grok login` / local config already has — this factory
 * does not read API keys from env itself.
 *
 * Intended as a cheaper alternative to the official X API for collector fan-out.
 */
export function createGrokBuildXSearchConnector(
  options: CreateGrokBuildXSearchConnectorOptions = {},
): DataSourceConnector {
  const id = options.id ?? 'x';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const alwaysApprove = options.alwaysApprove ?? true;
  const runGrok =
    options.runGrok ??
    ((args, opts) =>
      defaultRunGrok(args, {
        cwd: opts?.cwd ?? options.cwd,
        grokBin: options.grokBin,
        timeoutMs,
        env: options.env,
      }));

  return createSearchConnector({
    id,
    title: options.title ?? 'X search (Grok Build)',
    description:
      options.description ??
      'Search X posts via Grok Build headless (`grok -p` + X Search tools).',
    kind: 'x',
    tags: options.tags ?? ['x', 'twitter', 'grok-build'],
    contract: {
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs,
      ...options.contract,
    },
    search: async (input: ConnectorSearchInput) => {
      const limit = input.limit ?? 5;
      const prompt = buildXSearchPrompt(input, {
        allowedXHandles: options.allowedXHandles,
        excludedXHandles: options.excludedXHandles,
      });
      const args = [
        '--no-auto-update',
        '--no-alt-screen',
        '-p',
        prompt,
        '--output-format',
        'json',
      ];
      if (alwaysApprove) args.push('--always-approve');
      if (options.model) args.push('-m', options.model);
      if (options.cwd) args.push('--cwd', options.cwd);

      try {
        const stdout = await runGrok(args, { cwd: options.cwd });
        const rows = parseGrokXSearchEvidence(stdout, limit);
        return {
          sourceId: id,
          query: input.query,
          items: toEvidenceItems(id, rows),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          sourceId: id,
          query: input.query,
          items: toEvidenceItems(id, [
            {
              title: 'grok X search error',
              snippet: message.slice(0, 400),
              score: 0,
            },
          ]),
        };
      }
    },
  });
}

/** True when the `grok` binary looks runnable. */
export async function isGrokBuildAvailable(
  runGrok: GrokRunner = (args) => defaultRunGrok(args, { timeoutMs: 10_000 }),
): Promise<boolean> {
  try {
    await runGrok(['--version']);
    return true;
  } catch {
    try {
      await runGrok(['--help']);
      return true;
    } catch {
      return false;
    }
  }
}
