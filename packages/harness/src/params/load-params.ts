import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  agentParamsSpecSchema,
  type AgentParamsSpec,
} from '@agent-env/shared';

export class AgentParamsLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentParamsLoadError';
  }
}

/**
 * Load and validate an AgentParams YAML/JSON document.
 * `filePath` may be absolute or relative to `cwd` (default process.cwd()).
 */
export function loadAgentParamsFile(
  filePath: string,
  cwd: string = process.cwd(),
): AgentParamsSpec {
  const absolute = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  if (!existsSync(absolute)) {
    throw new AgentParamsLoadError(`params file not found: ${absolute}`);
  }
  const rawText = readFileSync(absolute, 'utf8');
  let raw: unknown;
  try {
    raw = parseYaml(rawText);
  } catch (err) {
    throw new AgentParamsLoadError(`invalid YAML in ${absolute}`, {
      cause: err,
    });
  }
  const parsed = agentParamsSpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentParamsLoadError(
      `invalid AgentParams in ${absolute}: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Convenience: load params for a manifest that declares paramsFile. */
export function loadAgentParamsForManifest(
  paramsFile: string | undefined,
  cwd: string = process.cwd(),
): AgentParamsSpec | undefined {
  if (!paramsFile) return undefined;
  return loadAgentParamsFile(paramsFile, cwd);
}
