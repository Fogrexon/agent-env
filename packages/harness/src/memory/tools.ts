import { z } from 'zod';
import { createGuardedTool } from '../runtime/tool-gateway.js';
import type { AgentMemoryStore } from './store.js';

export interface CreateAgentMemoryToolsOptions {
  store: AgentMemoryStore;
  /** Prefix tool names (default memory_). */
  prefix?: string;
  /**
   * When true, ADD/UPDATE go straight to accepted (skips propose→validate).
   * Prefer false in production so writes stay gated.
   */
  acceptImmediately?: boolean;
}

/**
 * Guarded tools exposing extract / propose-validate-accept / CRUD / retrieve.
 * Risk T0 (sideEffect none) for read; T1 for mutations.
 */
export function createAgentMemoryTools(options: CreateAgentMemoryToolsOptions) {
  const prefix = options.prefix ?? 'memory_';
  const { store } = options;
  const acceptImmediately = options.acceptImmediately ?? false;

  const extract = createGuardedTool({
    contract: {
      version: '1.0',
      name: `${prefix}extract`,
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
    },
    description:
      'Extract memory candidates from text (does not write). Review then propose/accept.',
    parameters: z.object({
      text: z.string().min(1),
      scope: z.string().optional(),
      sourceUri: z.string().optional(),
    }),
    execute: ({ text, scope, sourceUri }) => ({
      status: 'ok' as const,
      candidates: store.extract(text, { scope, sourceUri }),
    }),
  });

  const propose = createGuardedTool({
    contract: {
      version: '1.0',
      name: `${prefix}propose`,
      riskClass: 'T1',
      sideEffect: 'reversible',
      idempotency: 'supported',
    },
    description: 'Stage a memory candidate as proposed (not yet searchable).',
    parameters: z.object({
      content: z.string().min(1),
      kind: z
        .enum(['fact', 'preference', 'procedure', 'entity', 'other'])
        .optional(),
      scope: z.string().optional(),
      tags: z.array(z.string()).optional(),
      sourceUri: z.string().optional(),
    }),
    execute: ({ content, kind, scope, tags, sourceUri }) => {
      const entry = store.propose({
        content,
        kind: kind ?? 'fact',
        scope: scope ?? 'default',
        tags: tags ?? [],
        ...(sourceUri ? { source: { uri: sourceUri } } : {}),
      });
      return { status: 'ok' as const, entry };
    },
  });

  const validate = createGuardedTool({
    contract: {
      version: '1.0',
      name: `${prefix}validate`,
      riskClass: 'T1',
      sideEffect: 'reversible',
      idempotency: 'supported',
    },
    description: 'Mark a proposed memory as validated.',
    parameters: z.object({ id: z.string().min(1) }),
    execute: ({ id }) => {
      try {
        return { status: 'ok' as const, entry: store.validate(id) };
      } catch (err) {
        return {
          status: 'error' as const,
          message: (err as Error).message,
        };
      }
    },
  });

  const accept = createGuardedTool({
    contract: {
      version: '1.0',
      name: `${prefix}accept`,
      riskClass: 'T1',
      sideEffect: 'reversible',
      idempotency: 'supported',
    },
    description: 'Accept a validated memory so it becomes searchable.',
    parameters: z.object({ id: z.string().min(1) }),
    execute: ({ id }) => {
      try {
        return { status: 'ok' as const, entry: store.accept(id) };
      } catch (err) {
        return {
          status: 'error' as const,
          message: (err as Error).message,
        };
      }
    },
  });

  const apply = createGuardedTool({
    contract: {
      version: '1.0',
      name: `${prefix}apply`,
      riskClass: 'T1',
      sideEffect: 'reversible',
      idempotency: 'supported',
    },
    description:
      'Apply a typed memory op: ADD | UPDATE | DELETE | NOOP. ADD/UPDATE start as proposed unless acceptImmediately is enabled on the store tools.',
    parameters: z.object({
      op: z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']),
      id: z.string().optional(),
      content: z.string().optional(),
      kind: z
        .enum(['fact', 'preference', 'procedure', 'entity', 'other'])
        .optional(),
      scope: z.string().optional(),
      tags: z.array(z.string()).optional(),
      reason: z.string().optional(),
    }),
    execute: (input) => {
      try {
        const result = store.apply(input, { acceptImmediately });
        return { status: 'ok' as const, ...result };
      } catch (err) {
        return {
          status: 'error' as const,
          message: (err as Error).message,
        };
      }
    },
  });

  const retrieve = createGuardedTool({
    contract: {
      version: '1.0',
      name: `${prefix}retrieve`,
      riskClass: 'T0',
      sideEffect: 'none',
      idempotency: 'supported',
    },
    description:
      'Retrieve accepted memories by query (token overlap). Proposed/validated are excluded.',
    parameters: z.object({
      query: z.string().min(1),
      scope: z.string().optional(),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    execute: ({ query, scope, limit }) => ({
      status: 'ok' as const,
      entries: store.retrieve(query, { scope, limit }),
    }),
  });

  return {
    extract,
    propose,
    validate,
    accept,
    apply,
    retrieve,
    /** Flat list for `tools: [...]`. */
    tools: [extract, propose, validate, accept, apply, retrieve],
  };
}

export type AgentMemoryTools = ReturnType<typeof createAgentMemoryTools>;
