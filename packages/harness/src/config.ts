import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_MODEL,
  harnessConfigSchema,
  type HarnessConfig,
} from '@agent-env/shared';

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

/**
 * Load harness config from process.env.
 * Requires GEMINI_API_KEY (or GOOGLE_API_KEY) for Gemini API calls.
 */
export function loadHarnessConfig(
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  loadDotEnv();

  const geminiApiKey =
    overrides.geminiApiKey ??
    process.env['GEMINI_API_KEY'] ??
    process.env['GOOGLE_API_KEY'];

  return harnessConfigSchema.parse({
    model: overrides.model ?? process.env['AGENT_ENV_MODEL'] ?? DEFAULT_MODEL,
    appName: overrides.appName ?? process.env['AGENT_ENV_APP_NAME'] ?? 'agent-env',
    userId: overrides.userId ?? process.env['AGENT_ENV_USER_ID'] ?? 'local-user',
    geminiApiKey,
  });
}

/** Throws if no API key is configured. */
export function assertApiKey(config: HarnessConfig): void {
  if (!config.geminiApiKey?.trim()) {
    throw new Error(
      'GEMINI_API_KEY (or GOOGLE_API_KEY) is not set. Copy .env.example to .env and add your key.',
    );
  }

  // Ensure ADK / genai clients see the key even if only GOOGLE_API_KEY was provided.
  if (!process.env['GEMINI_API_KEY'] && config.geminiApiKey) {
    process.env['GEMINI_API_KEY'] = config.geminiApiKey;
  }
}
