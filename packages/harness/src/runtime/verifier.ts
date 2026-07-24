import type {
  RunSpec,
  SuccessCriterion,
  VerificationResult,
} from '@agent-env/shared';

export interface VerifyContext {
  finalText?: string;
  artifacts?: Record<string, unknown>;
  /** Optional custom verifiers keyed by verifierId. */
  custom?: Record<
    string,
    (ctx: VerifyContext) => Promise<boolean> | boolean
  >;
}

/**
 * Independent evaluation plane helper (research §6.7).
 * Runs outside the agent policy — agent self-declaration is not success.
 */
export async function verifyRunSpec(
  spec: RunSpec,
  ctx: VerifyContext,
): Promise<VerificationResult> {
  const graderVersion = spec.spec.evaluation.graderVersion;
  const criteria = spec.spec.task.successCriteria;
  if (criteria.length === 0) {
    return {
      passed: Boolean(ctx.finalText?.trim()),
      graderVersion,
      checks: [
        {
          criterion: 'non_empty_output',
          passed: Boolean(ctx.finalText?.trim()),
          detail: 'No successCriteria; require non-empty finalText',
        },
      ],
      evidenceRefs: [],
    };
  }

  const checks: VerificationResult['checks'] = [];
  for (const criterion of criteria) {
    checks.push(await evaluateCriterion(criterion, ctx));
  }

  return {
    passed: checks.every((c) => c.passed),
    graderVersion,
    checks,
    evidenceRefs: [],
  };
}

async function evaluateCriterion(
  criterion: SuccessCriterion,
  ctx: VerifyContext,
): Promise<VerificationResult['checks'][number]> {
  switch (criterion.type) {
    case 'contains': {
      const hay = criterion.caseInsensitive
        ? (ctx.finalText ?? '').toLowerCase()
        : (ctx.finalText ?? '');
      const needle = criterion.caseInsensitive
        ? criterion.text.toLowerCase()
        : criterion.text;
      const passed = hay.includes(needle);
      return {
        criterion: `contains:${criterion.text}`,
        passed,
        detail: passed ? 'found' : 'missing',
      };
    }
    case 'custom': {
      const fn = ctx.custom?.[criterion.verifierId];
      if (!fn) {
        return {
          criterion: `custom:${criterion.verifierId}`,
          passed: false,
          detail: 'verifier not registered',
        };
      }
      const passed = await fn(ctx);
      return {
        criterion: `custom:${criterion.verifierId}`,
        passed,
      };
    }
    case 'test_suite':
      return {
        criterion: `test_suite:${criterion.ref}`,
        passed: false,
        detail: 'test_suite verifier not wired in Phase A sample',
      };
    case 'json_schema':
      return {
        criterion: `json_schema:${criterion.schemaRef}`,
        passed: false,
        detail: 'json_schema verifier not wired in Phase A sample',
      };
    default: {
      const _exhaustive: never = criterion;
      return { criterion: String(_exhaustive), passed: false };
    }
  }
}
