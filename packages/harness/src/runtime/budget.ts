import type { AgentExecutionLimits } from '@agent-env/shared';

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

export interface BudgetLimits {
  maxToolCalls: number;
  maxWallSeconds: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

/**
 * Hard budget tracker. Soft warnings are optional; exhaustion is hard.
 */
export class BudgetManager {
  readonly #spec: BudgetLimits;
  readonly #startedAtMs: number;
  #toolCalls = 0;
  #tokens = 0;
  #costUsd = 0;

  constructor(spec: BudgetLimits, startedAtMs = Date.now()) {
    this.#spec = spec;
    this.#startedAtMs = startedAtMs;
  }

  static fromLimits(limits: AgentExecutionLimits): BudgetManager {
    return new BudgetManager({
      maxToolCalls: limits.maxToolCalls,
      maxWallSeconds: limits.maxWallSeconds,
    });
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
    if (this.#toolCalls > this.#spec.maxToolCalls) {
      return 'maxToolCalls';
    }
    if (this.#spec.maxTokens != null && this.#tokens > this.#spec.maxTokens) {
      return 'maxTokens';
    }
    if (wall > this.#spec.maxWallSeconds) {
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
