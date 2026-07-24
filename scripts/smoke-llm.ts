/**
 * Smoke checks for @agent-env/llm (no network / no API keys required).
 * Run: npx tsx scripts/smoke-llm.ts
 */
import {
  parseModelRef,
  selectModelRef,
  isProviderConfigured,
  loadProviderCredentials,
} from '@agent-env/llm';
import { DEFAULT_MODEL_REF } from '@agent-env/shared';

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

const json = parseModelRef(
  JSON.stringify({ provider: 'gemini', model: 'gemini-2.5-flash' }),
);
assert(json.provider === 'gemini' && json.model === 'gemini-2.5-flash', 'json');

const empty = parseModelRef(undefined);
assert(
  empty.provider === DEFAULT_MODEL_REF.provider &&
    empty.model === DEFAULT_MODEL_REF.model,
  'fallback',
);

const creds = loadProviderCredentials({ geminiApiKey: 'x', cursorApiKey: undefined });
const picked = selectModelRef(
  { provider: 'cursor', model: 'composer-2' },
  { provider: 'gemini', model: 'gemini-2.5-flash' },
  creds,
);
assert(picked.provider === 'gemini', 'select fallback when cursor missing');
assert(isProviderConfigured('gemini', creds), 'gemini configured');
assert(!isProviderConfigured('cursor', creds), 'cursor not configured');

console.log('✓ smoke-llm passed');
