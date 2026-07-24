import { FunctionTool } from '@google/adk';
import {
  toolContractSchema,
  type ToolContract,
  type ToolContractInput,
  type ToolRiskClass,
} from '@agent-env/shared';
import type { z } from 'zod';

type AnyZodObject = z.ZodObject<z.ZodRawShape>;

export interface GuardedToolOptions<TSchema extends AnyZodObject> {
  contract: ToolContractInput;
  description: string;
  parameters: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<unknown> | unknown;
  isLongRunning?: boolean;
  /**
   * Approval hook for T2/T3. Default: deny T2/T3 (fail closed).
   * Return true to allow exact-argument execution.
   */
  approve?: (args: {
    contract: ToolContract;
    input: z.infer<TSchema>;
  }) => Promise<boolean> | boolean;
}

const AUTO_RISKS: readonly ToolRiskClass[] = ['T0', 'T1'];

/**
 * Typed tool with risk / side-effect contract (research §6.3).
 * T2/T3 require an approve() callback; otherwise policy-denied.
 */
export function createGuardedTool<TSchema extends AnyZodObject>(
  options: GuardedToolOptions<TSchema>,
): FunctionTool {
  const contract = toolContractSchema.parse(options.contract);

  return new FunctionTool({
    name: contract.name,
    description: `${options.description} [risk=${contract.riskClass}, sideEffect=${contract.sideEffect}]`,
    parameters: options.parameters,
    isLongRunning: options.isLongRunning,
    execute: async (raw) => {
      const input = raw as z.infer<TSchema>;
      if (!AUTO_RISKS.includes(contract.riskClass)) {
        const ok = options.approve
          ? await options.approve({ contract, input })
          : false;
        if (!ok) {
          return {
            status: 'policy_denied',
            riskClass: contract.riskClass,
            message: `Tool ${contract.name} requires approval (risk ${contract.riskClass})`,
          };
        }
      }
      return options.execute(input);
    },
  });
}
