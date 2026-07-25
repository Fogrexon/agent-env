/**
 * Shared repo paths for scripts/* (not packages).
 * Agent discovery lives in @agent-env/repo-env (= agents/dev-env).
 */
import { resolve } from 'node:path';
import {
  discoverAgents,
  getDiscoveredAgent,
  type DiscoverAgentsOptions,
} from '@agent-env/repo-env';
import type { AgentManifest } from '@agent-env/shared';

export function repoRoot(cwd: string = process.cwd()): string {
  return resolve(cwd);
}

export function agentsDir(cwd: string = process.cwd()): string {
  return resolve(cwd, 'agents');
}

export function discoveryOptions(
  cwd: string = process.cwd(),
): DiscoverAgentsOptions {
  return { agentsDir: agentsDir(cwd), repoRoot: repoRoot(cwd) };
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
