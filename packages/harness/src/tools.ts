import { FunctionTool } from '@google/adk';
import type { z } from 'zod';

type AnyZodObject = z.ZodObject<z.ZodRawShape>;

/**
 * Create a typed FunctionTool from a Zod object schema.
 * Prefer this helper so tool I/O stays inferred end-to-end.
 */
export function createTypedTool<TSchema extends AnyZodObject>(options: {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (input: z.infer<TSchema>) => Promise<unknown> | unknown;
  isLongRunning?: boolean;
}): FunctionTool {
  return new FunctionTool({
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    // ADK's ToolExecuteArgument is a wide union; cast keeps call-site inference.
    execute: (input) => options.execute(input as z.infer<TSchema>),
    isLongRunning: options.isLongRunning,
  });
}
