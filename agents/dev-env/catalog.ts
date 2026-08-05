import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadAgentParamsFile, type AgentDefinition } from '@agent-env/harness';
import {
  agentParamsSpecSchema,
  type AgentManifest,
  type AgentParamsSpec,
} from '@agent-env/shared';

/** Directories under agents/ that are not runnable agent packages. */
const SKIP_DIR_NAMES = new Set(['dev-env', 'node_modules', 'dist']);

export interface DiscoverAgentsOptions {
  /** Absolute or cwd-relative path to the agents/ directory. */
  agentsDir: string;
  /** Repo root for relative entry/paramsFile paths. Defaults to parent of agentsDir. */
  repoRoot?: string;
}

/**
 * Filesystem package resolved by convention:
 *
 *   agents/<id>/agent.ts          (required)
 *   agents/<id>/params.yaml       (optional)
 */
export interface ResolvedAgentPackage {
  id: string;
  dir: string;
  entry: string;
  paramsFile?: string;
  params: AgentParamsSpec;
  manifest: AgentManifest;
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

/**
 * Discover agents by filesystem convention (repo-local — never in packages/*).
 * Directories without `agent.ts` are skipped. `params.yaml` is optional.
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
  const agentsDir = resolve(options.agentsDir);
  const repoRoot = resolve(options.repoRoot ?? join(agentsDir, '..'));
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
