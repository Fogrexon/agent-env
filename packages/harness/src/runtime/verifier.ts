import { spawn } from 'node:child_process';
import type {
  RunSpec,
  SuccessCriterion,
  VerificationResult,
} from '@agent-env/shared';
import { DETERMINISTIC_CRITERION_TYPES } from '@agent-env/shared';
import type { z } from 'zod';

export interface TestSuiteResult {
  passed: boolean;
  detail?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export type TestSuiteRunner = (
  ctx: VerifyContext,
) => Promise<TestSuiteResult> | TestSuiteResult;

/** Zod schema or any object with safeParse compatible with Zod. */
export type SchemaValidator = z.ZodType<unknown> | {
  safeParse: (data: unknown) => { success: boolean; error?: { message?: string } };
};

export interface LlmGradeRequest {
  rubric: string;
  passLabel: string;
  finalText?: string;
  artifacts?: Record<string, unknown>;
}

export interface LlmGradeResult {
  passed: boolean;
  detail?: string;
  raw?: string;
}

export interface VerifyContext {
  finalText?: string;
  /** Structured outputs / tool sinks for deterministic checks. */
  artifacts?: Record<string, unknown>;
  /** Custom predicates keyed by verifierId. */
  custom?: Record<
    string,
    (ctx: VerifyContext) => Promise<boolean> | boolean
  >;
  /** External test runners keyed by successCriteria.test_suite.ref. */
  testSuites?: Record<string, TestSuiteRunner>;
  /** Validators keyed by successCriteria.json_schema.schemaRef. */
  jsonSchemas?: Record<string, SchemaValidator>;
  /**
   * Optional auxiliary LLM grader (separate from the worker agent).
   * Required when a criterion of type llm_grade is present.
   */
  llmGrade?: (req: LlmGradeRequest) => Promise<LlmGradeResult>;
}

const DETERMINISTIC = new Set<string>(DETERMINISTIC_CRITERION_TYPES);

/**
 * Independent evaluation plane (research §6.7 / Phase A).
 * Agent self-declaration is not success — criteria are evaluated here.
 */
export async function verifyRunSpec(
  spec: RunSpec,
  ctx: VerifyContext,
): Promise<VerificationResult> {
  const graderVersion = spec.spec.evaluation.graderVersion;
  const criteria = spec.spec.task.successCriteria;
  const allowLlmAlone = spec.spec.evaluation.allowLlmGradeAlone;

  if (criteria.length === 0) {
    return {
      passed: false,
      graderVersion,
      checks: [
        {
          criterion: 'successCriteria',
          passed: false,
          detail:
            'No successCriteria configured — refuse to treat agent output as success',
        },
      ],
      evidenceRefs: [],
    };
  }

  const checks: VerificationResult['checks'] = [];
  for (const criterion of criteria) {
    checks.push(await evaluateCriterion(criterion, ctx));
  }

  const hasLlmGrade = criteria.some((c) => c.type === 'llm_grade');
  // `contains` is soft / self-report-prone — does not satisfy the companion rule.
  const hasHardDeterministic = criteria.some((c) => DETERMINISTIC.has(c.type));

  let passed = checks.every((c) => c.passed);

  if (hasLlmGrade && !hasHardDeterministic && !allowLlmAlone) {
    passed = false;
    checks.push({
      criterion: 'policy:allowLlmGradeAlone',
      passed: false,
      detail:
        'llm_grade requires a deterministic criterion (test_suite / json_schema / artifact_* / custom), or set evaluation.allowLlmGradeAlone',
    });
  }

  return {
    passed,
    graderVersion,
    checks,
    evidenceRefs: Object.keys(ctx.artifacts ?? {}).map((k) => `artifact:${k}`),
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
        detail: passed
          ? 'found (soft / self-report-prone)'
          : 'missing',
      };
    }
    case 'custom': {
      const fn = ctx.custom?.[criterion.verifierId];
      if (!fn) {
        return {
          criterion: `custom:${criterion.verifierId}`,
          passed: false,
          detail: 'verifier not registered in VerifyContext.custom',
        };
      }
      const passed = await fn(ctx);
      return {
        criterion: `custom:${criterion.verifierId}`,
        passed,
      };
    }
    case 'test_suite': {
      const runner = ctx.testSuites?.[criterion.ref];
      if (!runner) {
        return {
          criterion: `test_suite:${criterion.ref}`,
          passed: false,
          detail: 'test suite not registered in VerifyContext.testSuites',
        };
      }
      const result = await runner(ctx);
      return {
        criterion: `test_suite:${criterion.ref}`,
        passed: result.passed,
        detail: result.detail
          ?? (result.exitCode != null ? `exit=${result.exitCode}` : undefined),
      };
    }
    case 'json_schema': {
      const validator = ctx.jsonSchemas?.[criterion.schemaRef];
      if (!validator) {
        return {
          criterion: `json_schema:${criterion.schemaRef}`,
          passed: false,
          detail: 'schema not registered in VerifyContext.jsonSchemas',
        };
      }
      const data = ctx.artifacts?.[criterion.artifactKey];
      if (data === undefined) {
        return {
          criterion: `json_schema:${criterion.schemaRef}`,
          passed: false,
          detail: `artifact "${criterion.artifactKey}" missing`,
        };
      }
      const parsed = validator.safeParse(data);
      return {
        criterion: `json_schema:${criterion.schemaRef}`,
        passed: parsed.success,
        detail: parsed.success
          ? `artifact:${criterion.artifactKey}`
          : formatParseError(parsed),
      };
    }
    case 'artifact_equals': {
      const actual = ctx.artifacts?.[criterion.key];
      const passed =
        JSON.stringify(actual) === JSON.stringify(criterion.expected);
      return {
        criterion: `artifact_equals:${criterion.key}`,
        passed,
        detail: passed ? 'match' : 'mismatch',
      };
    }
    case 'artifact_path_exists': {
      const passed = ctx.artifacts?.[criterion.key] !== undefined;
      return {
        criterion: `artifact_path_exists:${criterion.key}`,
        passed,
        detail: passed ? 'present' : 'missing',
      };
    }
    case 'llm_grade': {
      if (!ctx.llmGrade) {
        return {
          criterion: `llm_grade:${criterion.passLabel}`,
          passed: false,
          detail: 'llmGrade function not provided in VerifyContext',
        };
      }
      const result = await ctx.llmGrade({
        rubric: criterion.rubric,
        passLabel: criterion.passLabel,
        finalText: ctx.finalText,
        artifacts: ctx.artifacts,
      });
      return {
        criterion: `llm_grade:${criterion.passLabel}`,
        passed: result.passed,
        detail: result.detail ?? (result.passed ? 'PASS' : 'FAIL'),
      };
    }
    default: {
      const _exhaustive: never = criterion;
      return { criterion: String(_exhaustive), passed: false };
    }
  }
}

export interface CreateCommandTestSuiteOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  expectExitCode?: number;
  expectStdoutIncludes?: string;
}

/**
 * Deterministic test suite: run a process outside the agent and check exit/stdout.
 */
export function createCommandTestSuite(
  options: CreateCommandTestSuiteOptions,
): TestSuiteRunner {
  const expectExit = options.expectExitCode ?? 0;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return async () => {
    try {
      const { stdout, stderr, exitCode } = await runProcess({
        command: options.command,
        args: options.args ?? [],
        cwd: options.cwd,
        env: options.env,
        timeoutMs,
      });
      if (exitCode !== expectExit) {
        return {
          passed: false,
          exitCode,
          stdout,
          stderr,
          detail: `expected exit ${expectExit}, got ${exitCode}`,
        };
      }
      if (
        options.expectStdoutIncludes &&
        !stdout.includes(options.expectStdoutIncludes)
      ) {
        return {
          passed: false,
          exitCode,
          stdout,
          stderr,
          detail: `stdout missing ${JSON.stringify(options.expectStdoutIncludes)}`,
        };
      }
      return { passed: true, exitCode, stdout, stderr, detail: 'ok' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { passed: false, detail: message };
    }
  };
}

/**
 * Build an llmGrade callback from a raw text generator (caller supplies the model).
 * Expects the model to answer with the passLabel (default PASS) or FAIL.
 */
export function createTextLlmGrader(options: {
  generate: (prompt: string) => Promise<string>;
}): NonNullable<VerifyContext['llmGrade']> {
  return async (req) => {
    const prompt = [
      'You are an independent grader. Do NOT solve the task; only grade.',
      `Rubric: ${req.rubric}`,
      `Reply with exactly one token: ${req.passLabel} or FAIL.`,
      '',
      '--- agent final text ---',
      req.finalText ?? '(empty)',
      '',
      '--- artifacts (JSON) ---',
      JSON.stringify(req.artifacts ?? {}, null, 2),
    ].join('\n');
    const raw = (await options.generate(prompt)).trim();
    const passed = new RegExp(`\\b${escapeRegExp(req.passLabel)}\\b`, 'i').test(
      raw,
    );
    return { passed, detail: raw.slice(0, 200), raw };
  };
}

function formatParseError(parsed: {
  success: boolean;
  error?: { message?: string };
}): string {
  if (parsed.success) return 'ok';
  return parsed.error?.message?.slice(0, 300) ?? 'schema mismatch';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runProcess(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      ...(options.env ? { env: options.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}
