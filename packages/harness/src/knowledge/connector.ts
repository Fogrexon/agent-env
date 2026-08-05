import type { EvidenceBundle } from '@agent-env/shared';
import {
  createSearchConnector,
  toEvidenceItems,
  type DataSourceConnector,
} from '../connectors/types.js';
import type { KnowledgeBase } from './types.js';

export interface CreateKnowledgeConnectorOptions {
  id?: string;
  title?: string;
  description?: string;
  knowledgeBase: KnowledgeBase;
  topK?: number;
  tags?: string[];
}

/** Expose a KnowledgeBase as a DataSourceConnector → EvidenceBundle. */
export function createKnowledgeConnector(
  options: CreateKnowledgeConnectorOptions,
): DataSourceConnector {
  const id = options.id ?? `knowledge_${options.knowledgeBase.collectionId}`;
  return createSearchConnector({
    id,
    title: options.title ?? `Knowledge (${options.knowledgeBase.collectionId})`,
    description:
      options.description ??
      'Local hybrid knowledge search over an indexed corpus.',
    kind: 'knowledge',
    tags: options.tags ?? ['knowledge', 'rag'],
    publicConfig: {
      collectionId: options.knowledgeBase.collectionId,
      vectorEnabled: options.knowledgeBase.vectorEnabled,
    },
    search: async (input): Promise<EvidenceBundle> => {
      const result = await options.knowledgeBase.search({
        query: input.query,
        topK: input.limit ?? options.topK ?? 8,
        mode: 'hybrid',
        expandParent: true,
      });
      return {
        sourceId: id,
        query: input.query,
        items: toEvidenceItems(
          id,
          result.hits.map((hit) => ({
            title: hit.citation.title,
            snippet: [
              `CITATION ${hit.citation.uri}`,
              hit.citation.startLine != null
                ? `lines ${hit.citation.startLine}-${hit.citation.endLine ?? hit.citation.startLine}`
                : undefined,
              hit.chunk.text.slice(0, 800),
            ]
              .filter(Boolean)
              .join('\n'),
            uri: hit.citation.uri,
            score: hit.score,
          })),
        ),
      };
    },
  });
}
