/**
 * Resolve execution-environment paths: one host root and agent packs under agents/.
 *
 * Env (optional):
 * - AGENT_ENV_ROOT — host root (.env / .runs / agents). Default: cwd or provided fallback.
 * - AGENT_ENV_PLUGIN_DIRS — extra pack roots (path.delimiter-separated), each containing <id>/agent.ts.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve } from 'node:path';
import type { DiscoverAgentsOptions } from './catalog.js';

/** Host-only dirs under agents/ that are not packs. */
const SKIP_PACK_NAMES = new Set(['dev-env', 'node_modules', 'dist']);

export interface HostPaths {
  /** Execution environment root (.env, .runs, agents/). */
  root: string;
  /** Agents parent ({root}/agents) — packs live one level down. */
  agentsDir: string;
  /** Each entry is an agents-root (contains <id>/agent.ts). */
  packDirs: readonly string[];
  /** All agents roots for discovery (= packDirs). */
  agentsDirs: readonly string[];
}

export interface ResolveHostPathsOptions {
  /**
   * Fallback when AGENT_ENV_ROOT is unset.
   * Admin passes the platform repo root; CLI typically uses process.cwd().
   */
  fallbackRoot?: string;
  env?: NodeJS.ProcessEnv;
}

function listPackDirs(agentsDir: string): string[] {
  if (!existsSync(agentsDir) || !statSync(agentsDir).isDirectory()) {
    return [];
  }
  return readdirSync(agentsDir)
    .filter((name) => !name.startsWith('.') && !SKIP_PACK_NAMES.has(name))
    .map((name) => join(agentsDir, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function parseExtraPackDirs(
  raw: string | undefined,
  root: string,
): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => resolve(root, part));
}

/**
 * Resolve host filesystem layout for discovery and run history.
 */
export function resolveHostPaths(
  options: ResolveHostPathsOptions = {},
): HostPaths {
  const env = options.env ?? process.env;
  const fallback = options.fallbackRoot ?? process.cwd();
  const root = resolve(env['AGENT_ENV_ROOT']?.trim() || fallback);
  const agentsDir = join(root, 'agents');
  const fromTree = listPackDirs(agentsDir);
  const fromEnv = parseExtraPackDirs(env['AGENT_ENV_PLUGIN_DIRS'], root);
  const packDirs = [...fromTree, ...fromEnv];

  return {
    root,
    agentsDir,
    packDirs,
    agentsDirs: packDirs,
  };
}

/** Build DiscoverAgentsOptions from resolved host paths. */
export function discoveryFromHostPaths(
  paths: HostPaths,
): DiscoverAgentsOptions {
  return {
    agentsDirs: paths.agentsDirs,
    repoRoot: paths.root,
  };
}

/**
 * Resolve host paths then discovery options.
 * Long-lived processes (admin API) must call this per request — do not
 * snapshot `agentsDirs` at boot or newly added packs stay invisible.
 */
export function resolveDiscoveryOptions(
  options: ResolveHostPathsOptions = {},
): DiscoverAgentsOptions {
  return discoveryFromHostPaths(resolveHostPaths(options));
}

/** Pack id + display label derived from an agents root path. */
export interface AgentPackInfo {
  pack: string;
  group: string;
}

const PACK_GROUP_LABELS = {
  meta: 'Meta',
  showcase: 'Showcase',
  personal: 'Personal',
  builtin: 'Builtin',
} as const;

/**
 * Map a discovered agents root (`agents/<pack>/`) to pack metadata.
 * Extra roots from AGENT_ENV_PLUGIN_DIRS use their directory basename.
 */
export function deriveAgentPackInfo(
  agentsRoot: string,
  _repoRoot: string,
): AgentPackInfo {
  const pack = basename(resolve(agentsRoot));
  return {
    pack,
    group: PACK_GROUP_LABELS[pack as keyof typeof PACK_GROUP_LABELS] ?? pack,
  };
}
