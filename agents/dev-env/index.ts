/**
 * Env wiring for agents/scripts in this repo — not part of @agent-env/* packages.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createOpenaiCompatibleProvider,
  hasProvider,
  registerProvider,
  registerProviders,
  type RegisterProvidersConfig,
} from '@agent-env/harness';

/** Lightweight .env loader. Does not override existing process.env keys. */
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

export interface OpenaiCompatibleEnvEntry {
  id: string;
  baseUrl: string;
  apiKeyEnv?: string;
}

/** Pure JSON parser for OPENAI_COMPATIBLE_PROVIDERS-shaped config. */
export function parseOpenaiCompatibleProvidersJson(
  raw: string | undefined,
): OpenaiCompatibleEnvEntry[] {
  if (!raw?.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('openai-compatible providers JSON must be an array');
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`providers[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'].trim() : '';
    const baseUrl =
      typeof row['baseUrl'] === 'string' ? row['baseUrl'].trim() : '';
    if (!id || !baseUrl) {
      throw new Error(`providers[${index}] requires id and baseUrl`);
    }
    const apiKeyEnv =
      typeof row['apiKeyEnv'] === 'string' && row['apiKeyEnv'].trim()
        ? row['apiKeyEnv'].trim()
        : undefined;
    return { id, baseUrl, apiKeyEnv };
  });
}

/** Register LLM providers from process.env (this app's convention). */
export function bootstrapProvidersFromEnv(): void {
  const config: RegisterProvidersConfig = { replace: false };

  const geminiKey =
    process.env['GEMINI_API_KEY']?.trim() ||
    process.env['GOOGLE_API_KEY']?.trim();
  if (geminiKey && !hasProvider('gemini')) {
    config.gemini = {
      apiKey: () => process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'],
    };
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
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('already registered')) throw err;
  }

  for (const entry of parseOpenaiCompatibleProvidersJson(
    process.env['OPENAI_COMPATIBLE_PROVIDERS'],
  )) {
    if (hasProvider(entry.id)) continue;
    const apiKeyEnv = entry.apiKeyEnv;
    registerProvider(
      createOpenaiCompatibleProvider({
        id: entry.id,
        baseUrl: entry.baseUrl,
        apiKey: apiKeyEnv ? () => process.env[apiKeyEnv] : undefined,
      }),
      { replace: false },
    );
  }

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
