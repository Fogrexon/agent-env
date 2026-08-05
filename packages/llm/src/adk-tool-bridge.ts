import { randomUUID } from 'node:crypto';
import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
  type BaseTool,
} from '@google/adk';
import type { Schema } from '@google/genai';
import type { ProviderToolDefinition } from './types.js';

/**
 * Convert a genai Schema (uppercase Type enum, as produced by ADK
 * `BaseTool._getDeclaration()`) into plain JSON Schema (lowercase types)
 * for MCP-style tool declarations.
 */
export function genaiSchemaToJsonSchema(
  schema: Schema | undefined,
): Record<string, unknown> | undefined {
  if (!schema) return undefined;

  const out: Record<string, unknown> = {};
  if (schema.type) out['type'] = String(schema.type).toLowerCase();
  if (schema.description) out['description'] = schema.description;
  if (schema.format) out['format'] = schema.format;
  if (schema.enum) out['enum'] = schema.enum;
  if (schema.pattern) out['pattern'] = schema.pattern;
  if (schema.minimum != null) out['minimum'] = schema.minimum;
  if (schema.maximum != null) out['maximum'] = schema.maximum;
  if (schema.minLength != null) out['minLength'] = Number(schema.minLength);
  if (schema.maxLength != null) out['maxLength'] = Number(schema.maxLength);
  if (schema.minItems != null) out['minItems'] = Number(schema.minItems);
  if (schema.maxItems != null) out['maxItems'] = Number(schema.maxItems);
  if (schema.default !== undefined) out['default'] = schema.default;
  if (schema.items) out['items'] = genaiSchemaToJsonSchema(schema.items);
  if (schema.anyOf) {
    out['anyOf'] = schema.anyOf.map((s) => genaiSchemaToJsonSchema(s));
  }
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      props[key] = genaiSchemaToJsonSchema(value);
    }
    out['properties'] = props;
  }
  if (schema.required?.length) out['required'] = schema.required;
  if (schema.nullable) out['nullable'] = true;
  return out;
}

/** Placeholder agent only for InvocationContext construction (never run). */
const BRIDGE_PLACEHOLDER_AGENT = new LlmAgent({
  name: 'provider_tool_bridge',
  model: 'cursor:auto',
  description: 'Placeholder agent for provider-bridged tool Context',
});

/**
 * Minimal ADK Context for tools executed outside an ADK Runner
 * (e.g. Cursor SDK customTools via ProviderBackedLlm).
 *
 * FunctionTools ignore the context. AgentTool needs invocationContext,
 * session id/userId, and state.toRecord() — an empty `{}` stub throws
 * when reading `toolContext.invocationContext.sessionService`.
 */
export function createProviderBridgeToolContext(options?: {
  abortSignal?: AbortSignal;
}): Context {
  const session = createSession({
    id: randomUUID(),
    appName: 'provider-tool-bridge',
    userId: 'provider-tool-bridge',
    state: {},
  });
  const invocationContext = new InvocationContext({
    invocationId: randomUUID(),
    agent: BRIDGE_PLACEHOLDER_AGENT,
    session,
    pluginManager: new PluginManager(),
    ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
  });
  return new Context({ invocationContext });
}

/**
 * Bridge an ADK tool to a vendor-neutral ProviderToolDefinition.
 * Uses a real Context so AgentTool (sub-agents) can run under Cursor /
 * other in-loop tool providers, not only FunctionTool.
 */
export function adkToolToProviderTool(tool: BaseTool): ProviderToolDefinition {
  const declaration = tool._getDeclaration();

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: genaiSchemaToJsonSchema(declaration?.parameters),
    execute: (args) =>
      tool.runAsync({
        args,
        toolContext: createProviderBridgeToolContext(),
      }),
  };
}
