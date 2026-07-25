import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  loadAgentParamsFile,
  parseEvaluationSpec,
  parseRunSpec,
  type AgentDefinition,
} from '@agent-env/harness';
import type {
  AgentManifest,
  AgentParamsSpec,
  EvaluationSpec,
  RunSpec,
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
 *   agents/<id>/agent.ts
 *   agents/<id>/params.yaml
 *   agents/<id>/runspec.json
 *   agents/<id>/evaluation.json
 */
export interface ResolvedAgentPackage {
  id: string;
  dir: string;
  entry: string;
  paramsFile: string;
  runSpecFile: string;
  evaluationFile: string;
  params: AgentParamsSpec;
  runSpec: RunSpec;
  evaluation: EvaluationSpec;
  manifest: AgentManifest;
}

/**
 * Discover agents by filesystem convention (repo-local — never in packages/*).
 * Missing any of the four canonical files skips the directory (unless
 * agent.ts+params exist but other files missing → throw to fail closed).
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
    const paramsAbs = join(dir, 'params.yaml');
    const runSpecAbs = join(dir, 'runspec.json');
    const evaluationAbs = join(dir, 'evaluation.json');

    const hasEntry = existsSync(entryAbs);
    const hasParams = existsSync(paramsAbs);
    if (!hasEntry && !hasParams) continue;
    if (!hasEntry || !hasParams) {
      throw new Error(
        `Agent "${name}" must include both agent.ts and params.yaml`,
      );
    }
    if (!existsSync(runSpecAbs)) {
      throw new Error(
        `Agent "${name}" missing required runspec.json (${toPosixRelative(repoRoot, runSpecAbs)})`,
      );
    }
    if (!existsSync(evaluationAbs)) {
      throw new Error(
        `Agent "${name}" missing required evaluation.json (${toPosixRelative(repoRoot, evaluationAbs)})`,
      );
    }

    const entry = toPosixRelative(repoRoot, entryAbs);
    const paramsFile = toPosixRelative(repoRoot, paramsAbs);
    const runSpecFile = toPosixRelative(repoRoot, runSpecAbs);
    const evaluationFile = toPosixRelative(repoRoot, evaluationAbs);

    const params = loadAgentParamsFile(paramsAbs);
    if (params.agentId !== name) {
      throw new Error(
        `params agentId "${params.agentId}" must match directory "${name}" (${paramsFile})`,
      );
    }

    const runSpec = parseRunSpec(
      JSON.parse(readFileSync(runSpecAbs, 'utf8')) as unknown,
    );
    const evaluation = parseEvaluationSpec(
      JSON.parse(readFileSync(evaluationAbs, 'utf8')) as unknown,
    );

    packages.push({
      id: name,
      dir,
      entry,
      paramsFile,
      runSpecFile,
      evaluationFile,
      params,
      runSpec,
      evaluation,
      manifest: {
        id: name,
        name: params.title ?? name,
        description: params.description ?? params.title ?? '',
        entry,
        paramsFile,
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
