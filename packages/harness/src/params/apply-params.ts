import { existsSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import type {
  AgentAttachment,
  AgentParamsSpec,
  AppliedAgentParams,
  ParamDelivery,
  ParamField,
} from '@agent-env/shared';
import { isFileLikeParamType, isMultiFileParamType } from '@agent-env/shared';

export class AgentParamsValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join('; '));
    this.name = 'AgentParamsValidationError';
    this.issues = issues;
  }
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/**
 * Extension → MIME for attachment delivery. Providers declare which of these
 * they accept (see @agent-env/llm media catalog); unknown extensions stay
 * application/octet-stream and are rejected there.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.aiff': 'audio/aiff',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpg',
  '.mov': 'video/quicktime',
  '.avi': 'video/avi',
  '.flv': 'video/x-flv',
  '.webm': 'video/webm',
  '.wmv': 'video/wmv',
  '.3gp': 'video/3gpp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'text/xml',
  '.json': 'application/json',
};

export function mimeTypeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

function fieldDelivery(field: ParamField): ParamDelivery {
  if (!isFileLikeParamType(field.type)) return 'path';
  if ('delivery' in field && field.delivery) return field.delivery;
  return field.type === 'image' || field.type === 'images' ? 'content' : 'path';
}

function coerceFieldValue(
  field: ParamField,
  raw: unknown,
  issues: string[],
): unknown {
  if (isEmpty(raw)) {
    if (field.default !== undefined) return field.default;
    if (field.required) {
      issues.push(`field "${field.id}" is required`);
    }
    return undefined;
  }

  switch (field.type) {
    case 'string':
    case 'text':
    case 'file':
    case 'image':
    case 'enum': {
      if (typeof raw !== 'string') {
        issues.push(`field "${field.id}" must be a string`);
        return undefined;
      }
      if (field.type === 'enum') {
        const ok = field.options.some((o) => o.value === raw);
        if (!ok) {
          issues.push(
            `field "${field.id}" must be one of: ${field.options
              .map((o) => o.value)
              .join(', ')}`,
          );
          return undefined;
        }
      }
      return raw;
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        issues.push(`field "${field.id}" must be a number`);
        return undefined;
      }
      if (field.min !== undefined && n < field.min) {
        issues.push(`field "${field.id}" must be >= ${field.min}`);
      }
      if (field.max !== undefined && n > field.max) {
        issues.push(`field "${field.id}" must be <= ${field.max}`);
      }
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      issues.push(`field "${field.id}" must be a boolean`);
      return undefined;
    }
    case 'files':
    case 'images': {
      let list: string[];
      if (Array.isArray(raw)) {
        list = raw.map(String);
      } else if (typeof raw === 'string') {
        list = raw
          .split(/\r?\n|,/)
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        issues.push(`field "${field.id}" must be a string list`);
        return undefined;
      }
      return list;
    }
  }
}

function assertFilePathsExist(
  fieldId: string,
  paths: string[],
  cwd: string,
  issues: string[],
): void {
  for (const p of paths) {
    const absolute = isAbsolute(p) ? p : resolve(cwd, p);
    if (!existsSync(absolute)) {
      issues.push(`field "${fieldId}": file not found: ${p}`);
    }
  }
}

export interface ApplyAgentParamsOptions {
  /** Workspace root for resolving relative file paths. */
  cwd?: string;
  /** When true (default), verify file/image paths exist. */
  checkFiles?: boolean;
}

/**
 * Validate form values and preserve them as one structured invocation.
 * The objective field is projected separately while every value remains in inputs.
 */
export function applyAgentParams(
  spec: AgentParamsSpec,
  values: Record<string, unknown>,
  options: ApplyAgentParamsOptions = {},
): AppliedAgentParams {
  const cwd = options.cwd ?? process.cwd();
  const checkFiles = options.checkFiles !== false;
  const issues: string[] = [];
  const inputs: Record<string, unknown> = {};
  const attachments: AgentAttachment[] = [];

  for (const field of spec.fields) {
    const coerced = coerceFieldValue(field, values[field.id], issues);
    if (coerced === undefined) {
      // Keep optional keys stable for ADK instruction templates.
      if (!field.required) {
        const empty =
          field.type === 'files' || field.type === 'images'
            ? []
            : field.type === 'boolean'
              ? false
              : '';
        inputs[field.id] = empty;
      }
      continue;
    }

    inputs[field.id] = coerced;
    const delivery = fieldDelivery(field);
    const paths: string[] = isFileLikeParamType(field.type)
      ? isMultiFileParamType(field.type)
        ? (coerced as string[])
        : [String(coerced)]
      : [];

    if (checkFiles && paths.length > 0) {
      assertFilePathsExist(field.id, paths, cwd, issues);
    }

    if (isFileLikeParamType(field.type) && delivery === 'content') {
      for (const path of paths) {
        attachments.push({
          fieldId: field.id,
          path,
          mimeType: mimeTypeFromPath(path),
        });
      }
    }
  }

  const objectiveValue = inputs[spec.objectiveField];
  const objective =
    typeof objectiveValue === 'string' ? objectiveValue.trim() : '';
  if (!objective) {
    issues.push(
      `objective field "${spec.objectiveField}" must be a non-empty string`,
    );
  }

  if (issues.length > 0) {
    throw new AgentParamsValidationError(issues);
  }

  return { objective, inputs, metadata: {}, attachments };
}

/** Defaults from the spec, suitable for seeding an admin form. */
export function defaultValuesFromParams(
  spec: AgentParamsSpec,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of spec.fields) {
    if (field.default !== undefined) {
      values[field.id] = field.default;
    } else if (field.type === 'boolean') {
      values[field.id] = false;
    } else if (field.type === 'files' || field.type === 'images') {
      values[field.id] = [];
    } else if (field.type === 'number') {
      values[field.id] = field.min ?? 0;
    } else {
      values[field.id] = '';
    }
  }
  return values;
}
