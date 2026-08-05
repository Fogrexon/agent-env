import type { DataSourceKind } from '@agent-env/shared';

/** Recoverable metadata so graph inspectors can emit datasource nodes. */
export interface ConnectorToolMeta {
  connectorId: string;
  title: string;
  kind: DataSourceKind | string;
  tags?: string[];
  description?: string;
}

const META = new WeakMap<object, ConnectorToolMeta>();

export function attachConnectorToolMeta<T extends object>(
  tool: T,
  meta: ConnectorToolMeta,
): T {
  META.set(tool, meta);
  return tool;
}

export function getConnectorToolMeta(
  tool: object,
): ConnectorToolMeta | undefined {
  return META.get(tool);
}

/** Stable graph node id for a connector / datasource. */
export function datasourceNodeId(connectorId: string): string {
  return `ds:${connectorId}`;
}
