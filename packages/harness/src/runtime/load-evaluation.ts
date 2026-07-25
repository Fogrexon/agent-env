import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  evaluationSpecSchema,
  type EvaluationSpec,
  type RunSpec,
} from '@agent-env/shared';

export function parseEvaluationSpec(raw: unknown): EvaluationSpec {
  return evaluationSpecSchema.parse(raw);
}

/**
 * Load EvaluationSpec referenced by RunSpec.spec.evaluation.ref.
 * Relative refs resolve against `baseDir` (typically the agent directory).
 */
export function loadEvaluationSpec(
  spec: RunSpec,
  baseDir: string,
): EvaluationSpec {
  const ref = spec.spec.evaluation.ref;
  const abs = isAbsolute(ref) ? ref : resolve(baseDir, ref);
  const raw = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
  return parseEvaluationSpec(raw);
}
