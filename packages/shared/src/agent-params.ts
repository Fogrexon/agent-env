import { z } from 'zod';

/** Field types used by YAML param specs and admin form generation. */
export const paramFieldTypeSchema = z.enum([
  'string',
  'text',
  'number',
  'boolean',
  'enum',
  'file',
  'files',
  'image',
  'images',
]);
export type ParamFieldType = z.infer<typeof paramFieldTypeSchema>;

/**
 * How file/image values are consumed.
 * - path: path string only (agent/tools decide what to do)
 * - content: load bytes and attach to the LLM user turn (multimodal)
 *
 * Declared by the agent params.yaml — admin UI does not decide this.
 */
export const paramDeliverySchema = z.enum(['path', 'content']);
export type ParamDelivery = z.infer<typeof paramDeliverySchema>;

export const paramEnumOptionSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
});
export type ParamEnumOption = z.infer<typeof paramEnumOptionSchema>;

const paramFieldBaseSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
});

const fileLikeExtras = {
  /** Extension / MIME hints for UI, e.g. [".png", "image/*"]. */
  accept: z.array(z.string()).optional(),
};

export const paramFieldSchema = z.discriminatedUnion('type', [
  paramFieldBaseSchema.extend({
    type: z.literal('string'),
    default: z.string().optional(),
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('text'),
    default: z.string().optional(),
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('number'),
    default: z.number().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('boolean'),
    default: z.boolean().optional(),
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('enum'),
    options: z.array(paramEnumOptionSchema).min(1),
    default: z.string().optional(),
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('file'),
    default: z.string().optional(),
    delivery: paramDeliverySchema.default('path'),
    ...fileLikeExtras,
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('files'),
    default: z.array(z.string()).optional(),
    delivery: paramDeliverySchema.default('path'),
    ...fileLikeExtras,
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('image'),
    default: z.string().optional(),
    delivery: paramDeliverySchema.default('content'),
    ...fileLikeExtras,
  }),
  paramFieldBaseSchema.extend({
    type: z.literal('images'),
    default: z.array(z.string()).optional(),
    delivery: paramDeliverySchema.default('content'),
    ...fileLikeExtras,
  }),
]);
export type ParamField = z.infer<typeof paramFieldSchema>;

/**
 * Versioned agent input-parameter document (YAML / JSON).
 * Drives admin form generation and run value validation.
 */
export const agentParamsSpecSchema = z
  .object({
    apiVersion: z.string().min(1).default('agent-env/v1'),
    kind: z.literal('AgentParams').default('AgentParams'),
    agentId: z.string().min(1),
    title: z.string().optional(),
    description: z.string().optional(),
    /** Field whose value becomes the run objective. */
    objectiveField: z.string().min(1).default('message'),
    fields: z.array(paramFieldSchema).default([]),
  })
  .superRefine((spec, ctx) => {
    const ids = new Set<string>();
    for (const [i, field] of spec.fields.entries()) {
      if (ids.has(field.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate field id: ${field.id}`,
          path: ['fields', i, 'id'],
        });
      }
      ids.add(field.id);
    }
    if (!ids.has(spec.objectiveField)) {
      ctx.addIssue({
        code: 'custom',
        message: `objectiveField "${spec.objectiveField}" must name a field`,
        path: ['objectiveField'],
      });
    }
  });
export type AgentParamsSpec = z.infer<typeof agentParamsSpecSchema>;

/** File/image bytes attached to the LLM user turn (delivery: content). */
export const agentAttachmentSchema = z.object({
  fieldId: z.string().min(1),
  path: z.string().min(1),
  mimeType: z.string().min(1),
});
export type AgentAttachment = z.infer<typeof agentAttachmentSchema>;

/** Applied form values ready for harness execution. */
export const appliedAgentParamsSchema = z.object({
  objective: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).default({}),
  /** Multimodal attachments resolved from delivery: content fields. */
  attachments: z.array(agentAttachmentSchema).default([]),
});
export type AppliedAgentParams = z.infer<typeof appliedAgentParamsSchema>;

export function isFileLikeParamType(
  type: ParamFieldType,
): type is 'file' | 'files' | 'image' | 'images' {
  return (
    type === 'file' ||
    type === 'files' ||
    type === 'image' ||
    type === 'images'
  );
}

export function isMultiFileParamType(
  type: ParamFieldType,
): type is 'files' | 'images' {
  return type === 'files' || type === 'images';
}
