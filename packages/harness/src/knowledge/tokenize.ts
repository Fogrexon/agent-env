/**
 * Shared tokenization for BM25 / lexical overlap (JA + EN identifiers).
 */

const TOKEN_RE =
  /[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?|[ぁ-んァ-ヶー一-龥]+/g;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const matches = lower.match(TOKEN_RE) ?? [];
  return matches.filter((t) => t.length >= 1);
}

export function tokenizeUnique(text: string): Set<string> {
  return new Set(tokenize(text));
}

/** Approximate token count for chunk budgets (not model-accurate). */
export function approxTokenCount(text: string): number {
  const tokens = tokenize(text);
  if (tokens.length === 0) return Math.ceil(text.length / 4);
  return tokens.length;
}
