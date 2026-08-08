/**
 * Shared host paths for scripts/* (not packages).
 * Agent discovery lives in @agent-env/repo-env (= agents/dev-env).
 */
import {
  discoverAgents,
  getDiscoveredAgent,
  resolveDiscoveryOptions,
  resolveHostPaths,
  type DiscoverAgentsOptions,
  type HostPaths,
} from '@agent-env/repo-env';
import type { AgentManifest } from '@agent-env/shared';

export function hostPaths(cwd: string = process.cwd()): HostPaths {
  return resolveHostPaths({ fallbackRoot: cwd });
}

export function repoRoot(cwd: string = process.cwd()): string {
  return hostPaths(cwd).root;
}

export function agentsDir(cwd: string = process.cwd()): string {
  return hostPaths(cwd).builtinAgentsDir;
}

export function discoveryOptions(
  cwd: string = process.cwd(),
): DiscoverAgentsOptions {
  return resolveDiscoveryOptions({ fallbackRoot: cwd });
}

export function listAgents(cwd: string = process.cwd()): readonly AgentManifest[] {
  return discoverAgents(discoveryOptions(cwd));
}

export function findAgent(
  id: string,
  cwd: string = process.cwd(),
): AgentManifest | undefined {
  return getDiscoveredAgent(discoveryOptions(cwd), id);
}
