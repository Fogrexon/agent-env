/**
 * Approximate token count (provider-agnostic default).
 * Roughly ceil(chars / 4); callers may inject a better estimator.
 */
export function estimateTokensApprox(text: string): number {
  return Math.ceil(text.length / 4);
}
