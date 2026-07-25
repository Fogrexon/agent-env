import {
  runSpecSchema,
  type ModelRef,
  type RunSpec,
} from '@agent-env/shared';

function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

export function parseRunSpec(raw: unknown): RunSpec {
  return runSpecSchema.parse(raw);
}

/**
 * Resolve effective model and validate against RunSpec.allowed when present.
 * When `override` is omitted, returns `spec.model.primary`.
 */
export function resolveRunSpecModel(
  spec: RunSpec,
  override?: ModelRef,
): ModelRef {
  const primary = spec.spec.model.primary;
  const chosen = override ?? primary;
  const allowed = spec.spec.model.allowed;
  if (allowed && allowed.length > 0) {
    const allowKeys = new Set(allowed.map(modelRefKey));
    allowKeys.add(modelRefKey(primary));
    if (!allowKeys.has(modelRefKey(chosen))) {
      throw new Error(
        `Model "${modelRefKey(chosen)}" is not allowed by RunSpec (allowed: ${[
          ...allowKeys,
        ].join(', ')})`,
      );
    }
  }
  return chosen;
}

/**
 * Fields that map 1:1 onto the effective RunSpec document for one attempt.
 * Overrides produce an **effective** RunSpec; they do not rewrite the on-disk
 * template JSON.
 */
export interface RunSpecOverrides {
  /** Replaces `spec.task.objective` when non-empty. */
  objective?: string;
  /** Replaces the structured per-run input snapshot. */
  inputs?: Record<string, unknown>;
  /**
   * Replaces `spec.model.primary` when set.
   * Must appear in `model.allowed` when that list is present (primary always ok).
   */
  model?: ModelRef;
}

/**
 * Merge admin/CLI overrides into a copy of a RunSpec, then re-validate.
 * The result is the sole intent document for `runFromSpec`.
 */
export function applyRunSpecOverrides(
  base: unknown,
  overrides: RunSpecOverrides = {},
): RunSpec {
  const parsed = parseRunSpec(base);
  const draft = structuredClone(parsed) as RunSpec;

  const objective = overrides.objective?.trim();
  if (objective) {
    draft.spec.task.objective = objective;
  }
  if (overrides.inputs) {
    draft.spec.task.inputs = structuredClone(overrides.inputs);
  }

  if (overrides.model) {
    draft.spec.model.primary = resolveRunSpecModel(draft, overrides.model);
  }

  return parseRunSpec(draft);
}
