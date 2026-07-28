/**
 * Smoke: ContextBuilder, typed handoff, agent memory (working-environment plane).
 */
import {
  acceptHandoffArtifact,
  computeHandoffDigest,
  createAgentMemoryStore,
  createContextBuilder,
  createHandoffArtifact,
  EVIDENCE_BUNDLE_SCHEMA_ID,
  estimateTokensApprox,
  shapeObservation,
  stableStringify,
} from '@agent-env/harness';
import { evidenceBundleSchema } from '@agent-env/shared';
import { z } from 'zod';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// --- ContextBuilder ---
const built = createContextBuilder({ budgetTokens: 80 })
  .addSection({
    kind: 'instruction',
    title: 'Instruction',
    content: 'You are a careful assistant.',
  })
  .addSection({
    kind: 'task',
    title: 'Task',
    content: 'Summarize the evidence.',
  })
  .addSection({
    kind: 'observation',
    title: 'Huge observation',
    content: 'x'.repeat(2000),
    handle: { uri: 'artifact://obs/1' },
    priority: 10,
  })
  .build();

assert(built.budgetTokens === 80, 'budget recorded');
assert(built.truncated, 'expected truncation under tight budget');
assert(
  built.sections.some(
    (s) => s.truncated && s.handle?.uri === 'artifact://obs/1',
  ),
  'truncated section keeps handle',
);
assert(built.estimatedTokens <= built.budgetTokens + 40, 'near budget');
assert(estimateTokensApprox('abcd') === 1, 'approx tokens');

const obs = shapeObservation({
  status: 'ok',
  content: 'y'.repeat(100),
  source: 'tool',
  maxChars: 40,
  handle: { uri: 'artifact://tool/out' },
  toolName: 'search_web',
});
assert(obs.truncated && obs.content.includes('[truncated]'), 'obs truncated');
assert(obs.handle?.uri === 'artifact://tool/out', 'obs handle');

const empty = shapeObservation({
  status: 'empty_success',
  content: '',
  source: 'tool',
});
assert(empty.status === 'empty_success', 'empty_success status');

// --- Typed handoff ---
const payload = evidenceBundleSchema.parse({
  sourceId: 'kb',
  query: 'demo',
  items: [
    {
      sourceId: 'kb',
      title: 'Doc',
      snippet: 'A fact',
      uri: 'kb://1',
    },
  ],
});

const handoff = createHandoffArtifact({
  fromAgent: 'kb_collector',
  toAgent: 'brief_synthesizer',
  objective: 'Pass evidence',
  outputSchema: EVIDENCE_BUNDLE_SCHEMA_ID,
  payload,
  payloadSchema: evidenceBundleSchema,
  doneCriteria: ['valid EvidenceBundle'],
  contextSummary: '1 item',
});

assert(handoff.digest.length === 64, 'sha256 hex digest');
const ok = acceptHandoffArtifact(handoff, {
  expectedToAgent: 'brief_synthesizer',
  expectedOutputSchema: EVIDENCE_BUNDLE_SCHEMA_ID,
  payloadSchema: evidenceBundleSchema,
});
assert(ok.ok && ok.payload?.items.length === 1, 'accept ok');

const tampered = { ...handoff, objective: 'tampered' };
const badDigest = acceptHandoffArtifact(tampered, {
  expectedToAgent: 'brief_synthesizer',
});
assert(!badDigest.ok, 'digest fail-closed');
assert(
  badDigest.errors.some((e) => e.includes('digest')),
  'digest error message',
);

const wrongDest = acceptHandoffArtifact(handoff, {
  expectedToAgent: 'other_agent',
  verifyDigest: true,
});
assert(!wrongDest.ok, 'destination fail-closed');

const wrongSchema = acceptHandoffArtifact(handoff, {
  expectedOutputSchema: 'artifact://schemas/other',
});
assert(!wrongSchema.ok, 'schema id fail-closed');

const badPayload = createHandoffArtifact({
  fromAgent: 'a',
  toAgent: 'b',
  objective: 'x',
  outputSchema: EVIDENCE_BUNDLE_SCHEMA_ID,
  payload: { not: 'valid' },
});
const payloadReject = acceptHandoffArtifact(badPayload, {
  payloadSchema: evidenceBundleSchema,
});
assert(!payloadReject.ok, 'payload schema fail-closed');

assert(
  computeHandoffDigest(handoff) === handoff.digest,
  'digest recompute stable',
);
assert(
  stableStringify({ b: 1, a: 2 }) === '{"a":2,"b":1}',
  'stable key order',
);

// Payload schema rejection at create time
let createFailed = false;
try {
  createHandoffArtifact({
    fromAgent: 'a',
    toAgent: 'b',
    objective: 'x',
    outputSchema: EVIDENCE_BUNDLE_SCHEMA_ID,
    payload: { nope: true } as never,
    payloadSchema: evidenceBundleSchema,
  });
} catch {
  createFailed = true;
}
assert(createFailed, 'create validates payloadSchema');

// --- Agent memory ---
const mem = createAgentMemoryStore({
  newId: (() => {
    let n = 0;
    return () => `m${++n}`;
  })(),
});

const candidates = mem.extract(
  '- The deploy window is Tuesday UTC.\n- Prefer canary releases for api-gateway.',
  { scope: 'ops' },
);
assert(candidates.length >= 1, 'extract candidates');

const proposed = mem.propose(candidates[0]!);
assert(proposed.status === 'proposed', 'proposed');
assert(mem.retrieve('deploy window').length === 0, 'proposed not searchable');

const validated = mem.validate(proposed.id);
assert(validated.status === 'validated', 'validated');
const accepted = mem.accept(proposed.id);
assert(accepted.status === 'accepted', 'accepted');
assert(mem.retrieve('deploy Tuesday').length === 1, 'accepted searchable');

mem.apply(
  {
    op: 'ADD',
    content: 'User prefers Japanese answers',
    kind: 'preference',
    scope: 'user',
  },
  { acceptImmediately: true },
);
assert(
  mem.retrieve('Japanese', { scope: 'user' }).length === 1,
  'scope filter',
);
assert(
  mem.retrieve('Japanese', { scope: 'ops' }).length === 0,
  'other scope empty',
);

const updated = mem.apply({
  op: 'UPDATE',
  id: accepted.id,
  content: 'The deploy window is Wednesday UTC.',
});
assert(updated.entry?.status === 'proposed', 'update re-proposes');
assert(
  mem.retrieve('Wednesday').length === 0,
  're-proposed not in accepted retrieve',
);

mem.apply({ op: 'DELETE', id: 'm1' });
assert(!mem.get('m1'), 'deleted');

mem.apply({ op: 'NOOP', reason: 'nothing to do' });

const otherSchema = z.object({ n: z.number() });
const typed = createHandoffArtifact({
  fromAgent: 'x',
  toAgent: 'y',
  objective: 'num',
  outputSchema: 'artifact://schemas/num-v1',
  payload: { n: 3 },
  payloadSchema: otherSchema,
});
assert(
  acceptHandoffArtifact(typed, { payloadSchema: otherSchema }).ok,
  'generic payload schema',
);

console.log('smoke-working-env: ok');
