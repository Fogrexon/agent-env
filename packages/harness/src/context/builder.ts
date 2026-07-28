import {
  contextBudgetParamsSchema,
  contextSectionKindSchema,
  type ContextBudgetParams,
  type ContextSection,
  type ContextSectionKind,
} from '@agent-env/shared';
import { estimateTokensApprox } from './tokens.js';
import {
  formatObservationBlock,
  type ShapeObservationOptions,
  shapeObservation,
} from './observation.js';

const DEFAULT_PRIORITY: Record<ContextSectionKind, number> = {
  instruction: 100,
  task: 90,
  plan: 70,
  memory: 60,
  information: 50,
  observation: 40,
};

export interface ContextBuilderOptions {
  /** Total token budget for working context (not full trace). */
  budgetTokens: number;
  estimateTokens?: (text: string) => number;
}

export interface BuiltSection {
  kind: ContextSectionKind;
  title: string;
  content: string;
  estimatedTokens: number;
  truncated: boolean;
  handle?: ContextSection['handle'];
  omittedTokens: number;
}

export interface BuiltContext {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  sections: BuiltSection[];
  truncated: boolean;
}

export interface ContextBuilder {
  addSection(section: ContextSection): ContextBuilder;
  addObservation(
    title: string,
    observation: ShapeObservationOptions,
    opts?: { priority?: number; maxTokens?: number },
  ): ContextBuilder;
  build(): BuiltContext;
}

function truncateToTokens(
  text: string,
  maxTokens: number,
  estimate: (text: string) => number,
): { text: string; truncated: boolean; omittedTokens: number } {
  if (maxTokens <= 0) {
    return {
      text: '',
      truncated: text.length > 0,
      omittedTokens: estimate(text),
    };
  }
  if (estimate(text) <= maxTokens) {
    return { text, truncated: false, omittedTokens: 0 };
  }
  // Approximate: 4 chars ≈ 1 token (matches estimateTokensApprox).
  const maxChars = Math.max(0, maxTokens * 4 - 16);
  const head = text.slice(0, maxChars);
  const omitted = estimate(text) - estimate(head);
  return {
    text: `${head}\n…[truncated; see handle if present]`,
    truncated: true,
    omittedTokens: Math.max(0, omitted),
  };
}

function renderSection(section: BuiltSection): string {
  return `## ${section.title}\n${section.content}`;
}

/**
 * Assemble working context under a token budget.
 * Full trace stays outside; truncated sections keep handles when provided.
 */
export function createContextBuilder(
  options: ContextBuilderOptions,
): ContextBuilder {
  const estimate = options.estimateTokens ?? estimateTokensApprox;
  const budgetTokens = Math.max(1, options.budgetTokens);
  const sections: ContextSection[] = [];

  const builder: ContextBuilder = {
    addSection(section) {
      sections.push(section);
      return builder;
    },
    addObservation(title, observation, opts) {
      const shaped = shapeObservation(observation);
      sections.push({
        kind: 'observation',
        title,
        content: formatObservationBlock(shaped),
        priority: opts?.priority,
        maxTokens: opts?.maxTokens,
        ...(shaped.handle ? { handle: shaped.handle } : {}),
      });
      return builder;
    },
    build() {
      // Soft per-section cap first, then global priority trim.
      const prepared = sections.map((raw) => {
        const kind = contextSectionKindSchema.parse(raw.kind);
        const priority = raw.priority ?? DEFAULT_PRIORITY[kind];
        let content = raw.content;
        let truncated = false;
        let omittedTokens = 0;
        if (raw.maxTokens !== undefined) {
          const capped = truncateToTokens(content, raw.maxTokens, estimate);
          content = capped.text;
          truncated = capped.truncated;
          omittedTokens = capped.omittedTokens;
        }
        return {
          kind,
          title: raw.title,
          content,
          priority,
          estimatedTokens: estimate(content),
          truncated,
          omittedTokens,
          handle: raw.handle,
        };
      });

      // Drop / shrink lowest priority first when over budget.
      const ordered = [...prepared].sort((a, b) => a.priority - b.priority);
      let total = prepared.reduce((sum, s) => sum + s.estimatedTokens, 0);

      for (const low of ordered) {
        if (total <= budgetTokens) break;
        const overflow = total - budgetTokens;
        if (overflow >= low.estimatedTokens) {
          // Drop entire section content but keep a stub + handle.
          const stub = low.handle
            ? `[omitted; handle=${low.handle.uri}]`
            : '[omitted due to context budget]';
          const before = low.estimatedTokens;
          low.content = stub;
          low.estimatedTokens = estimate(stub);
          low.truncated = true;
          low.omittedTokens += before - low.estimatedTokens;
          total = prepared.reduce((sum, s) => sum + s.estimatedTokens, 0);
        } else {
          const keep = Math.max(16, low.estimatedTokens - overflow);
          const capped = truncateToTokens(low.content, keep, estimate);
          low.content = capped.text;
          low.truncated = true;
          low.omittedTokens += capped.omittedTokens;
          low.estimatedTokens = estimate(low.content);
          total = prepared.reduce((sum, s) => sum + s.estimatedTokens, 0);
        }
      }

      // Preserve original insertion order in the final text.
      const built: BuiltSection[] = prepared.map((s) => ({
        kind: s.kind,
        title: s.title,
        content: s.content,
        estimatedTokens: s.estimatedTokens,
        truncated: s.truncated,
        omittedTokens: s.omittedTokens,
        ...(s.handle ? { handle: s.handle } : {}),
      }));

      const text = built.map(renderSection).join('\n\n');
      return {
        text,
        estimatedTokens: estimate(text),
        budgetTokens,
        sections: built,
        truncated: built.some((s) => s.truncated),
      };
    },
  };

  return builder;
}

/**
 * Build ModelRef.params for context-window guarding (OpenAI-compatible today).
 * Agents pass the result into `resolveModel({ …, params })`.
 */
export function contextBudgetModelParams(
  params: ContextBudgetParams,
): Record<string, unknown> {
  const parsed = contextBudgetParamsSchema.parse(params);
  return {
    contextWindow: parsed.contextWindow,
    ...(parsed.reserveOutputTokens !== undefined
      ? { reserveOutputTokens: parsed.reserveOutputTokens }
      : {}),
    ...(parsed.maxToolResultChars !== undefined
      ? { maxToolResultChars: parsed.maxToolResultChars }
      : {}),
    ...(parsed.maxToolIterations !== undefined
      ? { maxToolIterations: parsed.maxToolIterations }
      : {}),
    ...(parsed.contextOverflow !== undefined
      ? { contextOverflow: parsed.contextOverflow }
      : {}),
  };
}
