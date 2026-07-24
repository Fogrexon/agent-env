import type { DataSourceConnector } from './types.js';

const connectors = new Map<string, DataSourceConnector>();

export function registerConnector(
  connector: DataSourceConnector,
  options: { replace?: boolean } = {},
): void {
  if (!options.replace && connectors.has(connector.meta.id)) {
    throw new Error(
      `Connector "${connector.meta.id}" already registered. Pass { replace: true } to override.`,
    );
  }
  connectors.set(connector.meta.id, connector);
}

export function getConnector(id: string): DataSourceConnector {
  const connector = connectors.get(id);
  if (!connector) {
    const known = [...connectors.keys()].sort().join(', ') || '(none)';
    throw new Error(`Unknown connector "${id}". Registered: ${known}`);
  }
  return connector;
}

export function hasConnector(id: string): boolean {
  return connectors.has(id);
}

export function listConnectors(): readonly DataSourceConnector[] {
  return [...connectors.values()];
}

export function clearConnectors(): void {
  connectors.clear();
}
