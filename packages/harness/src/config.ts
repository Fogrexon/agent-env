import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MODEL_REF,
  LLM_PROVIDER_IDS,
  harnessConfigSchema,
  type HarnessConfig,
  type LlmProviderId,
  type ModelRef,
  type ProviderCredentials,
} from '@agent-env/shared';
import {
  assertAnyProvider,
  loadProviderCredentials,
  parseModelRef,
} from '@agent-env/llm';

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
 * Load harness config from process.env.
 * Supports multiple LLM providers (Gemini, Cursor, OpenAI, Anthropic, OpenAI-compatible).
 */
export function loadHarnessConfig(
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  loadDotEnv();

  const fromEnv = loadProviderCredentials();
  const credentials: ProviderCredentials = {
    ...fromEnv,
    ...overrides.credentials,
    geminiApiKey:
      overrides.credentials?.geminiApiKey ??
      overrides.geminiApiKey ??
      fromEnv.geminiApiKey,
    cursorApiKey: overrides.credentials?.cursorApiKey ?? fromEnv.cursorApiKey,
    openaiApiKey: overrides.credentials?.openaiApiKey ?? fromEnv.openaiApiKey,
    openaiBaseUrl:
      overrides.credentials?.openaiBaseUrl ?? fromEnv.openaiBaseUrl,
    anthropicApiKey:
      overrides.credentials?.anthropicApiKey ?? fromEnv.anthropicApiKey,
    openaiCompatibleBaseUrl:
      overrides.credentials?.openaiCompatibleBaseUrl ??
      fromEnv.openaiCompatibleBaseUrl,
    openaiCompatibleApiKey:
      overrides.credentials?.openaiCompatibleApiKey ??
      fromEnv.openaiCompatibleApiKey,
  };

  const defaultModel = resolveDefaultModelRef(overrides);

  return harnessConfigSchema.parse({
    defaultModel,
    model: defaultModel.model,
    appName: overrides.appName ?? process.env['AGENT_ENV_APP_NAME'] ?? 'agent-env',
    userId: overrides.userId ?? process.env['AGENT_ENV_USER_ID'] ?? 'local-user',
    credentials,
    geminiApiKey: credentials.geminiApiKey,
  });
}

/**
 * Ensure at least one usable provider is configured.
 * Pass `required` to demand specific providers for an agent graph.
 */
export function assertApiKey(
  config: HarnessConfig,
  required: readonly LlmProviderId[] = LLM_PROVIDER_IDS,
): void {
  assertAnyProvider(required, config.credentials);

  // Mirror keys into process.env for native SDK clients.
  const pairs: Array<[string, string | undefined]> = [
    ['GEMINI_API_KEY', config.credentials.geminiApiKey],
    ['CURSOR_API_KEY', config.credentials.cursorApiKey],
    ['OPENAI_API_KEY', config.credentials.openaiApiKey],
    ['OPENAI_BASE_URL', config.credentials.openaiBaseUrl],
    ['ANTHROPIC_API_KEY', config.credentials.anthropicApiKey],
    [
      'OPENAI_COMPATIBLE_BASE_URL',
      config.credentials.openaiCompatibleBaseUrl,
    ],
    [
      'OPENAI_COMPATIBLE_API_KEY',
      config.credentials.openaiCompatibleApiKey,
    ],
  ];
  for (const [key, value] of pairs) {
    if (!process.env[key] && value) {
      process.env[key] = value;
    }
  }
}
