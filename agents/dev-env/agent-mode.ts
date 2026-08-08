import { resolveAgentMode } from '@agent-env/harness';
import type { AgentMode } from '@agent-env/shared';
import {
  getResolvedAgentPackage,
  loadAgentDefinition,
  type DiscoverAgentsOptions,
  type ResolvedAgentPackage,
} from './catalog.js';

export async function resolvePackageAgentMode(
  pkg: ResolvedAgentPackage,
  cwd: string,
): Promise<AgentMode> {
  const definition = await loadAgentDefinition(pkg.entry, cwd);
  return resolveAgentMode(definition);
}

export async function resolveAgentModeForId(
  options: DiscoverAgentsOptions,
  agentId: string,
  cwd: string,
): Promise<AgentMode | undefined> {
  const pkg = getResolvedAgentPackage(options, agentId);
  if (!pkg) return undefined;
  return resolvePackageAgentMode(pkg, cwd);
}
