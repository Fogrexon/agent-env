import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeHit,
  KnowledgeIndexStatus,
  KnowledgeMetadataFilter,
} from '@agent-env/shared';
import {
  knowledgeChunkSchema,
  knowledgeDocumentSchema,
} from '@agent-env/shared';
import { Bm25Index } from './bm25.js';
import { citationFromChunk } from './chunker.js';
import {
  KNOWLEDGE_INDEX_VERSION,
  type KnowledgeStore,
  type KnowledgeStoreSearchOptions,
} from './types.js';
import {
  bufferToFloat32,
  cosineSimilarity,
  float32ToBuffer,
} from './vector.js';

type DatabaseSync = import('node:sqlite').DatabaseSync;

const requireSqlite = createRequire(import.meta.url);

export interface CreateSqliteKnowledgeStoreOptions {
  collectionId: string;
  indexPath: string;
}

type MetaRow = {
  collection_id: string;
  index_version: string;
  embedding_model: string | null;
  embedding_dimension: number | null;
  last_synced_at: string | null;
};

/**
 * Local KnowledgeStore backed by node:sqlite.
 * Lexical search uses in-process BM25 (not FTS5) for Node build portability.
 * Vectors are stored as BLOB Float32 arrays and scanned with cosine similarity.
 */
export function createSqliteKnowledgeStore(
  options: CreateSqliteKnowledgeStoreOptions,
): KnowledgeStore {
  // Lazy load so unrelated harness consumers do not touch experimental sqlite.
  const { DatabaseSync } = requireSqlite('node:sqlite') as typeof import('node:sqlite');
  mkdirSync(dirname(options.indexPath), { recursive: true });
  const db = new DatabaseSync(options.indexPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);

  const meta = getMeta(db);
  if (meta.collection_id !== options.collectionId) {
    if (meta.collection_id && meta.collection_id !== options.collectionId) {
      throw new Error(
        `Index collection mismatch: file has "${meta.collection_id}", expected "${options.collectionId}"`,
      );
    }
    setMeta(db, {
      collectionId: options.collectionId,
      indexVersion: KNOWLEDGE_INDEX_VERSION,
      embeddingModel: meta.embedding_model,
      embeddingDimension: meta.embedding_dimension,
      lastSyncedAt: meta.last_synced_at,
    });
  }
  if (meta.index_version && meta.index_version !== KNOWLEDGE_INDEX_VERSION) {
    throw new Error(
      `Index version mismatch: ${meta.index_version} != ${KNOWLEDGE_INDEX_VERSION}; rebuild required`,
    );
  }

  const bm25 = new Bm25Index();
  const embeddings = new Map<string, Float32Array>();
  reloadSearchIndexes(db, bm25, embeddings);

  const store: KnowledgeStore = {
    collectionId: options.collectionId,
    indexPath: options.indexPath,

    status() {
      const m = getMeta(db);
      const documentCount = Number(
        (
          db.prepare('SELECT COUNT(*) AS c FROM documents').get() as {
            c: number;
          }
        ).c,
      );
      const chunkCount = Number(
        (db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number })
          .c,
      );
      return {
        collectionId: options.collectionId,
        indexPath: options.indexPath,
        documentCount,
        chunkCount,
        vectorEnabled: Boolean(m.embedding_model && m.embedding_dimension),
        embeddingModel: m.embedding_model ?? undefined,
        embeddingDimension: m.embedding_dimension ?? undefined,
        indexVersion: m.index_version || KNOWLEDGE_INDEX_VERSION,
        lastSyncedAt: m.last_synced_at ?? undefined,
      };
    },

    listDocuments() {
      const rows = db
        .prepare('SELECT payload_json FROM documents ORDER BY id')
        .all() as Array<{ payload_json: string }>;
      return rows.map((r) =>
        knowledgeDocumentSchema.parse(JSON.parse(r.payload_json)),
      );
    },

    getDocument(id) {
      const row = db
        .prepare('SELECT payload_json FROM documents WHERE id = ?')
        .get(id) as { payload_json: string } | undefined;
      if (!row) return undefined;
      return knowledgeDocumentSchema.parse(JSON.parse(row.payload_json));
    },

    getChunk(id) {
      const row = db
        .prepare('SELECT payload_json FROM chunks WHERE id = ?')
        .get(id) as { payload_json: string } | undefined;
      if (!row) return undefined;
      return knowledgeChunkSchema.parse(JSON.parse(row.payload_json));
    },

    getParentOf(chunkId) {
      const chunk = store.getChunk(chunkId);
      if (!chunk?.parentId) return undefined;
      return store.getChunk(chunk.parentId);
    },

    upsertDocument({ document, chunks, embeddings: emb }) {
      const parsedDoc = knowledgeDocumentSchema.parse(document);
      const parsedChunks = chunks.map((c) => knowledgeChunkSchema.parse(c));
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(
          parsedDoc.id,
        );
        db.prepare('DELETE FROM chunks WHERE document_id = ?').run(parsedDoc.id);
        db.prepare(
          `INSERT INTO documents (id, collection_id, content_hash, source_uri, payload_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             content_hash = excluded.content_hash,
             source_uri = excluded.source_uri,
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`,
        ).run(
          parsedDoc.id,
          parsedDoc.collectionId,
          parsedDoc.contentHash,
          parsedDoc.location.sourceUri,
          JSON.stringify(parsedDoc),
          parsedDoc.indexedAt,
        );

        const insertChunk = db.prepare(
          `INSERT INTO chunks (
             id, document_id, collection_id, kind, parent_id, content_hash, payload_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const chunk of parsedChunks) {
          insertChunk.run(
            chunk.id,
            chunk.documentId,
            chunk.collectionId,
            chunk.kind,
            chunk.parentId ?? null,
            chunk.contentHash,
            JSON.stringify(chunk),
          );
        }

        if (emb && emb.size > 0) {
          const insertEmb = db.prepare(
            `INSERT INTO embeddings (chunk_id, document_id, dimension, vector)
             VALUES (?, ?, ?, ?)`,
          );
          for (const [chunkId, vector] of emb) {
            insertEmb.run(
              chunkId,
              parsedDoc.id,
              vector.length,
              float32ToBuffer(vector),
            );
          }
        }

        db.prepare(
          `UPDATE meta SET last_synced_at = ? WHERE id = 1`,
        ).run(new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      reloadDocumentIntoSearch(db, parsedDoc.id, bm25, embeddings);
    },

    deleteDocument(id) {
      const chunkRows = db
        .prepare('SELECT id FROM chunks WHERE document_id = ?')
        .all(id) as Array<{ id: string }>;
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM embeddings WHERE document_id = ?').run(id);
        db.prepare('DELETE FROM chunks WHERE document_id = ?').run(id);
        db.prepare('DELETE FROM documents WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      for (const row of chunkRows) {
        bm25.remove(row.id);
        embeddings.delete(row.id);
      }
    },

    searchLexical(query, options) {
      const childOnly = options.childOnly !== false;
      const hits = bm25.search(query, Math.max(options.limit * 4, 40));
      return materializeHits(db, hits, {
        limit: options.limit,
        filter: options.filter,
        childOnly,
        channel: 'lexical',
      });
    },

    searchVector(queryEmbedding, options) {
      const childOnly = options.childOnly !== false;
      const scored: Array<{ id: string; score: number }> = [];
      for (const [id, vector] of embeddings) {
        const chunk = store.getChunk(id);
        if (!chunk) continue;
        if (childOnly && chunk.kind !== 'child') continue;
        if (!passesFilter(chunk, store.getDocument(chunk.documentId), options.filter)) {
          continue;
        }
        scored.push({
          id,
          score: cosineSimilarity(queryEmbedding, vector),
        });
      }
      scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return materializeHits(db, scored.slice(0, options.limit * 2), {
        limit: options.limit,
        filter: options.filter,
        childOnly,
        channel: 'vector',
      });
    },

    setEmbeddingMeta(metaInfo) {
      const current = getMeta(db);
      if (
        metaInfo &&
        current.embedding_model &&
        current.embedding_dimension &&
        (current.embedding_model !== metaInfo.model ||
          current.embedding_dimension !== metaInfo.dimension)
      ) {
        throw new Error(
          `Embedding model/dimension changed (${current.embedding_model}@${current.embedding_dimension} → ${metaInfo.model}@${metaInfo.dimension}); rebuild index`,
        );
      }
      setMeta(db, {
        collectionId: options.collectionId,
        indexVersion: KNOWLEDGE_INDEX_VERSION,
        embeddingModel: metaInfo?.model ?? null,
        embeddingDimension: metaInfo?.dimension ?? null,
        lastSyncedAt: current.last_synced_at,
      });
    },

    close() {
      db.close();
      bm25.clear();
      embeddings.clear();
    },
  };

  return store;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      collection_id TEXT NOT NULL,
      index_version TEXT NOT NULL,
      embedding_model TEXT,
      embedding_dimension INTEGER,
      last_synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      source_uri TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      parent_id TEXT,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
    CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id);
    CREATE TABLE IF NOT EXISTS embeddings (
      chunk_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      vector BLOB NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
  `);
  const row = db.prepare('SELECT COUNT(*) AS c FROM meta').get() as {
    c: number;
  };
  if (Number(row.c) === 0) {
    db.prepare(
      `INSERT INTO meta (id, collection_id, index_version, embedding_model, embedding_dimension, last_synced_at)
       VALUES (1, '', ?, NULL, NULL, NULL)`,
    ).run(KNOWLEDGE_INDEX_VERSION);
  }
}

function getMeta(db: DatabaseSync): MetaRow {
  return db.prepare('SELECT * FROM meta WHERE id = 1').get() as MetaRow;
}

function setMeta(
  db: DatabaseSync,
  input: {
    collectionId: string;
    indexVersion: string;
    embeddingModel: string | null;
    embeddingDimension: number | null;
    lastSyncedAt: string | null;
  },
): void {
  db.prepare(
    `UPDATE meta SET
       collection_id = ?,
       index_version = ?,
       embedding_model = ?,
       embedding_dimension = ?,
       last_synced_at = ?
     WHERE id = 1`,
  ).run(
    input.collectionId,
    input.indexVersion,
    input.embeddingModel,
    input.embeddingDimension,
    input.lastSyncedAt,
  );
}

function reloadSearchIndexes(
  db: DatabaseSync,
  bm25: Bm25Index,
  embeddings: Map<string, Float32Array>,
): void {
  bm25.clear();
  embeddings.clear();
  const chunkRows = db
    .prepare('SELECT payload_json FROM chunks')
    .all() as Array<{ payload_json: string }>;
  for (const row of chunkRows) {
    const chunk = knowledgeChunkSchema.parse(JSON.parse(row.payload_json));
    if (chunk.kind === 'child') bm25.upsert(chunk.id, chunk.indexedText);
  }
  const embRows = db
    .prepare('SELECT chunk_id, vector FROM embeddings')
    .all() as Array<{ chunk_id: string; vector: Buffer }>;
  for (const row of embRows) {
    embeddings.set(row.chunk_id, bufferToFloat32(row.vector));
  }
}

function reloadDocumentIntoSearch(
  db: DatabaseSync,
  documentId: string,
  bm25: Bm25Index,
  embeddings: Map<string, Float32Array>,
): void {
  const chunkRows = db
    .prepare('SELECT id, payload_json FROM chunks WHERE document_id = ?')
    .all(documentId) as Array<{ id: string; payload_json: string }>;
  for (const row of chunkRows) {
    bm25.remove(row.id);
    embeddings.delete(row.id);
  }
  for (const row of chunkRows) {
    const chunk = knowledgeChunkSchema.parse(JSON.parse(row.payload_json));
    if (chunk.kind === 'child') bm25.upsert(chunk.id, chunk.indexedText);
  }
  const embRows = db
    .prepare('SELECT chunk_id, vector FROM embeddings WHERE document_id = ?')
    .all(documentId) as Array<{ chunk_id: string; vector: Buffer }>;
  for (const row of embRows) {
    embeddings.set(row.chunk_id, bufferToFloat32(row.vector));
  }
}

function passesFilter(
  chunk: KnowledgeChunk,
  document: KnowledgeDocument | undefined,
  filter?: KnowledgeMetadataFilter,
): boolean {
  if (!filter) return true;
  const acl = chunk.acl;
  if (filter.namespaces && filter.namespaces.length > 0) {
    if (!filter.namespaces.some((ns) => acl.namespaces.includes(ns))) {
      return false;
    }
  }
  if (filter.labelsAny && filter.labelsAny.length > 0) {
    if (!filter.labelsAny.some((l) => acl.labels.includes(l))) return false;
  }
  if (filter.labelsAll && filter.labelsAll.length > 0) {
    if (!filter.labelsAll.every((l) => acl.labels.includes(l))) return false;
  }
  if (filter.documentIds && filter.documentIds.length > 0) {
    if (!filter.documentIds.includes(chunk.documentId)) return false;
  }
  if (filter.sourceKinds && filter.sourceKinds.length > 0) {
    const kind = document?.sourceKind;
    if (!kind || !filter.sourceKinds.includes(kind)) return false;
  }
  if (filter.relPathPrefix) {
    const rel = chunk.location.relPath ?? '';
    if (!rel.startsWith(filter.relPathPrefix.replace(/\\/g, '/'))) return false;
  }
  return true;
}

function materializeHits(
  db: DatabaseSync,
  ranked: Array<{ id: string; score: number }>,
  options: {
    limit: number;
    filter?: KnowledgeMetadataFilter;
    childOnly: boolean;
    channel: 'lexical' | 'vector';
  },
): KnowledgeHit[] {
  const out: KnowledgeHit[] = [];
  for (const item of ranked) {
    const row = db
      .prepare('SELECT payload_json FROM chunks WHERE id = ?')
      .get(item.id) as { payload_json: string } | undefined;
    if (!row) continue;
    const chunk = knowledgeChunkSchema.parse(JSON.parse(row.payload_json));
    if (options.childOnly && chunk.kind !== 'child') continue;
    const docRow = db
      .prepare('SELECT payload_json FROM documents WHERE id = ?')
      .get(chunk.documentId) as { payload_json: string } | undefined;
    const document = docRow
      ? knowledgeDocumentSchema.parse(JSON.parse(docRow.payload_json))
      : undefined;
    if (!passesFilter(chunk, document, options.filter)) continue;
    const citation = citationFromChunk(chunk, document);
    out.push({
      chunk,
      score: item.score,
      rank: out.length + 1,
      channels: {
        [options.channel]: item.score,
      },
      citation,
    });
    if (out.length >= options.limit) break;
  }
  return out;
}
