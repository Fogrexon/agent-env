import type {
  KnowledgeGoldenQuery,
  KnowledgeHit,
  KnowledgeRetrievalMetrics,
} from '@agent-env/shared';

export interface RetrievalJudgement {
  queryId: string;
  rankedIds: string[];
  rankedDocumentIds?: string[];
  rankedSourceUris?: string[];
  citationUris?: string[];
  latencyMs?: number;
}

function relevanceGain(
  id: string,
  relevant: ReadonlySet<string>,
): number {
  return relevant.has(id) ? 1 : 0;
}

export function recallAtK(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  if (relevantIds.length === 0) return 1;
  const top = new Set(rankedIds.slice(0, k));
  let hit = 0;
  for (const id of relevantIds) if (top.has(id)) hit += 1;
  return hit / relevantIds.length;
}

export function meanReciprocalRank(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
): number {
  if (relevantIds.length === 0) return 1;
  const relevant = new Set(relevantIds);
  for (let i = 0; i < rankedIds.length; i += 1) {
    if (relevant.has(rankedIds[i]!)) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(
  rankedIds: readonly string[],
  relevantIds: readonly string[],
  k: number,
): number {
  const relevant = new Set(relevantIds);
  if (relevant.size === 0) return 1;
  let dcg = 0;
  for (let i = 0; i < Math.min(k, rankedIds.length); i += 1) {
    const rel = relevanceGain(rankedIds[i]!, relevant);
    if (rel > 0) dcg += rel / Math.log2(i + 2);
  }
  const idealCount = Math.min(k, relevant.size);
  let idcg = 0;
  for (let i = 0; i < idealCount; i += 1) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

export function citationCoverage(
  citationUris: readonly string[],
  allowedUris: readonly string[],
): number {
  if (citationUris.length === 0) return 0;
  const allowed = new Set(allowedUris);
  let ok = 0;
  for (const uri of citationUris) if (allowed.has(uri)) ok += 1;
  return ok / citationUris.length;
}

export function evaluateRetrievalRun(
  goldens: readonly KnowledgeGoldenQuery[],
  judgements: readonly RetrievalJudgement[],
  options?: { k?: number },
): KnowledgeRetrievalMetrics {
  const k = options?.k ?? 10;
  const byId = new Map(judgements.map((j) => [j.queryId, j]));
  let recallSum = 0;
  let mrrSum = 0;
  let ndcgSum = 0;
  let citationSum = 0;
  let citationCount = 0;
  let latencySum = 0;
  let latencyCount = 0;
  let n = 0;

  for (const g of goldens) {
    const j = byId.get(g.id);
    if (!j) continue;
    n += 1;
    const ranked =
      g.relevantChunkIds.length > 0
        ? j.rankedIds
        : g.relevantDocumentIds.length > 0
          ? (j.rankedDocumentIds ?? j.rankedIds)
          : (j.rankedSourceUris ?? j.rankedIds);
    const relevant =
      g.relevantChunkIds.length > 0
        ? g.relevantChunkIds
        : g.relevantDocumentIds.length > 0
          ? g.relevantDocumentIds
          : g.relevantSourceUris;

    recallSum += recallAtK(ranked, relevant, k);
    mrrSum += meanReciprocalRank(ranked, relevant);
    ndcgSum += ndcgAtK(ranked, relevant, k);

    if (j.citationUris && j.citationUris.length > 0) {
      const allowed =
        j.rankedIds.length > 0
          ? [
              ...j.rankedIds.map((id) => id),
              ...(j.rankedSourceUris ?? []),
            ]
          : [...relevant];
      // Prefer URIs from judgement when provided as source uris.
      citationSum += citationCoverage(
        j.citationUris,
        j.rankedSourceUris && j.rankedSourceUris.length > 0
          ? j.rankedSourceUris
          : allowed,
      );
      citationCount += 1;
    }
    if (j.latencyMs != null) {
      latencySum += j.latencyMs;
      latencyCount += 1;
    }
  }

  return {
    queryCount: n,
    recallAtK: n === 0 ? 0 : recallSum / n,
    mrr: n === 0 ? 0 : mrrSum / n,
    ndcgAtK: n === 0 ? 0 : ndcgSum / n,
    citationCoverage:
      citationCount === 0 ? undefined : citationSum / citationCount,
    meanLatencyMs: latencyCount === 0 ? undefined : latencySum / latencyCount,
    k,
  };
}

export function judgementFromHits(
  queryId: string,
  hits: readonly KnowledgeHit[],
  latencyMs?: number,
): RetrievalJudgement {
  return {
    queryId,
    rankedIds: hits.map((h) => h.chunk.id),
    rankedDocumentIds: hits.map((h) => h.chunk.documentId),
    rankedSourceUris: hits.map((h) => h.citation.sourceUri),
    citationUris: hits.map((h) => h.citation.uri),
    latencyMs,
  };
}
