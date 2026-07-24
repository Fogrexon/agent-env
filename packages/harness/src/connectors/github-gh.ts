import { spawn } from 'node:child_process';
import type { ToolContractInput } from '@agent-env/shared';
import {
  createSearchConnector,
  toEvidenceItems,
  type ConnectorSearchInput,
  type DataSourceConnector,
} from './types.js';

export type GhRunner = (
  args: string[],
  options?: { cwd?: string },
) => Promise<string>;

export interface CreateGithubGhConnectorOptions {
  /** Registry id. Default: "github". */
  id?: string;
  title?: string;
  description?: string;
  tags?: string[];
  contract?: Partial<ToolContractInput>;
  /**
   * Limit search to a repo (`owner/name`).
   * If omitted, falls back to `gh repo view` in `cwd` (caller-supplied).
   * Do not rely on env var names inside this factory — pass `repo` from the app.
   */
  repo?: string | (() => string | undefined);
  /** What to search via `gh search`. Default: issues + prs. */
  targets?: Array<'issues' | 'prs'>;
  /** Path to gh binary. Default: "gh" (PATH / auth is caller's concern). */
  ghBin?: string;
  /** Working directory for gh (repo detection). */
  cwd?: string;
  /** Inject for tests. */
  runGh?: GhRunner;
  /**
   * Env for the `gh` child process. Default: inherit (Node spawn default).
   * Pass explicitly in tests; do not use this for API-key config of the connector.
   */
  env?: NodeJS.ProcessEnv;
}

async function defaultRunGh(
  args: string[],
  options: { cwd?: string; ghBin?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const ghBin = options.ghBin ?? 'gh';
  return await new Promise((resolve, reject) => {
    const child = spawn(ghBin, args, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `gh ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`,
        ),
      );
    });
  });
}

interface GhSearchRow {
  title?: string;
  body?: string;
  url?: string;
  number?: number;
  state?: string;
}

function parseGhJsonArray(text: string): GhSearchRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const parsed: unknown = JSON.parse(trimmed);
  return Array.isArray(parsed) ? (parsed as GhSearchRow[]) : [];
}

/**
 * GitHub connector backed by the `gh` CLI (issues / PRs search).
 * Auth is whatever `gh` already has configured — this factory does not
 * read tokens from env itself.
 */
export function createGithubGhConnector(
  options: CreateGithubGhConnectorOptions = {},
): DataSourceConnector {
  const id = options.id ?? 'github';
  const targets = options.targets ?? ['issues', 'prs'];
  const runGh =
    options.runGh ??
    ((args, opts) =>
      defaultRunGh(args, {
        cwd: opts?.cwd ?? options.cwd,
        ghBin: options.ghBin,
        env: options.env,
      }));

  const resolveRepo = async (): Promise<string | undefined> => {
    const fromOpt =
      typeof options.repo === 'function' ? options.repo() : options.repo;
    if (fromOpt?.trim()) return fromOpt.trim();
    try {
      const raw = await runGh(
        ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'],
        { cwd: options.cwd },
      );
      const name = raw.trim();
      return name || undefined;
    } catch {
      return undefined;
    }
  };

  return createSearchConnector({
    id,
    title: options.title ?? 'GitHub (gh)',
    description:
      options.description ??
      'Search issues/PRs via the GitHub CLI (`gh search`).',
    kind: 'github',
    tags: options.tags ?? ['github', 'gh'],
    contract: {
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
      timeoutMs: 30_000,
      ...options.contract,
    },
    search: async (input: ConnectorSearchInput) => {
      const limit = input.limit ?? 5;
      const repo = await resolveRepo();
      const perTarget = Math.max(1, Math.ceil(limit / targets.length));
      const rows: Array<{
        title: string;
        snippet: string;
        uri?: string;
        score?: number;
      }> = [];

      for (const target of targets) {
        const args = [
          'search',
          target,
          input.query,
          '--json',
          'title,body,url,number,state',
          '--limit',
          String(perTarget),
        ];
        if (repo) {
          args.push('--repo', repo);
        }
        try {
          const stdout = await runGh(args, { cwd: options.cwd });
          for (const item of parseGhJsonArray(stdout)) {
            const number = item.number != null ? `#${item.number}` : '';
            const state = item.state ? ` [${item.state}]` : '';
            rows.push({
              title: `${target.slice(0, -1)} ${number}${state}: ${item.title ?? '(no title)'}`,
              snippet: (item.body ?? '').trim() || '(no body)',
              uri: item.url,
              score: 1,
            });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          rows.push({
            title: `gh search ${target} error`,
            snippet: message.slice(0, 400),
            score: 0,
          });
        }
      }

      return {
        sourceId: id,
        query: input.query,
        items: toEvidenceItems(id, rows.slice(0, limit)),
      };
    },
  });
}

/** True when `gh` looks usable (binary runs `gh auth status`-ish check). */
export async function isGithubGhAvailable(
  runGh: GhRunner = (args) => defaultRunGh(args),
): Promise<boolean> {
  try {
    await runGh(['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}
