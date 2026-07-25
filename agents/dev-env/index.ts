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
  discoverAgents,
  getDiscoveredAgent,
  getResolvedAgentPackage,
  loadAgentDefinition,
  resolveAgentPackages,
  type DiscoverAgentsOptions,
  type ResolvedAgentPackage,
} from './catalog.js';
export {
  buildRunRequestFromValues,
  defaultValuesFromParams,
  runDiscoveredAgent,
  type RunDiscoveredAgentOptions,
  type RunDiscoveredAgentResult,
} from './run-discovered-agent.js';
