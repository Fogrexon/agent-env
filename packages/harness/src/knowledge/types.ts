import type {
  KnowledgeChunk,
  KnowledgeCitation,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndexStatus,
  KnowledgeMetadataFilter,
  KnowledgeSearchRequestInput,
  KnowledgeSearchResult,
  KnowledgeSyncReport,
} from '@agent-env/shared';

export const KNOWLEDGE_INDEX_VERSION = 'knowledge-index/v1';

export interface EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface KnowledgeReranker {
  readonly id: string;
  rerank(
    query: string,
    hits: readonly KnowledgeHit[],
    limit: number,
  ): Promise<KnowledgeHit[]> | KnowledgeHit[];
}

export interface KnowledgeContextualizer {
  readonly id: string;
  /**
   * Optional LLM-generated situating context for a chunk.
   * Deterministic path/title/heading prefix is always applied separately.
   */
  situate(input: {
    document: KnowledgeDocument;
    chunkText: string;
    headingPath: readonly string[];
  }): Promise<string> | string;
}

export interface KnowledgeStoreSearchOptions {
  limit: number;
  filter?: KnowledgeMetadataFilter;
  /** Search child chunks only (default true). */
  childOnly?: boolean;
}

export interface KnowledgeStore {
  readonly collectionId: string;
  readonly indexPath: string;
  status(): KnowledgeIndexStatus;
  listDocuments(): KnowledgeDocument[];
  getDocument(id: string): KnowledgeDocument | undefined;
  getChunk(id: string): KnowledgeChunk | undefined;
  getParentOf(chunkId: string): KnowledgeChunk | undefined;
  upsertDocument(input: {
    document: KnowledgeDocument;
    chunks: readonly KnowledgeChunk[];
    embeddings?: ReadonlyMap<string, Float32Array>;
  }): void;
  deleteDocument(id: string): void;
  searchLexical(
    query: string,
    options: KnowledgeStoreSearchOptions,
  ): KnowledgeHit[];
  searchVector(
    queryEmbedding: Float32Array,
    options: KnowledgeStoreSearchOptions,
  ): KnowledgeHit[];
  setEmbeddingMeta(meta: {
    model: string;
    dimension: number;
  } | null): void;
  close(): void;
}

export interface KnowledgeBase {
  readonly collectionId: string;
  readonly indexPath: string;
  readonly vectorEnabled: boolean;
  status(): KnowledgeIndexStatus;
  sync(options?: {
    roots?: readonly string[];
    /** When true, remove indexed docs no longer present under roots. */
    pruneMissing?: boolean;
  }): Promise<KnowledgeSyncReport>;
  search(
    request: KnowledgeSearchRequestInput,
  ): Promise<KnowledgeSearchResult>;
  get(chunkId: string): {
    chunk: KnowledgeChunk;
    document?: KnowledgeDocument;
    citation: KnowledgeCitation;
    parent?: KnowledgeChunk;
  } | null;
  close(): void;
}

export interface CreateKnowledgeBaseOptions {
  collectionId: string;
  /** Absolute path to the SQLite index file. */
  indexPath: string;
  /** Absolute roots to scan on sync. */
  roots: readonly string[] | (() => readonly string[]);
  embedder?: EmbeddingProvider;
  reranker?: KnowledgeReranker;
  contextualizer?: KnowledgeContextualizer;
  /** Glob patterns relative to each root (posix). Default: common text/code. */
  includeGlobs?: readonly string[];
  excludeGlobs?: readonly string[];
  maxFileBytes?: number;
  namespaces?: readonly string[];
  labels?: readonly string[];
}
