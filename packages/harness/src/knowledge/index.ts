export {
  KNOWLEDGE_INDEX_VERSION,
  type CreateKnowledgeBaseOptions,
  type EmbeddingProvider,
  type KnowledgeBase,
  type KnowledgeContextualizer,
  type KnowledgeReranker,
  type KnowledgeStore,
  type KnowledgeStoreSearchOptions,
} from './types.js';
export { tokenize, tokenizeUnique, approxTokenCount } from './tokenize.js';
export { sha256Hex, stableChunkId, stableDocumentId } from './hash.js';
export { Bm25Index, type Bm25Document, type Bm25Hit } from './bm25.js';
export {
  bufferToFloat32,
  cosineSimilarity,
  float32ToBuffer,
  l2Normalize,
  maximalMarginalRelevance,
  reciprocalRankFusion,
  type RankedId,
} from './vector.js';
export {
  chunkDocument,
  citationFromChunk,
  inferSourceKind,
  type ChunkerInput,
  type ChunkerResult,
} from './chunker.js';
export {
  createDeterministicEmbedder,
  createGeminiEmbedder,
  createOpenaiCompatibleEmbedder,
  type CreateDeterministicEmbedderOptions,
  type CreateGeminiEmbedderOptions,
  type CreateOpenaiCompatibleEmbedderOptions,
} from './embeddings.js';
export {
  createSqliteKnowledgeStore,
  type CreateSqliteKnowledgeStoreOptions,
} from './store.js';
export {
  createKnowledgeBase,
  formatKnowledgeHitsAsUntrusted,
} from './pipeline.js';
export {
  createKnowledgeTools,
  type CreateKnowledgeToolsOptions,
  type KnowledgeTools,
} from './tools.js';
export {
  createKnowledgeConnector,
  type CreateKnowledgeConnectorOptions,
} from './connector.js';
export {
  citationCoverage,
  evaluateRetrievalRun,
  judgementFromHits,
  meanReciprocalRank,
  ndcgAtK,
  recallAtK,
  type RetrievalJudgement,
} from './evaluation.js';
export {
  createKnowledgeSearchAgentTool,
  type CreateKnowledgeSearchAgentToolOptions,
} from './agentic-search.js';
