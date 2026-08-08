import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAgentParamsFile, type AgentDefinition } from '@agent-env/harness';
import {
  agentParamsSpecSchema,
  type AgentManifest,
  type AgentParamsSpec,
} from '@agent-env/shared';

/** Directories under an agents root that are not runnable agent packages. */
const SKIP_DIR_NAMES = new Set(['dev-env', 'node_modules', 'dist']);

export interface DiscoverAgentsOptions {
  /**
   * Single agents directory (legacy). Prefer `agentsDirs` from resolveHostPaths.
   * Ignored when `agentsDirs` is non-empty.
   */
  agentsDir?: string;
  /** Multiple agents roots (builtin samples + plugin packs). */
  agentsDirs?: readonly string[];
  /** Host root for relative entry/paramsFile paths. */
  repoRoot?: string;
}

/**
 * Filesystem package resolved by convention:
 *
 *   <agentsRoot>/<id>/agent.ts          (required)
 *   <agentsRoot>/<id>/params.yaml       (optional)
 */
export interface ResolvedAgentPackage {
  id: string;
  dir: string;
  entry: string;
  paramsFile?: string;
  params: AgentParamsSpec;
  manifest: AgentManifest;
  /** Agents root this package was discovered from. */
  agentsRoot: string;
}

/** In-memory params when `params.yaml` is absent. */
export function defaultAgentParams(agentId: string): AgentParamsSpec {
  return agentParamsSpecSchema.parse({
    agentId,
    objectiveField: 'message',
    fields: [
      {
        id: 'message',
        type: 'text',
        label: 'Message',
        required: true,
      },
    ],
  });
}

function normalizeAgentsDirs(options: DiscoverAgentsOptions): string[] {
  if (options.agentsDirs && options.agentsDirs.length > 0) {
    return options.agentsDirs.map((dir) => resolve(dir));
  }
  if (options.agentsDir) {
    return [resolve(options.agentsDir)];
  }
  return [];
}

function resolvePackagesInDir(
  agentsDir: string,
  repoRoot: string,
): ResolvedAgentPackage[] {
  if (!existsSync(agentsDir) || !statSync(agentsDir).isDirectory()) {
    return [];
  }

  const packages: ResolvedAgentPackage[] = [];
  for (const name of readdirSync(agentsDir).sort()) {
    if (SKIP_DIR_NAMES.has(name) || name.startsWith('.')) continue;
    const dir = join(agentsDir, name);
    if (!statSync(dir).isDirectory()) continue;

    const entryAbs = join(dir, 'agent.ts');
    if (!existsSync(entryAbs)) continue;

    const paramsAbs = join(dir, 'params.yaml');
    const hasParams = existsSync(paramsAbs);

    const entry = toPosixRelative(repoRoot, entryAbs);
    const paramsFile = hasParams
      ? toPosixRelative(repoRoot, paramsAbs)
      : undefined;

    const params = hasParams
      ? loadAgentParamsFile(paramsAbs)
      : defaultAgentParams(name);
    if (params.agentId !== name) {
      throw new Error(
        `params agentId "${params.agentId}" must match directory "${name}"` +
          (paramsFile ? ` (${paramsFile})` : ''),
      );
    }

    packages.push({
      id: name,
      dir,
      entry,
      ...(paramsFile ? { paramsFile } : {}),
      params,
      agentsRoot: agentsDir,
      manifest: {
        id: name,
        name: params.title ?? name,
        description: params.description ?? '',
        entry,
        ...(paramsFile ? { paramsFile } : {}),
      },
    });
  }

  return packages;
}

/**
 * Discover agents by filesystem convention across one or more agents roots
 * (builtin `agents/` + `plugins/<pack>/`). Never scans packages/*.
 * Directories without `agent.ts` are skipped. `params.yaml` is optional.
 * Duplicate agent ids across roots throw.
 */
export function discoverAgents(
  options: DiscoverAgentsOptions,
): readonly AgentManifest[] {
  return resolveAgentPackages(options).map((pkg) => pkg.manifest);
}

export function getDiscoveredAgent(
  options: DiscoverAgentsOptions,
  id: string,
): AgentManifest | undefined {
  return discoverAgents(options).find((agent) => agent.id === id);
}

export function resolveAgentPackages(
  options: DiscoverAgentsOptions,
): readonly ResolvedAgentPackage[] {
  const agentsDirs = normalizeAgentsDirs(options);
  const repoRoot = resolve(
    options.repoRoot ??
      (agentsDirs[0] ? join(agentsDirs[0], '..') : process.cwd()),
  );

  const byId = new Map<string, ResolvedAgentPackage>();
  for (const agentsDir of agentsDirs) {
    for (const pkg of resolvePackagesInDir(agentsDir, repoRoot)) {
      const existing = byId.get(pkg.id);
      if (existing) {
        throw new Error(
          `Duplicate agent id "${pkg.id}":\n` +
            `  ${existing.dir}\n` +
            `  ${pkg.dir}`,
        );
      }
      byId.set(pkg.id, pkg);
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getResolvedAgentPackage(
  options: DiscoverAgentsOptions,
  id: string,
): ResolvedAgentPackage | undefined {
  return resolveAgentPackages(options).find((pkg) => pkg.id === id);
}

export async function loadAgentDefinition(
  entry: string,
  cwd: string = process.cwd(),
): Promise<AgentDefinition> {
  const absolute = resolve(cwd, entry);
  const mod = (await import(pathToFileURL(absolute).href)) as {
    agentDefinition?: AgentDefinition;
  };
  if (!mod.agentDefinition) {
    throw new Error(`${entry} must export agentDefinition`);
  }
  return mod.agentDefinition;
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).split('\\').join('/');
}
