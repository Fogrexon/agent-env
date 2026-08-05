/**
 * Env wiring + discovery for agents/scripts in this repo — not part of @agent-env/* packages.
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
  DEFAULT_HOST_EXECUTION_LIMITS,
} from './execution-policy.js';
export {
  buildRunRequestFromValues,
  defaultValuesFromParams,
  runDiscoveredAgent,
  type RunDiscoveredAgentOptions,
  type RunDiscoveredAgentResult,
} from './run-discovered-agent.js';
