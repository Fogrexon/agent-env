/**
 * Resolve execution-environment paths: one host root, builtin samples, plugin packs.
 *
 * Env (optional):
 * - AGENT_ENV_ROOT — host root (.env / .runs / plugins). Default: cwd or provided fallback.
 * - AGENT_ENV_PLUGIN_DIRS — extra plugin pack roots (path.delimiter-separated).
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
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

/** Convenience: resolve host paths then discovery options. */
export function resolveDiscoveryOptions(
  options: ResolveHostPathsOptions = {},
): DiscoverAgentsOptions {
  return discoveryFromHostPaths(resolveHostPaths(options));
}
