/**
 * Resolve execution-environment paths: one host root, builtin samples, plugin packs.
 *
 * Env (optional):
 * - AGENT_ENV_ROOT — host root (.env / .runs / plugins). Default: cwd or provided fallback.
 * - AGENT_ENV_PLUGIN_DIRS — extra plugin pack roots (path.delimiter-separated).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, join, resolve, sep } from 'node:path';
import type { DiscoverAgentsOptions } from './catalog.js';

export interface HostPaths {
  /** Execution environment root (.env, .runs, agents/, plugins/). */
  root: string;
  /** Builtin sample agents directory ({root}/agents). */
  builtinAgentsDir: string;
  /** Plugin packs parent ({root}/plugins). */
  pluginsDir: string;
  /** Each entry is an agents-root (contains <id>/agent.ts). */
  pluginPackDirs: readonly string[];
  /** All agents roots for discovery: builtin + plugin packs. */
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

function listPluginPackDirs(pluginsDir: string): string[] {
  if (!existsSync(pluginsDir) || !statSync(pluginsDir).isDirectory()) {
    return [];
  }
  return readdirSync(pluginsDir)
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(pluginsDir, name))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

function parseExtraPluginDirs(
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
  const builtinAgentsDir = join(root, 'agents');
  const pluginsDir = join(root, 'plugins');
  const fromPluginsTree = listPluginPackDirs(pluginsDir);
  const fromEnv = parseExtraPluginDirs(env['AGENT_ENV_PLUGIN_DIRS'], root);
  const pluginPackDirs = [...fromPluginsTree, ...fromEnv];
  const agentsDirs = [builtinAgentsDir, ...pluginPackDirs];

  return {
    root,
    builtinAgentsDir,
    pluginsDir,
    pluginPackDirs,
    agentsDirs,
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
 * snapshot `agentsDirs` at boot or newly added plugin packs stay invisible.
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
 * Map a discovered agents root (`agents/` or `plugins/<pack>/`) to pack metadata.
 * Extra roots from AGENT_ENV_PLUGIN_DIRS use their directory basename.
 */
export function deriveAgentPackInfo(
  agentsRoot: string,
  repoRoot: string,
): AgentPackInfo {
  const root = resolve(repoRoot);
  const agentsDir = resolve(agentsRoot);
  const builtinAgentsDir = join(root, 'agents');

  if (agentsDir === builtinAgentsDir) {
    return { pack: 'builtin', group: PACK_GROUP_LABELS.builtin };
  }

  const pluginsDir = join(root, 'plugins');
  if (
    agentsDir === pluginsDir ||
    agentsDir.startsWith(pluginsDir + sep)
  ) {
    const pack =
      agentsDir === pluginsDir
        ? 'plugins'
        : basename(agentsDir);
    return {
      pack,
      group: PACK_GROUP_LABELS[pack as keyof typeof PACK_GROUP_LABELS] ?? pack,
    };
  }

  const fallback = basename(agentsDir);
  return {
    pack: fallback,
    group: PACK_GROUP_LABELS[fallback as keyof typeof PACK_GROUP_LABELS] ?? fallback,
  };
}
