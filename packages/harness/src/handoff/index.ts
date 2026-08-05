import { createHash } from 'node:crypto';
import {
  handoffArtifactSchema,
  handoffContractResultSchema,
  type ArtifactHandle,
  type HandoffArtifact,
  type HandoffContractResult,
} from '@agent-env/shared';
import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';

export interface CreateHandoffInput<T> {
  fromAgent: string;
  toAgent: string;
  objective: string;
  /** Logical schema id recorded on the envelope (not the Zod object). */
  outputSchema: string;
  payload: T;
  /** Optional Zod schema used to validate payload at creation time. */
  payloadSchema?: z.ZodType<T>;
  inputArtifacts?: ArtifactHandle[];
  doneCriteria?: string[];
  contextSummary?: string;
  /** Soft cap on contextSummary chars (default 4000). */
  maxContextSummaryChars?: number;
  createdAt?: string;
}

/**
 * Stable JSON for digests: sorted object keys, arrays kept in order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortKeys(obj[key]);
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Body hashed for `digest` — everything except the digest field itself.
 */
export function handoffDigestBody(
  artifact: Omit<HandoffArtifact, 'digest'> & { digest?: string },
): string {
  const { digest: _ignored, ...rest } = artifact;
  return stableStringify(rest);
}

export function computeHandoffDigest(
  artifact: Omit<HandoffArtifact, 'digest'> & { digest?: string },
): string {
  return sha256Hex(handoffDigestBody(artifact));
}

/**
 * Create a typed handoff artifact with payload validation + digest.
 */
export function createHandoffArtifact<T>(
  input: CreateHandoffInput<T>,
): HandoffArtifact {
  const payload = input.payloadSchema
    ? input.payloadSchema.parse(input.payload)
    : input.payload;

  const maxSummary = input.maxContextSummaryChars ?? 4000;
  let contextSummary = input.contextSummary ?? '';
  if (contextSummary.length > maxSummary) {
    contextSummary =
      contextSummary.slice(0, Math.max(0, maxSummary - 16)) + '\n…[truncated]';
  }

  const body: Omit<HandoffArtifact, 'digest'> = {
    version: '1.0',
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    objective: input.objective,
    inputArtifacts: input.inputArtifacts ?? [],
    outputSchema: input.outputSchema,
    doneCriteria: input.doneCriteria ?? [],
    contextSummary,
    payload,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };

  return handoffArtifactSchema.parse({
    ...body,
    digest: computeHandoffDigest(body),
  });
}

export interface AcceptHandoffOptions<T = unknown> {
  /** Expected receiver agent name (fail-closed on mismatch). */
  expectedToAgent?: string;
  /** Expected logical schema id. */
  expectedOutputSchema?: string;
  /** Optional Zod schema for payload. */
  payloadSchema?: z.ZodType<T>;
  /** Recompute and verify digest (default true). */
  verifyDigest?: boolean;
}

/**
 * Receive / validate a handoff. Fail-closed on digest, destination, or schema.
 */
export function acceptHandoffArtifact<T = unknown>(
  raw: unknown,
  options: AcceptHandoffOptions<T> = {},
): HandoffContractResult & { payload?: T } {
  const errors: string[] = [];
  const parsed = handoffArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    return handoffContractResultSchema.parse({
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || 'root'}: ${i.message}`,
      ),
    });
  }

  const artifact = parsed.data;

  if (
    options.expectedToAgent &&
    artifact.toAgent !== options.expectedToAgent
  ) {
    errors.push(
      `toAgent mismatch: expected "${options.expectedToAgent}", got "${artifact.toAgent}"`,
    );
  }

  if (
    options.expectedOutputSchema &&
    artifact.outputSchema !== options.expectedOutputSchema
  ) {
    errors.push(
      `outputSchema mismatch: expected "${options.expectedOutputSchema}", got "${artifact.outputSchema}"`,
    );
  }

  if (options.verifyDigest !== false) {
    const expected = computeHandoffDigest(artifact);
    if (expected !== artifact.digest) {
      errors.push('digest mismatch (payload or envelope may have been altered)');
    }
  }

  let payload = artifact.payload as T;
  if (options.payloadSchema) {
    const payloadParsed = options.payloadSchema.safeParse(artifact.payload);
    if (!payloadParsed.success) {
      errors.push(
        ...payloadParsed.error.issues.map(
          (i) => `payload.${i.path.join('.') || 'root'}: ${i.message}`,
        ),
      );
    } else {
      payload = payloadParsed.data;
    }
  }

  if (errors.length > 0) {
    return handoffContractResultSchema.parse({
      ok: false,
      errors,
      artifact,
    });
  }

  return {
    ...handoffContractResultSchema.parse({
      ok: true,
      errors: [],
      artifact,
    }),
    payload,
  };
}

/**
 * JSON string suitable for ADK outputKey / session state.
 */
export function handoffToJson(artifact: HandoffArtifact): string {
  return JSON.stringify(artifact);
}

/**
 * Bounded Markdown envelope for agents that prefer prose + fenced JSON.
 */
export function handoffToMarkdownEnvelope(
  artifact: HandoffArtifact,
  opts?: { maxJsonChars?: number },
): string {
  const maxJson = opts?.maxJsonChars ?? 24_000;
  let json = handoffToJson(artifact);
  let truncated = false;
  if (json.length > maxJson) {
    json = json.slice(0, maxJson) + '…';
    truncated = true;
  }
  return [
    `## Handoff`,
    `- from: ${artifact.fromAgent}`,
    `- to: ${artifact.toAgent}`,
    `- schema: ${artifact.outputSchema}`,
    `- digest: ${artifact.digest}`,
    `- objective: ${artifact.objective}`,
    artifact.doneCriteria.length
      ? `- doneCriteria: ${artifact.doneCriteria.join('; ')}`
      : undefined,
    artifact.contextSummary
      ? `\n### Context summary\n${artifact.contextSummary}`
      : undefined,
    `\n### Payload (JSON${truncated ? ', truncated' : ''})`,
    '```json',
    json,
    '```',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

/**
 * Parse a handoff from a JSON string or a Markdown envelope that contains
 * a fenced ```json block.
 */
export function parseHandoffFromText(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed) as unknown;
  }
  const fence = trimmed.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    return JSON.parse(fence[1].trim()) as unknown;
  }
  throw new Error('No handoff JSON found in text');
}

/** Logical schema id for EvidenceBundle handoffs (collector → synthesizer). */
export const EVIDENCE_BUNDLE_SCHEMA_ID =
  'artifact://schemas/evidence-bundle-v1';

/** Logical schema id for security-audit findings list payloads. */
export const AUDIT_FINDINGS_SCHEMA_ID =
  'artifact://schemas/audit-findings-v1';

export interface CreateEmitHandoffToolOptions<T> {
  /** Tool contract name (default emit_handoff). */
  name?: string;
  fromAgent: string;
  toAgent: string;
  outputSchema: string;
  payloadSchema: z.ZodType<T>;
  description?: string;
  defaultObjective?: string;
  doneCriteria?: string[];
}

export interface EmitHandoffToolMeta {
  fromAgent: string;
  toAgent: string;
  outputSchema: string;
  toolName: string;
}

const EMIT_HANDOFF_META = new WeakMap<object, EmitHandoffToolMeta>();

/** Graph inspectors: recover handoff destinations from emit tools. */
export function getEmitHandoffToolMeta(
  tool: object,
): EmitHandoffToolMeta | undefined {
  return EMIT_HANDOFF_META.get(tool);
}

/**
 * Guarded tool: validate payload JSON, mint a typed handoff, return envelope.
 * Agents call this instead of freeform prose when handing off structured work.
 */
export function createEmitHandoffTool<T>(
  options: CreateEmitHandoffToolOptions<T>,
) {
  const name = options.name ?? 'emit_handoff';
  const tool = createGuardedTool({
    contract: {
      version: '1.0',
      name,
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
    },
    description:
      options.description ??
      `Emit a typed handoff artifact to ${options.toAgent} (schema ${options.outputSchema}).`,
    parameters: z.object({
      objective: z
        .string()
        .min(1)
        .optional()
        .describe('Task objective for the receiver'),
      contextSummary: z
        .string()
        .optional()
        .describe('Bounded summary; do not paste full history'),
      payloadJson: z
        .string()
        .min(2)
        .describe('JSON payload matching the handoff output schema'),
    }),
    execute: ({ objective, contextSummary, payloadJson }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(payloadJson) as unknown;
      } catch (err) {
        return {
          status: 'error' as const,
          message: `payloadJson is not valid JSON: ${(err as Error).message}`,
        };
      }
      try {
        const artifact = createHandoffArtifact({
          fromAgent: options.fromAgent,
          toAgent: options.toAgent,
          objective:
            objective?.trim() ||
            options.defaultObjective ||
            `Handoff from ${options.fromAgent} to ${options.toAgent}`,
          outputSchema: options.outputSchema,
          payload: raw as T,
          payloadSchema: options.payloadSchema,
          contextSummary,
          doneCriteria: options.doneCriteria,
        });
        return {
          status: 'ok' as const,
          digest: artifact.digest,
          toAgent: artifact.toAgent,
          outputSchema: artifact.outputSchema,
          envelope: handoffToMarkdownEnvelope(artifact),
          artifact,
        };
      } catch (err) {
        return {
          status: 'error' as const,
          message: `handoff rejected: ${(err as Error).message}`,
        };
      }
    },
  });
  EMIT_HANDOFF_META.set(tool, {
    fromAgent: options.fromAgent,
    toAgent: options.toAgent,
    outputSchema: options.outputSchema,
    toolName: name,
  });
  return tool;
}
