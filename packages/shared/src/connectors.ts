import { z } from 'zod';
import { toolContractSchema } from './run-spec.js';

/** Logical data-source kinds (extend as needed). */
export const dataSourceKindSchema = z.enum([
  'memory',
  'http',
  'github',
  'filesystem',
  'custom',
]);
export type DataSourceKind = z.infer<typeof dataSourceKindSchema>;

/**
 * Connector declaration — authority + discovery metadata for a data source.
 * Secrets are NOT stored here; inject them when creating the connector instance.
 */
export const dataSourceConnectorSchema = z.object({
  id: z.string().min(1),
  kind: dataSourceKindSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  /** Tool contract used when this connector is exposed to agents. */
  contract: toolContractSchema,
  /** Optional tags for routing / UI (e.g. crm, docs, ops). */
  tags: z.array(z.string()).default([]),
});
export type DataSourceConnectorMeta = z.infer<typeof dataSourceConnectorSchema>;

/** A single gathered evidence item from a connector. */
export const evidenceItemSchema = z.object({
  sourceId: z.string().min(1),
  title: z.string().min(1),
  snippet: z.string().min(1),
  uri: z.string().optional(),
  score: z.number().optional(),
  retrievedAt: z.string().optional(),
});
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const evidenceBundleSchema = z.object({
  sourceId: z.string().min(1),
  query: z.string(),
  items: z.array(evidenceItemSchema),
});
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
