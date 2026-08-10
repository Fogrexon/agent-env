/**
 * Smoke checks for @agent-env/llm (no network).
 * Run: npx tsx scripts/smoke-llm.ts
 */
import { LLMRegistry } from '@google/adk';
import {
  clearAdkLlmRouting,
  clearProviders,
  createCursorProvider,
  createOpenaiCompatibleProvider,
  formatModelRef,
  isProviderConfigured,
  listProviderIds,
  parseModelRef,
  parseProviderModelId,
  registerAdkLlmRouting,
  registerProvider,
  registerProviders,
  selectModelRef,
} from '@agent-env/llm';
import { DEFAULT_MODEL_REF } from '@agent-env/shared';
import { parseOpenaiCompatibleProvidersJson } from '@agent-env/repo-env';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

clearProviders();

registerProviders({
  gemini: { apiKey: 'test-gemini' },
  openai: { apiKey: () => 'sk-test' },
  openrouter: { apiKey: () => 'sk-or-test' },
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
assert(isProviderConfigured('openrouter'), 'openrouter configured');
assert(isProviderConfigured('lm-studio'), 'lm-studio configured');
assert(isProviderConfigured('ollama'), 'ollama configured');
assert(!isProviderConfigured('cursor'), 'cursor absent');

clearProviders();
registerProviders({
  gemini: {
    vertex: { project: 'demo-project', location: 'us-central1' },
  },
  anthropic: {
    vertex: { projectId: 'demo-project', region: 'us-east5' },
  },
});
assert(isProviderConfigured('gemini'), 'gemini vertex configured');
assert(isProviderConfigured('anthropic'), 'anthropic vertex configured');

clearProviders();
registerProviders({
  gemini: { apiKey: 'test-gemini' },
  openai: { apiKey: () => 'sk-test' },
  openrouter: { apiKey: () => 'sk-or-test' },
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

const ids = listProviderIds().slice().sort();
assert(
  ids.join(',') ===
    ['gemini', 'lm-studio', 'ollama', 'openai', 'openrouter'].sort().join(','),
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
  { provider: 'cursor', model: 'auto' },
  { provider: 'gemini', model: 'gemini-3.6-flash' },
);
assert(picked.provider === 'gemini', 'select fallback');

const lm = parseModelRef('lm-studio:qwen2.5');
assert(lm.provider === 'lm-studio' && lm.model === 'qwen2.5', 'named compatible');

const bare = parseModelRef('gemini-3.6-flash');
assert(bare.provider === 'gemini' && bare.model === 'gemini-3.6-flash', 'bare CLI fallback');

const empty = parseModelRef(undefined);
assert(
  empty.provider === DEFAULT_MODEL_REF.provider &&
    empty.model === DEFAULT_MODEL_REF.model,
  'fallback',
);

const parsed = parseOpenaiCompatibleProvidersJson(
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

// --- provider:model wire format ---------------------------------------------
{
  const wired = formatModelRef({ provider: 'cursor', model: 'auto' });
  assert(wired === 'cursor:auto', 'formatModelRef');

  let bareRejected = false;
  try {
    parseProviderModelId('gemini-3.6-flash');
  } catch {
    bareRejected = true;
  }
  assert(bareRejected, 'parseProviderModelId rejects bare model ids');

  const ok = parseProviderModelId('gemini:gemini-3.6-flash');
  assert(ok.provider === 'gemini' && ok.model === 'gemini-3.6-flash', 'parse ok');
  console.log('✓ formatModelRef / parseProviderModelId');
}

// --- ADK LLMRegistry routing -------------------------------------------------
{
  clearProviders();
  registerProvider(
    createCursorProvider({ apiKey: () => 'offline-smoke-cursor' }),
  );
  clearAdkLlmRouting();
  registerAdkLlmRouting();
  assert(isProviderConfigured('cursor'), 'cursor registered for routing');
  const llm = LLMRegistry.newLlm('cursor:auto');
  assert(llm, 'LLMRegistry.newLlm(cursor:auto)');
  assert(
    typeof (llm as { model?: string }).model === 'string',
    'routed llm has model',
  );
  clearAdkLlmRouting();
  console.log('✓ registerAdkLlmRouting + LLMRegistry.newLlm');
}

console.log('✓ smoke-llm passed');
