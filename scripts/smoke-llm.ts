/**
 * Smoke checks for @agent-env/llm (no network / no API keys required).
 * Run: npx tsx scripts/smoke-llm.ts
 */
import {
  parseModelRef,
  selectModelRef,
  isProviderConfigured,
  loadProviderCredentials,
  listProviders,
} from '@agent-env/llm';
import { DEFAULT_MODEL_REF, LLM_PROVIDER_IDS } from '@agent-env/shared';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const bare = parseModelRef('gemini-2.5-pro');
assert(bare.provider === 'gemini' && bare.model === 'gemini-2.5-pro', 'bare model');

const qualified = parseModelRef('cursor:composer-2');
assert(
  qualified.provider === 'cursor' && qualified.model === 'composer-2',
  'qualified',
);

const openaiRef = parseModelRef('openai:gpt-4o-mini');
assert(openaiRef.provider === 'openai' && openaiRef.model === 'gpt-4o-mini', 'openai');

const anthropicRef = parseModelRef('anthropic:claude-sonnet-4-5');
assert(
  anthropicRef.provider === 'anthropic' &&
    anthropicRef.model === 'claude-sonnet-4-5',
  'anthropic',
);

const compatible = parseModelRef('openai-compatible:llama-3.2');
assert(
  compatible.provider === 'openai-compatible' &&
    compatible.model === 'llama-3.2',
  'openai-compatible',
);

const json = parseModelRef(
  JSON.stringify({
    provider: 'openai-compatible',
    model: 'local-model',
    params: { baseUrl: 'http://127.0.0.1:1234/v1' },
  }),
);
assert(json.provider === 'openai-compatible', 'json provider');
assert(json.params?.['baseUrl'] === 'http://127.0.0.1:1234/v1', 'json params');

const empty = parseModelRef(undefined);
assert(
  empty.provider === DEFAULT_MODEL_REF.provider &&
    empty.model === DEFAULT_MODEL_REF.model,
  'fallback',
);

const creds = loadProviderCredentials({
  geminiApiKey: 'x',
  cursorApiKey: undefined,
  openaiApiKey: 'sk-test',
  anthropicApiKey: undefined,
  openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
});
const picked = selectModelRef(
  { provider: 'cursor', model: 'composer-2' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  creds,
);
assert(picked.provider === 'gemini', 'select fallback when cursor missing');
assert(isProviderConfigured('gemini', creds), 'gemini configured');
assert(isProviderConfigured('openai', creds), 'openai configured');
assert(isProviderConfigured('openai-compatible', creds), 'compatible configured');
assert(!isProviderConfigured('cursor', creds), 'cursor not configured');
assert(!isProviderConfigured('anthropic', creds), 'anthropic not configured');

const ids = listProviders().map((p) => p.id).sort();
assert(
  ids.join(',') === [...LLM_PROVIDER_IDS].sort().join(','),
  'registry matches LLM_PROVIDER_IDS',
);

console.log('✓ smoke-llm passed');
