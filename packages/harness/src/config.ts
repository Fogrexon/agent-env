import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MODEL_REF,
  harnessConfigSchema,
  type HarnessConfig,
  type LlmProviderId,
  type ModelRef,
} from '@agent-env/shared';
import { assertAnyProvider, parseModelRef } from '@agent-env/llm';
import { bootstrapProvidersFromEnv } from './providers-bootstrap.js';

/** Lightweight .env loader (no extra dependency). Does not override existing env. */
export function loadDotEnv(filePath = resolve(process.cwd(), '.env')): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveDefaultModelRef(
  overrides: Partial<HarnessConfig>,
): ModelRef {
  if (overrides.defaultModel) return overrides.defaultModel;
  if (process.env['AGENT_ENV_MODEL']) {
    return parseModelRef(process.env['AGENT_ENV_MODEL']);
  }
  if (overrides.model) {
    return parseModelRef(overrides.model);
  }
  return DEFAULT_MODEL_REF;
}

/**
 * Load harness config from process.env and (optionally) bootstrap providers.
 * Secret sourcing via env is an app convenience — override by registering
 * providers yourself before calling runAgent.
 */
export function loadHarnessConfig(
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  loadDotEnv();
  bootstrapProvidersFromEnv();

  const defaultModel = resolveDefaultModelRef(overrides);

  return harnessConfigSchema.parse({
    defaultModel,
    model: defaultModel.model,
    appName: overrides.appName ?? process.env['AGENT_ENV_APP_NAME'] ?? 'agent-env',
    userId: overrides.userId ?? process.env['AGENT_ENV_USER_ID'] ?? 'local-user',
  });
}

/**
 * Ensure at least one registered provider is configured.
 * Pass `required` to demand specific provider ids.
 */
export function assertApiKey(
  _config: HarnessConfig,
  required?: readonly LlmProviderId[],
): void {
  assertAnyProvider(required);
}
