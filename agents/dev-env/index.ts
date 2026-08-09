/**
 * Execution-environment host wiring (discovery, env bootstrap, run entry).
 * Workflow definition packs under agents/<pack>/ only export agentDefinition —
 * they do not own the run loop.
 */
export {
  bootstrapProvidersFromEnv,
  loadDotEnv,
  parseOpenaiCompatibleProvidersJson,
  type OpenaiCompatibleEnvEntry,
} from './bootstrap.js';
export {
  defaultAgentParams,
  discoverAgents,
  getDiscoveredAgent,
  getResolvedAgentPackage,
  loadAgentDefinition,
  resolveAgentPackages,
  type DiscoverAgentsOptions,
  type ResolvedAgentPackage,
} from './catalog.js';
export {
  resolveAgentModeForId,
  resolvePackageAgentMode,
} from './agent-mode.js';
export {
  DEFAULT_HOST_EXECUTION_LIMITS,
} from './execution-policy.js';
export {
  deriveAgentPackInfo,
  discoveryFromHostPaths,
  resolveDiscoveryOptions,
  resolveHostPaths,
  type AgentPackInfo,
  type HostPaths,
  type ResolveHostPathsOptions,
} from './host-paths.js';
export {
  buildRunRequestFromValues,
  defaultValuesFromParams,
  runDiscoveredAgent,
  type RunDiscoveredAgentOptions,
  type RunDiscoveredAgentResult,
} from './run-discovered-agent.js';
