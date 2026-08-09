import { FunctionTool } from '@google/adk';
import {
  toolContractSchema,
  type ToolContractInput,
} from '@agent-env/shared';
import type { z } from 'zod';
import { attachConnectorToolMeta } from '../connectors/tool-meta.js';
import { emitToolProgress } from './progress-context.js';

type AnyZodObject = z.ZodObject<z.ZodRawShape>;

export interface GuardedToolOptions<TSchema extends AnyZodObject> {
  contract: ToolContractInput;
  description: string;
  parameters: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<unknown> | unknown;
  isLongRunning?: boolean;
  /**
   * Non-secret factory config shown in live progress when the tool runs.
   * Never put API keys or tokens here.
   */
  publicConfig?: Record<string, unknown>;
  /**
   * When set, graph inspectors emit a distinct datasource node linked via `reads`.
   */
  source?: {
    connectorId: string;
    title: string;
    kind: string;
    tags?: string[];
    description?: string;
  };
}

/**
 * Typed tool with risk / side-effect contract metadata.
 * Emits progress on invoke, then executes.
 */
export function createGuardedTool<TSchema extends AnyZodObject>(
  options: GuardedToolOptions<TSchema>,
): FunctionTool {
  const contract = toolContractSchema.parse(options.contract);

  const tool = new FunctionTool({
    name: contract.name,
    description: `${options.description} [risk=${contract.riskClass}, sideEffect=${contract.sideEffect}]`,
    parameters: options.parameters,
    isLongRunning: options.isLongRunning,
    execute: async (raw) => {
      const input = raw as z.infer<TSchema>;
      emitToolProgress({
        author: `tool:${contract.name}`,
        message: `invoke ${contract.name}`,
        payload: {
          tool: contract.name,
          riskClass: contract.riskClass,
          sideEffect: contract.sideEffect,
          input: input as Record<string, unknown>,
          ...(options.publicConfig
            ? { config: options.publicConfig }
            : {}),
        },
      });
      return options.execute(input);
    },
  });

  if (options.source) {
    attachConnectorToolMeta(tool, {
      connectorId: options.source.connectorId,
      title: options.source.title,
      kind: options.source.kind,
      tags: options.source.tags,
      description: options.source.description,
    });
  }

  return tool;
}
