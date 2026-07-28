import {
  memoryCandidateSchema,
  memoryEntrySchema,
  memoryOperationSchema,
  type MemoryCandidate,
  type MemoryEntry,
  type MemoryOperation,
} from '@agent-env/shared';

export type MemoryExtractor = (
  text: string,
  meta?: { scope?: string; sourceUri?: string },
) => MemoryCandidate[];

export type MemoryRetriever = (
  entries: readonly MemoryEntry[],
  query: string,
  opts: { scope?: string; limit: number },
) => MemoryEntry[];

export interface CreateAgentMemoryStoreOptions {
  /** Default scope for new entries. */
  defaultScope?: string;
  extract?: MemoryExtractor;
  retrieve?: MemoryRetriever;
  /** Clock for tests. */
  now?: () => Date;
  /** Id factory for tests. */
  newId?: () => string;
}

export interface MemoryApplyResult {
  op: MemoryOperation['op'];
  entry?: MemoryEntry;
  message?: string;
}

export interface AgentMemoryStore {
  /** Extract candidates (proposed) without accepting them. */
  extract(
    text: string,
    meta?: { scope?: string; sourceUri?: string },
  ): MemoryCandidate[];
  /** Stage a candidate as proposed. */
  propose(candidate: MemoryCandidate): MemoryEntry;
  /** Mark proposed → validated (fail if missing / wrong status). */
  validate(id: string): MemoryEntry;
  /** Mark validated → accepted (searchable). */
  accept(id: string): MemoryEntry;
  /** Apply a typed CRUD op. ADD creates as proposed unless acceptImmediately. */
  apply(
    operation: MemoryOperation,
    opts?: { acceptImmediately?: boolean },
  ): MemoryApplyResult;
  /** Retrieve only accepted entries (default). */
  retrieve(
    query: string,
    opts?: { scope?: string; limit?: number; includeStatuses?: MemoryEntry['status'][] },
  ): MemoryEntry[];
  get(id: string): MemoryEntry | undefined;
  list(opts?: {
    scope?: string;
    status?: MemoryEntry['status'];
  }): MemoryEntry[];
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9ぁ-んァ-ヶ一-龥]+/i)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2),
  );
}

/** Deterministic token-overlap retriever (no embeddings). */
export function tokenOverlapRetriever(
  entries: readonly MemoryEntry[],
  query: string,
  opts: { scope?: string; limit: number },
): MemoryEntry[] {
  const q = tokenize(query);
  const scored = entries
    .filter((e) => (opts.scope ? e.scope === opts.scope : true))
    .map((e) => {
      const tokens = tokenize(e.content);
      let overlap = 0;
      for (const t of q) {
        if (tokens.has(t)) overlap += 1;
      }
      // Exact substring / id boost
      if (e.id === query || e.content.toLowerCase().includes(query.toLowerCase())) {
        overlap += 10;
      }
      return { e, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.e.id.localeCompare(b.e.id));

  return scored.slice(0, opts.limit).map((s) => s.e);
}

/**
 * Heuristic extractor: split on newlines / bullets into short fact candidates.
 * Replace with an LLM extractor later; keep the MemoryCandidate contract.
 */
export function defaultHeuristicExtractor(
  text: string,
  meta?: { scope?: string; sourceUri?: string },
): MemoryCandidate[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter((l) => l.length >= 12 && l.length <= 400);

  const seen = new Set<string>();
  const out: MemoryCandidate[] = [];
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      memoryCandidateSchema.parse({
        content: line,
        kind: 'fact',
        scope: meta?.scope ?? 'default',
        tags: [],
        ...(meta?.sourceUri
          ? { source: { uri: meta.sourceUri } }
          : {}),
      }),
    );
  }
  return out;
}

/**
 * In-memory agent memory store (Mem0-shaped pipeline, no external DB).
 * Distinct from fixture `createMemoryConnector`.
 */
export function createAgentMemoryStore(
  options: CreateAgentMemoryStoreOptions = {},
): AgentMemoryStore {
  const defaultScope = options.defaultScope ?? 'default';
  const extractFn = options.extract ?? defaultHeuristicExtractor;
  const retrieveFn = options.retrieve ?? tokenOverlapRetriever;
  const now = options.now ?? (() => new Date());
  let seq = 0;
  const newId =
    options.newId ??
    (() => {
      seq += 1;
      return `mem_${seq.toString(36)}`;
    });

  const entries = new Map<string, MemoryEntry>();

  function stamp(): string {
    return now().toISOString();
  }

  function put(entry: MemoryEntry): MemoryEntry {
    const parsed = memoryEntrySchema.parse(entry);
    entries.set(parsed.id, parsed);
    return parsed;
  }

  const store: AgentMemoryStore = {
    extract(text, meta) {
      return extractFn(text, {
        scope: meta?.scope ?? defaultScope,
        sourceUri: meta?.sourceUri,
      });
    },

    propose(candidate) {
      const c = memoryCandidateSchema.parse(candidate);
      const ts = stamp();
      return put({
        id: newId(),
        content: c.content,
        kind: c.kind,
        status: 'proposed',
        scope: c.scope || defaultScope,
        tags: c.tags,
        source: c.source,
        createdAt: ts,
        updatedAt: ts,
      });
    },

    validate(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`memory entry not found: ${id}`);
      if (entry.status !== 'proposed') {
        throw new Error(
          `memory ${id} status is ${entry.status}, expected proposed`,
        );
      }
      return put({ ...entry, status: 'validated', updatedAt: stamp() });
    },

    accept(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`memory entry not found: ${id}`);
      if (entry.status !== 'validated' && entry.status !== 'accepted') {
        throw new Error(
          `memory ${id} status is ${entry.status}, expected validated`,
        );
      }
      return put({ ...entry, status: 'accepted', updatedAt: stamp() });
    },

    apply(operation, opts) {
      const op = memoryOperationSchema.parse(operation);
      if (op.op === 'NOOP') {
        return { op: 'NOOP', message: op.reason ?? 'noop' };
      }
      if (op.op === 'ADD') {
        if (!op.content?.trim()) {
          throw new Error('ADD requires content');
        }
        const ts = stamp();
        const entry = put({
          id: op.id ?? newId(),
          content: op.content,
          kind: op.kind ?? 'fact',
          status: opts?.acceptImmediately ? 'accepted' : 'proposed',
          scope: op.scope ?? defaultScope,
          tags: op.tags ?? [],
          source: op.source,
          createdAt: ts,
          updatedAt: ts,
        });
        return { op: 'ADD', entry };
      }
      if (op.op === 'UPDATE') {
        if (!op.id) throw new Error('UPDATE requires id');
        const existing = entries.get(op.id);
        if (!existing) throw new Error(`memory entry not found: ${op.id}`);
        const entry = put({
          ...existing,
          content: op.content ?? existing.content,
          kind: op.kind ?? existing.kind,
          scope: op.scope ?? existing.scope,
          tags: op.tags ?? existing.tags,
          source: op.source ?? existing.source,
          // Updates re-enter proposed unless acceptImmediately
          status: opts?.acceptImmediately ? 'accepted' : 'proposed',
          updatedAt: stamp(),
        });
        return { op: 'UPDATE', entry };
      }
      // DELETE
      if (!op.id) throw new Error('DELETE requires id');
      const existing = entries.get(op.id);
      if (!existing) {
        return { op: 'DELETE', message: `not found: ${op.id}` };
      }
      entries.delete(op.id);
      return { op: 'DELETE', entry: existing };
    },

    retrieve(query, opts) {
      const limit = opts?.limit ?? 8;
      const statuses = opts?.includeStatuses ?? (['accepted'] as const);
      const pool = [...entries.values()].filter((e) =>
        statuses.includes(e.status),
      );
      return retrieveFn(pool, query, {
        scope: opts?.scope,
        limit,
      });
    },

    get(id) {
      return entries.get(id);
    },

    list(opts) {
      return [...entries.values()]
        .filter((e) => (opts?.scope ? e.scope === opts.scope : true))
        .filter((e) => (opts?.status ? e.status === opts.status : true))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
  };

  return store;
}
