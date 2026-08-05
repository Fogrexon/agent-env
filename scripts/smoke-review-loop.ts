/**
 * Offline smoke for createReviewLoopAgent (no network / LLM):
 *   - producer → reviewer → (reviser) wiring
 *   - approve path exits after iteration 1
 *   - revise path loops through the reviser until approved
 *   - exhaustion after maxIterations without approval
 *   - describeAgentGraph shows review_loop metadata + review/feedback edges
 *
 * Fixture agents are plain BaseAgent subclasses (no LlmAgent, no model) that
 * write session state directly via event actions.stateDelta — the same
 * mechanism a real reviewer LlmAgent's outputKey would use. They run through
 * the real ADK Runner (harness `runAgent`), so state written by one fixture
 * is genuinely visible to the next agent in the loop, not just simulated.
 */
import {
  BaseAgent,
  createEvent,
  createEventActions,
  type Event,
  type InvocationContext,
} from '@google/adk';
import {
  createReviewLoopAgent,
  describeAgentGraph,
  getReviewLoopMeta,
  runAgent,
} from '@agent-env/harness';
import {
  clearProviders,
  createGeminiProvider,
  registerProvider,
} from '@agent-env/llm';
import { z } from 'zod';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

clearProviders();
registerProvider(createGeminiProvider({ apiKey: 'offline-smoke' }));

type Script = (ctx: InvocationContext) => AsyncGenerator<Event, void, void>;

/** Plain BaseAgent whose run is scripted — no LLM involved. */
class FixtureAgent extends BaseAgent {
  readonly #script: Script;

  constructor(name: string, script: Script) {
    super({ name });
    this.#script = script;
  }

  protected override async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<Event, void, void> {
    yield* this.#script(ctx);
  }

  protected override async *runLiveImpl(): AsyncGenerator<Event, void, void> {
    throw new Error('FixtureAgent does not support live mode');
  }
}

function textEvent(author: string, invocationId: string, text: string): Event {
  return createEvent({
    invocationId,
    author,
    content: { role: 'model', parts: [{ text }] },
  });
}

interface CallCounter {
  calls: number;
}

function makeProducer(
  name: string,
  textFn: (attempt: number) => string,
  counter: CallCounter,
): FixtureAgent {
  return new FixtureAgent(name, async function* (ctx) {
    counter.calls += 1;
    yield textEvent(name, ctx.invocationId, textFn(counter.calls));
  });
}

interface Review {
  verdict: 'APPROVE' | 'REVISE';
  note: string;
}

const reviewSchema = z.object({
  verdict: z.enum(['APPROVE', 'REVISE']),
  note: z.string(),
});

function makeReviewer(
  name: string,
  reviewKey: string,
  verdicts: readonly Review['verdict'][],
  counter: CallCounter,
): FixtureAgent {
  return new FixtureAgent(name, async function* (ctx) {
    const attempt = counter.calls;
    counter.calls += 1;
    const verdict = verdicts[Math.min(attempt, verdicts.length - 1)]!;
    const review: Review = { verdict, note: `review #${attempt + 1}` };
    yield createEvent({
      invocationId: ctx.invocationId,
      author: name,
      content: {
        role: 'model',
        parts: [{ text: JSON.stringify(review) }],
      },
      actions: createEventActions({
        stateDelta: { [reviewKey]: JSON.stringify(review) },
      }),
    });
  });
}

const isApproved = (review: Review): boolean => review.verdict === 'APPROVE';

async function runLoop(agent: BaseAgent): Promise<{ finalText?: string }> {
  const result = await runAgent({
    agent,
    message: 'run the review loop',
    appName: `smoke-review-loop-${agent.name}`,
  });
  assert(result.status === 'finished', `run failed: ${result.error}`);
  return { finalText: result.finalText };
}

// --- 1. wiring + approve path exits early --------------------------------------
{
  const producerCalls: CallCounter = { calls: 0 };
  const reviewerCalls: CallCounter = { calls: 0 };
  const producer = makeProducer(
    'approve_producer',
    (n) => `draft v${n}`,
    producerCalls,
  );
  const reviewer = makeReviewer(
    'approve_reviewer',
    'approve_review_key',
    ['APPROVE'],
    reviewerCalls,
  );
  const loop = createReviewLoopAgent({
    name: 'approve_review_loop',
    producer,
    reviewer,
    reviewKey: 'approve_review_key',
    reviewSchema,
    isApproved,
    maxIterations: 3,
  });

  const { finalText } = await runLoop(loop);
  assert(producerCalls.calls === 1, `producer should run once, ran ${producerCalls.calls}`);
  assert(reviewerCalls.calls === 1, `reviewer should run once, ran ${reviewerCalls.calls}`);
  assert(
    (finalText ?? '').includes('approved on iteration 1/3'),
    `expected approval message, got: ${finalText}`,
  );
  console.log('✓ createReviewLoopAgent wiring + approve path exits early');
}

// --- 2. revise path loops through the reviser until approved -------------------
{
  const producerCalls: CallCounter = { calls: 0 };
  const reviewerCalls: CallCounter = { calls: 0 };
  const reviserCalls: CallCounter = { calls: 0 };
  const producer = makeProducer(
    'revise_producer',
    (n) => `draft v${n}`,
    producerCalls,
  );
  const reviser = makeProducer(
    'revise_reviser',
    (n) => `revision v${n}`,
    reviserCalls,
  );
  const reviewer = makeReviewer(
    'revise_reviewer',
    'revise_review_key',
    ['REVISE', 'REVISE', 'APPROVE'],
    reviewerCalls,
  );
  const loop = createReviewLoopAgent({
    name: 'revise_review_loop',
    producer,
    reviewer,
    reviser,
    reviewKey: 'revise_review_key',
    reviewSchema,
    isApproved,
    maxIterations: 5,
  });

  const { finalText } = await runLoop(loop);
  assert(producerCalls.calls === 1, `producer should run once, ran ${producerCalls.calls}`);
  assert(reviserCalls.calls === 2, `reviser should run twice, ran ${reviserCalls.calls}`);
  assert(reviewerCalls.calls === 3, `reviewer should run 3 times, ran ${reviewerCalls.calls}`);
  assert(
    (finalText ?? '').includes('approved on iteration 3/5'),
    `expected approval on 3rd iteration, got: ${finalText}`,
  );
  console.log('✓ revise path loops through the reviser until approved');
}

// --- 3. exhaustion after maxIterations without approval -------------------------
{
  const producerCalls: CallCounter = { calls: 0 };
  const reviewerCalls: CallCounter = { calls: 0 };
  const reviserCalls: CallCounter = { calls: 0 };
  const producer = makeProducer(
    'exhaust_producer',
    (n) => `draft v${n}`,
    producerCalls,
  );
  const reviser = makeProducer(
    'exhaust_reviser',
    (n) => `revision v${n}`,
    reviserCalls,
  );
  const reviewer = makeReviewer(
    'exhaust_reviewer',
    'exhaust_review_key',
    ['REVISE'],
    reviewerCalls,
  );
  const loop = createReviewLoopAgent({
    name: 'exhaust_review_loop',
    producer,
    reviewer,
    reviser,
    reviewKey: 'exhaust_review_key',
    reviewSchema,
    isApproved,
    maxIterations: 2,
  });

  const { finalText } = await runLoop(loop);
  assert(producerCalls.calls === 1, `producer should run once, ran ${producerCalls.calls}`);
  assert(reviserCalls.calls === 1, `reviser should run once, ran ${reviserCalls.calls}`);
  assert(reviewerCalls.calls === 2, `reviewer should run twice, ran ${reviewerCalls.calls}`);
  assert(
    (finalText ?? '').includes('exhausted after 2 iteration'),
    `expected exhaustion message, got: ${finalText}`,
  );
  console.log('✓ exhaustion after maxIterations without approval');
}

// --- 4. describeAgentGraph: review_loop metadata + review/feedback edges --------
{
  const producer = new FixtureAgent('graph_producer', async function* () {});
  const reviewer = new FixtureAgent('graph_reviewer', async function* () {});
  const reviser = new FixtureAgent('graph_reviser', async function* () {});
  const loop = createReviewLoopAgent({
    name: 'graph_review_loop',
    producer,
    reviewer,
    reviser,
    reviewKey: 'graph_review_key',
    reviewSchema,
    isApproved,
    maxIterations: 4,
  });

  assert(getReviewLoopMeta(loop)?.maxIterations === 4, 'review loop meta registered');

  const graph = describeAgentGraph(loop, { agentId: 'review-loop-smoke' });
  const loopNode = graph.nodes.find((n) => n.id === 'graph_review_loop');
  assert(loopNode, 'review_loop node present');
  assert(loopNode.kind === 'review_loop', `expected review_loop kind, got ${loopNode.kind}`);
  assert(loopNode.maxIterations === 4, 'node.maxIterations reflects loop config');
  assert(loopNode.meta?.['reviewKey'] === 'graph_review_key', 'node.meta.reviewKey set');
  assert(loopNode.meta?.['maxIterations'] === 4, 'node.meta.maxIterations set');

  assert(
    ['graph_producer', 'graph_reviewer', 'graph_reviser'].every((id) =>
      graph.nodes.some((n) => n.id === id),
    ),
    'producer/reviewer/reviser nodes present',
  );
  assert(
    graph.edges.some((e) => e.kind === 'review'),
    'review edge present',
  );
  assert(
    graph.edges.some((e) => e.kind === 'feedback'),
    'feedback edge present',
  );
  console.log('✓ describeAgentGraph review_loop metadata + review/feedback edges');
}

console.log('✓ smoke-review-loop passed');
