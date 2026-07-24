/**
 * Smoke checks for @agent-env/llm (no network).
 * Run: npx tsx scripts/smoke-llm.ts
 */
import {
  clearProviders,
  createOpenaiCompatibleProvider,
  isProviderConfigured,
  listProviderIds,
  parseModelRef,
  registerProvider,
  registerProviders,
  selectModelRef,
} from '@agent-env/llm';
import { parseOpenaiCompatibleProvidersEnv } from '@agent-env/harness';
import { DEFAULT_MODEL_REF } from '@agent-env/shared';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

clearProviders();

registerProviders({
  gemini: { apiKey: 'test-gemini' },
  openai: { apiKey: () => 'sk-test' },
  openaiCompatible: [
    {
      id: 'lm-studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: () => process.env['LM_STUDIO_API_KEY'],
    },
    {
      id: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    },
  ],
});

assert(isProviderConfigured('gemini'), 'gemini configured');
assert(isProviderConfigured('openai'), 'openai configured');
assert(isProviderConfigured('lm-studio'), 'lm-studio configured');
assert(isProviderConfigured('ollama'), 'ollama configured');
assert(!isProviderConfigured('cursor'), 'cursor absent');

const ids = listProviderIds().slice().sort();
assert(
  ids.join(',') === ['gemini', 'lm-studio', 'ollama', 'openai'].sort().join(','),
  `ids=${ids.join(',')}`,
);

registerProvider(
  createOpenaiCompatibleProvider({
    id: 'vllm',
    baseUrl: () => 'http://127.0.0.1:8000/v1',
    apiKey: 'unused',
  }),
);
assert(isProviderConfigured('vllm'), 'vllm configured');

const picked = selectModelRef(
  { provider: 'cursor', model: 'composer-2' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
);
assert(picked.provider === 'gemini', 'select fallback');

const lm = parseModelRef('lm-studio:qwen2.5');
assert(lm.provider === 'lm-studio' && lm.model === 'qwen2.5', 'named compatible');

const empty = parseModelRef(undefined);
assert(
  empty.provider === DEFAULT_MODEL_REF.provider &&
    empty.model === DEFAULT_MODEL_REF.model,
  'fallback',
);

const parsed = parseOpenaiCompatibleProvidersEnv(
  JSON.stringify([
    {
      id: 'lm-studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKeyEnv: 'LM_STUDIO_API_KEY',
    },
    { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  ]),
);
assert(parsed.length === 2, 'parse multi compatible');
assert(parsed[0]?.apiKeyEnv === 'LM_STUDIO_API_KEY', 'apiKeyEnv');

console.log('✓ smoke-llm passed');
