import type { BaseTool } from '@google/adk';
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

/**
 * Bridge an ADK tool to a vendor-neutral ProviderToolDefinition.
 * `FunctionTool.runAsync` validates args itself and does not dereference
 * the tool context, so a stub context is safe for function-style tools.
 */
export function adkToolToProviderTool(tool: BaseTool): ProviderToolDefinition {
  const declaration = tool._getDeclaration();
  const stubToolContext = {} as Parameters<
    BaseTool['runAsync']
  >[0]['toolContext'];

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: genaiSchemaToJsonSchema(declaration?.parameters),
    execute: (args) => tool.runAsync({ args, toolContext: stubToolContext }),
  };
}
