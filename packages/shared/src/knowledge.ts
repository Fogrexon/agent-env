import { z } from 'zod';

/** Stable knowledge collection / corpus identifier. */
export const knowledgeCollectionIdSchema = z.string().min(1).max(128);
export type KnowledgeCollectionId = z.infer<typeof knowledgeCollectionIdSchema>;

export const knowledgeChunkKindSchema = z.enum(['parent', 'child']);
export type KnowledgeChunkKind = z.infer<typeof knowledgeChunkKindSchema>;

export const knowledgeSourceKindSchema = z.enum([
  'markdown',
  'code',
  'text',
  'pdf',
  'json',
  'yaml',
  'other',
]);
export type KnowledgeSourceKind = z.infer<typeof knowledgeSourceKindSchema>;

/** ACL / routing metadata attached to every document and chunk. */
export const knowledgeAclSchema = z.object({
  namespaces: z.array(z.string().min(1)).default(['default']),
  /** When set, retrieval must match at least one of these labels. */
  labels: z.array(z.string().min(1)).default([]),
});
export type KnowledgeAcl = z.infer<typeof knowledgeAclSchema>;

export const knowledgeLocationSchema = z.object({
  /** Absolute or rooted source path / URI. */
  sourceUri: z.string().min(1),
  /** Relative path inside the collection root when applicable. */
  relPath: z.string().optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  startPage: z.number().int().positive().optional(),
  endPage: z.number().int().positive().optional(),
  headingPath: z.array(z.string()).default([]),
});
export type KnowledgeLocation = z.infer<typeof knowledgeLocationSchema>;

export const knowledgeDocumentSchema = z.object({
  id: z.string().min(1),
  collectionId: knowledgeCollectionIdSchema,
  title: z.string().min(1),
  sourceKind: knowledgeSourceKindSchema.default('other'),
  location: knowledgeLocationSchema,
  contentHash: z.string().min(8),
  byteLength: z.number().int().nonnegative(),
  mtimeMs: z.number().nonnegative().optional(),
  acl: knowledgeAclSchema.default({ namespaces: ['default'], labels: [] }),
  indexedAt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type KnowledgeDocument = z.infer<typeof knowledgeDocumentSchema>;

export const knowledgeChunkSchema = z.object({
  id: z.string().min(1),
  documentId: z.string().min(1),
  collectionId: knowledgeCollectionIdSchema,
  kind: knowledgeChunkKindSchema,
  /** Parent chunk id for child chunks; omitted for parents. */
  parentId: z.string().min(1).optional(),
  /** Deterministic situating prefix (path + title + heading chain). */
  contextPrefix: z.string().default(''),
  text: z.string().min(1),
  /** Text used for embedding / BM25 (prefix + text). */
  indexedText: z.string().min(1),
  location: knowledgeLocationSchema,
  contentHash: z.string().min(8),
  tokenCount: z.number().int().nonnegative().optional(),
  acl: knowledgeAclSchema.default({ namespaces: ['default'], labels: [] }),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

export const knowledgeCitationSchema = z.object({
  chunkId: z.string().min(1),
  documentId: z.string().min(1),
  collectionId: knowledgeCollectionIdSchema,
  title: z.string().min(1),
  /** Stable handle: knowledge://collection/document#chunk */
  uri: z.string().min(1),
  sourceUri: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  startPage: z.number().int().positive().optional(),
  endPage: z.number().int().positive().optional(),
  headingPath: z.array(z.string()).default([]),
  excerpt: z.string().min(1),
});
export type KnowledgeCitation = z.infer<typeof knowledgeCitationSchema>;

export const knowledgeHitSchema = z.object({
  chunk: knowledgeChunkSchema,
  score: z.number(),
  rank: z.number().int().positive(),
  channels: z
    .object({
      lexical: z.number().optional(),
      vector: z.number().optional(),
      fused: z.number().optional(),
      rerank: z.number().optional(),
    })
    .default({}),
  citation: knowledgeCitationSchema,
});
export type KnowledgeHit = z.infer<typeof knowledgeHitSchema>;

export const knowledgeMetadataFilterSchema = z.object({
  namespaces: z.array(z.string().min(1)).optional(),
  labelsAny: z.array(z.string().min(1)).optional(),
  labelsAll: z.array(z.string().min(1)).optional(),
  sourceKinds: z.array(knowledgeSourceKindSchema).optional(),
  documentIds: z.array(z.string().min(1)).optional(),
  relPathPrefix: z.string().optional(),
});
export type KnowledgeMetadataFilter = z.infer<
  typeof knowledgeMetadataFilterSchema
>;

export const knowledgeSearchModeSchema = z.enum([
  'hybrid',
  'lexical',
  'vector',
]);
export type KnowledgeSearchMode = z.infer<typeof knowledgeSearchModeSchema>;

export const knowledgeSearchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().min(1).max(50).default(8),
  candidateK: z.number().int().min(1).max(200).default(40),
  mode: knowledgeSearchModeSchema.default('hybrid'),
  filter: knowledgeMetadataFilterSchema.optional(),
  scoreThreshold: z.number().min(0).max(1).optional(),
  expandParent: z.boolean().default(true),
  mmrLambda: z.number().min(0).max(1).default(0.7),
});
export type KnowledgeSearchRequest = z.infer<typeof knowledgeSearchRequestSchema>;
export type KnowledgeSearchRequestInput = z.input<
  typeof knowledgeSearchRequestSchema
>;

export const knowledgeSearchResultSchema = z.object({
  query: z.string(),
  mode: knowledgeSearchModeSchema,
  vectorEnabled: z.boolean(),
  hits: z.array(knowledgeHitSchema),
  truncated: z.boolean().default(false),
  latencyMs: z.number().nonnegative().optional(),
});
export type KnowledgeSearchResult = z.infer<typeof knowledgeSearchResultSchema>;

export const knowledgeSyncActionSchema = z.enum([
  'added',
  'updated',
  'unchanged',
  'deleted',
  'skipped',
  'failed',
]);
export type KnowledgeSyncAction = z.infer<typeof knowledgeSyncActionSchema>;

export const knowledgeSyncItemSchema = z.object({
  documentId: z.string().min(1),
  sourceUri: z.string().min(1),
  action: knowledgeSyncActionSchema,
  reason: z.string().optional(),
  chunkCount: z.number().int().nonnegative().optional(),
});
export type KnowledgeSyncItem = z.infer<typeof knowledgeSyncItemSchema>;

export const knowledgeSyncReportSchema = z.object({
  collectionId: knowledgeCollectionIdSchema,
  indexPath: z.string().min(1),
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  embeddingModel: z.string().optional(),
  embeddingDimension: z.number().int().positive().optional(),
  items: z.array(knowledgeSyncItemSchema),
  totals: z.object({
    added: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});
export type KnowledgeSyncReport = z.infer<typeof knowledgeSyncReportSchema>;

export const knowledgeIndexStatusSchema = z.object({
  collectionId: knowledgeCollectionIdSchema,
  indexPath: z.string().min(1),
  documentCount: z.number().int().nonnegative(),
  chunkCount: z.number().int().nonnegative(),
  vectorEnabled: z.boolean(),
  embeddingModel: z.string().optional(),
  embeddingDimension: z.number().int().positive().optional(),
  indexVersion: z.string().min(1),
  lastSyncedAt: z.string().optional(),
});
export type KnowledgeIndexStatus = z.infer<typeof knowledgeIndexStatusSchema>;

export const knowledgeClaimSchema = z.object({
  claim: z.string().min(1),
  citationUris: z.array(z.string().min(1)).default([]),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
});
export type KnowledgeClaim = z.infer<typeof knowledgeClaimSchema>;

export const knowledgeEvidenceLedgerSchema = z.object({
  query: z.string().min(1),
  status: z.enum(['ok', 'insufficient_evidence', 'error']).default('ok'),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  claims: z.array(knowledgeClaimSchema).default([]),
  citations: z.array(knowledgeCitationSchema).default([]),
  gaps: z.array(z.string()).default([]),
  iterations: z.number().int().nonnegative().default(0),
  notes: z.string().optional(),
});
export type KnowledgeEvidenceLedger = z.infer<
  typeof knowledgeEvidenceLedgerSchema
>;

export const knowledgeGoldenQuerySchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  relevantDocumentIds: z.array(z.string().min(1)).default([]),
  relevantChunkIds: z.array(z.string().min(1)).default([]),
  relevantSourceUris: z.array(z.string().min(1)).default([]),
  expectedClaims: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});
export type KnowledgeGoldenQuery = z.infer<typeof knowledgeGoldenQuerySchema>;

export const knowledgeRetrievalMetricsSchema = z.object({
  queryCount: z.number().int().nonnegative(),
  recallAtK: z.number().min(0).max(1),
  mrr: z.number().min(0).max(1),
  ndcgAtK: z.number().min(0).max(1),
  citationCoverage: z.number().min(0).max(1).optional(),
  meanLatencyMs: z.number().nonnegative().optional(),
  k: z.number().int().positive(),
});
export type KnowledgeRetrievalMetrics = z.infer<
  typeof knowledgeRetrievalMetricsSchema
>;

/** Build a stable knowledge URI for citations. */
export function knowledgeChunkUri(
  collectionId: string,
  documentId: string,
  chunkId: string,
): string {
  return `knowledge://${collectionId}/${documentId}#${chunkId}`;
}
