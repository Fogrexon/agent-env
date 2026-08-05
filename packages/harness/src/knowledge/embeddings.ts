import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './types.js';
import { l2Normalize } from './vector.js';

export interface CreateDeterministicEmbedderOptions {
  id?: string;
  model?: string;
  dimension?: number;
}

/**
 * Offline / test embedder. Deterministic hashing into a unit vector.
 * Never use as a silent production fallback — callers must inject explicitly.
 */
export function createDeterministicEmbedder(
  options: CreateDeterministicEmbedderOptions = {},
): EmbeddingProvider {
  const dimension = options.dimension ?? 64;
  const model = options.model ?? 'deterministic-hash/v1';
  return {
    id: options.id ?? 'deterministic',
    model,
    dimension,
    async embed(texts) {
      return texts.map((text) => hashEmbed(text, dimension));
    },
  };
}

function hashEmbed(text: string, dimension: number): Float32Array {
  const out = new Float32Array(dimension);
  const tokens = text.toLowerCase().split(/[^a-z0-9ぁ-んァ-ヶ一-龥_]+/i);
  for (const token of tokens) {
    if (!token) continue;
    const digest = createHash('sha256').update(token).digest();
    for (let i = 0; i < dimension; i += 1) {
      const byte = digest[i % digest.length]!;
      out[i]! += (byte / 255) * 2 - 1;
    }
  }
  if (text.trim().length === 0) out[0] = 1;
  return l2Normalize(out);
}

export interface CreateOpenaiCompatibleEmbedderOptions {
  id?: string;
  model: string;
  apiKey: string | (() => string | undefined);
  baseUrl: string | (() => string | undefined);
  dimension?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI-compatible embeddings endpoint (`POST /embeddings`).
 * Keys / base URL are injected by the caller — packages do not read process.env.
 */
export function createOpenaiCompatibleEmbedder(
  options: CreateOpenaiCompatibleEmbedderOptions,
): EmbeddingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let resolvedDimension = options.dimension;

  return {
    id: options.id ?? 'openai-compatible-embed',
    model: options.model,
    get dimension() {
      if (!resolvedDimension) {
        throw new Error(
          'Embedding dimension unknown until first embed(); pass dimension explicitly for sync planning',
        );
      }
      return resolvedDimension;
    },
    async embed(texts) {
      if (texts.length === 0) return [];
      const apiKey =
        typeof options.apiKey === 'function' ? options.apiKey() : options.apiKey;
      const baseUrlRaw =
        typeof options.baseUrl === 'function'
          ? options.baseUrl()
          : options.baseUrl;
      if (!apiKey?.trim()) throw new Error('embedding apiKey is required');
      if (!baseUrlRaw?.trim()) throw new Error('embedding baseUrl is required');
      const baseUrl = baseUrlRaw.replace(/\/$/, '');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: options.model,
            input: [...texts],
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(
            `embedding HTTP ${res.status}: ${body.slice(0, 400)}`,
          );
        }
        const json = (await res.json()) as {
          data?: Array<{ embedding?: number[]; index?: number }>;
        };
        const rows = [...(json.data ?? [])].sort(
          (a, b) => (a.index ?? 0) - (b.index ?? 0),
        );
        if (rows.length !== texts.length) {
          throw new Error(
            `embedding response size mismatch: got ${rows.length}, expected ${texts.length}`,
          );
        }
        return rows.map((row) => {
          const values = row.embedding;
          if (!values?.length) throw new Error('empty embedding vector');
          resolvedDimension = values.length;
          return l2Normalize(Float32Array.from(values));
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface CreateGeminiEmbedderOptions {
  id?: string;
  model: string;
  apiKey: string | (() => string | undefined);
  dimension?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Gemini text embedding via Generative Language API. */
export function createGeminiEmbedder(
  options: CreateGeminiEmbedderOptions,
): EmbeddingProvider {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  let resolvedDimension = options.dimension;

  return {
    id: options.id ?? 'gemini-embed',
    model: options.model,
    get dimension() {
      if (!resolvedDimension) {
        throw new Error(
          'Embedding dimension unknown until first embed(); pass dimension explicitly for sync planning',
        );
      }
      return resolvedDimension;
    },
    async embed(texts) {
      if (texts.length === 0) return [];
      const apiKey =
        typeof options.apiKey === 'function' ? options.apiKey() : options.apiKey;
      if (!apiKey?.trim()) throw new Error('gemini embedding apiKey is required');
      const out: Float32Array[] = [];
      for (const text of texts) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const url =
            `https://generativelanguage.googleapis.com/v1beta/models/` +
            `${encodeURIComponent(options.model)}:embedContent?key=${encodeURIComponent(apiKey)}`;
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: { parts: [{ text }] },
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(
              `gemini embedding HTTP ${res.status}: ${body.slice(0, 400)}`,
            );
          }
          const json = (await res.json()) as {
            embedding?: { values?: number[] };
          };
          const values = json.embedding?.values;
          if (!values?.length) throw new Error('empty gemini embedding');
          resolvedDimension = values.length;
          out.push(l2Normalize(Float32Array.from(values)));
        } finally {
          clearTimeout(timer);
        }
      }
      return out;
    },
  };
}
