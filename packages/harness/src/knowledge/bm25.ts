import { tokenize } from './tokenize.js';

export interface Bm25Document {
  id: string;
  text: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

/**
 * Classic BM25 (Robertson / Zaragoza) over an in-memory corpus.
 * Intentionally independent of SQLite FTS so Node build differences do not
 * silently degrade lexical search.
 */
export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private readonly docs = new Map<string, string[]>();
  private readonly df = new Map<string, number>();
  private avgDl = 0;

  constructor(options?: { k1?: number; b?: number }) {
    this.k1 = options?.k1 ?? 1.2;
    this.b = options?.b ?? 0.75;
  }

  clear(): void {
    this.docs.clear();
    this.df.clear();
    this.avgDl = 0;
  }

  upsert(id: string, text: string): void {
    this.remove(id);
    const tokens = tokenize(text);
    this.docs.set(id, tokens);
    const seen = new Set<string>();
    for (const token of tokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      this.df.set(token, (this.df.get(token) ?? 0) + 1);
    }
    this.recomputeAvgDl();
  }

  remove(id: string): void {
    const existing = this.docs.get(id);
    if (!existing) return;
    const seen = new Set<string>();
    for (const token of existing) {
      if (seen.has(token)) continue;
      seen.add(token);
      const next = (this.df.get(token) ?? 1) - 1;
      if (next <= 0) this.df.delete(token);
      else this.df.set(token, next);
    }
    this.docs.delete(id);
    this.recomputeAvgDl();
  }

  size(): number {
    return this.docs.size;
  }

  search(query: string, limit: number): Bm25Hit[] {
    const qTokens = tokenize(query);
    if (qTokens.length === 0 || this.docs.size === 0) return [];
    const N = this.docs.size;
    const scores = new Map<string, number>();

    for (const [id, tokens] of this.docs) {
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      const dl = tokens.length || 1;
      let score = 0;
      for (const qt of qTokens) {
        const f = tf.get(qt) ?? 0;
        if (f === 0) continue;
        const n = this.df.get(qt) ?? 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const denom = f + this.k1 * (1 - this.b + (this.b * dl) / this.avgDl);
        score += idf * ((f * (this.k1 + 1)) / denom);
      }
      if (score > 0) scores.set(id, score);
    }

    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  private recomputeAvgDl(): void {
    if (this.docs.size === 0) {
      this.avgDl = 0;
      return;
    }
    let sum = 0;
    for (const tokens of this.docs.values()) sum += tokens.length;
    this.avgDl = sum / this.docs.size;
  }
}
