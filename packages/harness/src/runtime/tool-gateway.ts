import { FunctionTool } from '@google/adk';
import {
  toolContractSchema,
  type ToolContract,
  type ToolContractInput,
  type ToolRiskClass,
} from '@agent-env/shared';
import type { z } from 'zod';
import { attachConnectorToolMeta } from '../connectors/tool-meta.js';
import { emitToolProgress } from './progress-context.js';
import { resolveToolApproval } from './tool-approval.js';

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
  /**
   * Optional agent-level pre-approval for T2/T3.
   * Return true to allow immediately (env shortcut).
   * When false/absent, the run-level policy (deny / auto / interactive) decides.
   */
  approve?: (args: {
    contract: ToolContract;
    input: z.infer<TSchema>;
  }) => Promise<boolean> | boolean;
}

const AUTO_RISKS: readonly ToolRiskClass[] = ['T0', 'T1'];

/**
 * Typed tool with risk / side-effect contract (research §6.3).
 * T2/T3 require approval: agent `approve()` OR run-level policy (auto / interactive).
 * Default without either: policy-denied (fail closed).
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
      if (!AUTO_RISKS.includes(contract.riskClass)) {
        const agentOk = options.approve
          ? await options.approve({ contract, input })
          : false;
        if (!agentOk) {
          const resolved = await resolveToolApproval({
            contract,
            input: input as Record<string, unknown>,
          });
          if (!resolved.granted) {
            return {
              status: 'policy_denied',
              riskClass: contract.riskClass,
              message: `Tool ${contract.name} requires approval (risk ${contract.riskClass})`,
              ...(resolved.approvalId
                ? { approvalId: resolved.approvalId }
                : {}),
              ...(resolved.decision === 'expired'
                ? { reason: 'approval_expired' }
                : {}),
            };
          }
        }
      }
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
