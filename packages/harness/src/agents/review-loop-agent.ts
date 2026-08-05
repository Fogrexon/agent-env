import {
  BaseAgent,
  createEvent,
  type InvocationContext,
} from '@google/adk';
import type { z } from 'zod';

export interface ReviewLoopMeta {
  reviewKey: string;
  maxIterations: number;
  producerName: string;
  reviewerName: string;
  reviserName: string;
}

const META = new WeakMap<BaseAgent, ReviewLoopMeta>();

export function getReviewLoopMeta(agent: BaseAgent): ReviewLoopMeta | undefined {
  return META.get(agent);
}

export interface CreateReviewLoopAgentOptions<TReview> {
  name: string;
  description?: string;
  producer: BaseAgent;
  reviewer: BaseAgent;
  /** Defaults to producer when omitted. */
  reviser?: BaseAgent;
  /** Session state key where the reviewer writes JSON / structured output. */
  reviewKey: string;
  reviewSchema: z.ZodType<TReview>;
  isApproved: (review: TReview) => boolean;
  maxIterations: number;
  /**
   * How to read the review from session state.
   * Default: parse JSON string at reviewKey.
   */
  readReview?: (state: Record<string, unknown>) => unknown;
}

function defaultReadReview(state: Record<string, unknown>, key: string): unknown {
  const raw = state[key];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * Same-session producer → reviewer → (optional reviser) loop.
 * Shares the outer ADK invocation budget, abort, and tool approval.
 * Does not nest `runAgent()`.
 */
export function createReviewLoopAgent<TReview>(
  options: CreateReviewLoopAgentOptions<TReview>,
): BaseAgent {
  const reviser = options.reviser ?? options.producer;
  const maxIterations = Math.max(1, options.maxIterations);

  class ReviewLoopAgent extends BaseAgent {
    protected async *runAsyncImpl(
      context: InvocationContext,
    ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
      for (let i = 0; i < maxIterations; i += 1) {
        const worker = i === 0 ? options.producer : reviser;
        yield* worker.runAsync(context);

        yield* options.reviewer.runAsync(context);

        const state = context.session.state as Record<string, unknown>;
        const raw = options.readReview
          ? options.readReview(state)
          : defaultReadReview(state, options.reviewKey);

        let review: TReview;
        try {
          review = options.reviewSchema.parse(raw);
        } catch (err) {
          yield createEvent({
            invocationId: context.invocationId,
            author: this.name,
            content: {
              role: 'model',
              parts: [
                {
                  text: `Review parse failed on iteration ${i + 1}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                },
              ],
            },
          });
          continue;
        }

        if (options.isApproved(review)) {
          yield createEvent({
            invocationId: context.invocationId,
            author: this.name,
            content: {
              role: 'model',
              parts: [
                {
                  text: `Review approved on iteration ${i + 1}/${maxIterations}.`,
                },
              ],
            },
          });
          return;
        }

        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {
            role: 'model',
            parts: [
              {
                text: `Review rejected on iteration ${i + 1}/${maxIterations}; revising.`,
              },
            ],
          },
        });
      }

      yield createEvent({
        invocationId: context.invocationId,
        author: this.name,
        content: {
          role: 'model',
          parts: [
            {
              text: `Review loop exhausted after ${maxIterations} iteration(s).`,
            },
          ],
        },
      });
    }

    protected async *runLiveImpl(
      _context: InvocationContext,
    ): AsyncGenerator<ReturnType<typeof createEvent>, void, void> {
      throw new Error('ReviewLoopAgent does not support live mode');
    }
  }

  const agent = new ReviewLoopAgent({
    name: options.name,
    description:
      options.description ??
      `Review/revise loop (max ${maxIterations}): ${options.producer.name} ↔ ${options.reviewer.name}`,
    subAgents: [options.producer, options.reviewer, reviser].filter(
      (a, idx, arr) => arr.findIndex((x) => x.name === a.name) === idx,
    ),
  });

  META.set(agent, {
    reviewKey: options.reviewKey,
    maxIterations,
    producerName: options.producer.name,
    reviewerName: options.reviewer.name,
    reviserName: reviser.name,
  });

  return agent;
}
