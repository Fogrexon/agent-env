import {
  createOpenaiCompatibleProvider,
  hasProvider,
  registerProvider,
  registerProviders,
  type RegisterProvidersConfig,
} from '@agent-env/llm';

export interface OpenaiCompatibleEnvEntry {
  id: string;
  baseUrl: string;
  /** Name of env var that holds the API key (optional). */
  apiKeyEnv?: string;
}

/**
 * Parse OPENAI_COMPATIBLE_PROVIDERS JSON, e.g.
 * [{"id":"lm-studio","baseUrl":"http://127.0.0.1:1234/v1","apiKeyEnv":"LM_STUDIO_API_KEY"},
 *  {"id":"ollama","baseUrl":"http://127.0.0.1:11434/v1"}]
 */
export function parseOpenaiCompatibleProvidersEnv(
  raw: string | undefined,
): OpenaiCompatibleEnvEntry[] {
  if (!raw?.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('OPENAI_COMPATIBLE_PROVIDERS must be a JSON array');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`OPENAI_COMPATIBLE_PROVIDERS[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'].trim() : '';
    const baseUrl =
      typeof row['baseUrl'] === 'string' ? row['baseUrl'].trim() : '';
    if (!id || !baseUrl) {
      throw new Error(
        `OPENAI_COMPATIBLE_PROVIDERS[${index}] requires id and baseUrl`,
      );
    }
    const apiKeyEnv =
      typeof row['apiKeyEnv'] === 'string' && row['apiKeyEnv'].trim()
        ? row['apiKeyEnv'].trim()
        : undefined;
    return { id, baseUrl, apiKeyEnv };
  });
}

/**
 * Optional harness convenience: register providers from process.env.
 *
 * This is NOT part of the LLM core contract — your app may instead call
 * `registerProviders` / `createOpenaiCompatibleProvider` with secrets from
 * any source (Vault, CLI flags, …). Env is just one implementation choice.
 *
 * Idempotent for well-known ids already present.
 */
export function bootstrapProvidersFromEnv(): void {
  const config: RegisterProvidersConfig = { replace: false };

  const geminiKey =
    process.env['GEMINI_API_KEY']?.trim() ||
    process.env['GOOGLE_API_KEY']?.trim();
  if (geminiKey && !hasProvider('gemini')) {
    config.gemini = { apiKey: () => process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'] };
  }

  if (process.env['CURSOR_API_KEY']?.trim() && !hasProvider('cursor')) {
    config.cursor = { apiKey: () => process.env['CURSOR_API_KEY'] };
  }

  if (process.env['OPENAI_API_KEY']?.trim() && !hasProvider('openai')) {
    config.openai = {
      apiKey: () => process.env['OPENAI_API_KEY'],
      baseUrl: () => process.env['OPENAI_BASE_URL'],
    };
  }

  if (process.env['ANTHROPIC_API_KEY']?.trim() && !hasProvider('anthropic')) {
    config.anthropic = { apiKey: () => process.env['ANTHROPIC_API_KEY'] };
  }

  try {
    registerProviders(config);
  } catch (err) {
    // replace:false may race; ignore "already registered"
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('already registered')) throw err;
  }

  const fromJson = parseOpenaiCompatibleProvidersEnv(
    process.env['OPENAI_COMPATIBLE_PROVIDERS'],
  );
  for (const entry of fromJson) {
    if (hasProvider(entry.id)) continue;
    const apiKeyEnv = entry.apiKeyEnv;
    registerProvider(
      createOpenaiCompatibleProvider({
        id: entry.id,
        baseUrl: entry.baseUrl,
        apiKey: apiKeyEnv
          ? () => process.env[apiKeyEnv]
          : undefined,
      }),
      { replace: false },
    );
  }

  // Single-endpoint shorthand → provider id "openai-compatible"
  const singleBase =
    process.env['OPENAI_COMPATIBLE_BASE_URL']?.trim() ||
    process.env['LM_STUDIO_BASE_URL']?.trim();
  if (singleBase && !hasProvider('openai-compatible')) {
    registerProvider(
      createOpenaiCompatibleProvider({
        id: 'openai-compatible',
        baseUrl: () =>
          process.env['OPENAI_COMPATIBLE_BASE_URL'] ??
          process.env['LM_STUDIO_BASE_URL'],
        apiKey: () =>
          process.env['OPENAI_COMPATIBLE_API_KEY'] ??
          process.env['LM_STUDIO_API_KEY'],
      }),
      { replace: false },
    );
  }
}
