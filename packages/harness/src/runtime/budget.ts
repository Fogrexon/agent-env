import { budgetSpecSchema, type BudgetSpec, type BudgetSpecInput } from '@agent-env/shared';

export interface BudgetSnapshot {
  toolCalls: number;
  tokens: number;
  wallSeconds: number;
  costUsd: number;
}

export type BudgetExhaustionReason =
  | 'maxToolCalls'
  | 'maxTokens'
  | 'maxWallSeconds'
  | 'maxCostUsd';

/**
 * Hard budget tracker (research P0). Soft warnings are optional; exhaustion is hard.
 */
export class BudgetManager {
  readonly #spec: BudgetSpec;
  readonly #startedAtMs: number;
  #toolCalls = 0;
  #tokens = 0;
  #costUsd = 0;

  constructor(spec: BudgetSpecInput, startedAtMs = Date.now()) {
    this.#spec = budgetSpecSchema.parse(spec);
    this.#startedAtMs = startedAtMs;
  }

  get snapshot(): BudgetSnapshot {
    return {
      toolCalls: this.#toolCalls,
      tokens: this.#tokens,
      wallSeconds: (Date.now() - this.#startedAtMs) / 1000,
      costUsd: this.#costUsd,
    };
  }

  consumeToolCall(count = 1): void {
    this.#toolCalls += count;
  }

  consumeTokens(count: number): void {
    if (count > 0) this.#tokens += count;
  }

  consumeCostUsd(amount: number): void {
    if (amount > 0) this.#costUsd += amount;
  }

  /** Returns the first exhausted dimension, or undefined if within budget. */
  exhaustionReason(): BudgetExhaustionReason | undefined {
    const wall = (Date.now() - this.#startedAtMs) / 1000;
    if (
      this.#spec.maxToolCalls != null &&
      this.#toolCalls > this.#spec.maxToolCalls
    ) {
      return 'maxToolCalls';
    }
    if (this.#spec.maxTokens != null && this.#tokens > this.#spec.maxTokens) {
      return 'maxTokens';
    }
    if (
      this.#spec.maxWallSeconds != null &&
      wall > this.#spec.maxWallSeconds
    ) {
      return 'maxWallSeconds';
    }
    if (
      this.#spec.maxCostUsd != null &&
      this.#costUsd > this.#spec.maxCostUsd
    ) {
      return 'maxCostUsd';
    }
    return undefined;
  }

  get exhausted(): boolean {
    return this.exhaustionReason() != null;
  }
}
