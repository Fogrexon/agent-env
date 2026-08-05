/** Dense vector helpers for hybrid retrieval. */

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i += 1) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return new Float32Array(vec);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) out[i] = vec[i]! / norm;
  return out;
}

export interface RankedId {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion over multiple ranked lists.
 * score(d) = Σ 1 / (k + rank_i(d))
 */
export function reciprocalRankFusion(
  lists: readonly (readonly RankedId[])[],
  options?: { k?: number; limit?: number },
): RankedId[] {
  const k = options?.k ?? 60;
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const contrib = 1 / (k + index + 1);
      scores.set(item.id, (scores.get(item.id) ?? 0) + contrib);
    });
  }
  const ranked = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return options?.limit !== undefined
    ? ranked.slice(0, options.limit)
    : ranked;
}

/**
 * Maximal Marginal Relevance: trade off relevance vs diversity.
 * Requires a similarity function between document ids.
 */
export function maximalMarginalRelevance(
  candidates: readonly RankedId[],
  options: {
    limit: number;
    lambda?: number;
    similarity: (a: string, b: string) => number;
  },
): RankedId[] {
  const lambda = options.lambda ?? 0.7;
  const selected: RankedId[] = [];
  const remaining = [...candidates];
  while (selected.length < options.limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < remaining.length; i += 1) {
      const cand = remaining[i]!;
      const rel = cand.score;
      let maxSim = 0;
      for (const s of selected) {
        maxSim = Math.max(maxSim, options.similarity(cand.id, s.id));
      }
      const mmr = lambda * rel - (1 - lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

export function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}
