import {
  DEFAULT_MODEL_REF,
  harnessConfigSchema,
  type HarnessConfig,
  type LlmProviderId,
  type ModelRef,
} from '@agent-env/shared';
import { assertAnyProvider, parseModelRef } from '@agent-env/llm';

/**
 * Build harness config from explicit overrides only (no process.env).
 * Env / `.env` loading belongs in the app (e.g. `agents/dev-env.ts`), not here.
 */
export function loadHarnessConfig(
  overrides: Partial<HarnessConfig> = {},
): HarnessConfig {
  const defaultModel: ModelRef =
    overrides.defaultModel ??
    (overrides.model ? parseModelRef(overrides.model) : DEFAULT_MODEL_REF);

  return harnessConfigSchema.parse({
    defaultModel,
    model: defaultModel.model,
    appName: overrides.appName ?? 'agent-env',
    userId: overrides.userId ?? 'local-user',
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
