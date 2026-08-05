import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import type {
  VerificationCheck,
  VerificationCheckResult,
  VerificationPlan,
  VerificationResult,
  VerifyBaseDir,
} from '@agent-env/shared';
import { verificationResultSchema } from '@agent-env/shared';
import {
  createDefaultProcessRunner,
  type ProcessRunner,
} from '../runtime/process-runner.js';

export interface GraderOutcome {
  passed: boolean;
  score?: number;
  detail?: string;
  evidenceRefs?: string[];
}

export interface ExecuteVerificationContext {
  finalText?: string;
  /** Repo / project root. Base for `baseDir: 'repo'` and schemaRef paths. */
  cwd?: string;
  /**
   * Per-run workspace directory (artifacts the agent wrote).
   * Base for `baseDir: 'workspace'` criteria.
   */
  workspaceDir?: string;
  /**
   * Run evidence events. Lets custom verifiers cross-check claims against the
   * append-only log instead of trusting the agent's narration.
   */
  events?: readonly unknown[];
  /** Injected for tests; defaults to a spawn-based runner. */
  processRunner?: ProcessRunner;
  /** Optional custom verifiers keyed by verifierId. */
  custom?: Record<
    string,
    (ctx: ExecuteVerificationContext) => Promise<boolean> | boolean
  >;
  /** Host/agent-registered agent graders keyed by graderId. */
  agentGraders?: Record<
    string,
    (
      ctx: ExecuteVerificationContext,
    ) => Promise<GraderOutcome> | GraderOutcome
  >;
}

/** Resolve a check path against the workspace or the repo root. */
function baseDirFor(
  base: VerifyBaseDir,
  ctx: ExecuteVerificationContext,
): string | undefined {
  if (base === 'workspace') return ctx.workspaceDir;
  return ctx.cwd ?? process.cwd();
}

function resolveUnder(base: string, path: string | undefined): string {
  if (!path) return base;
  return isAbsolute(path) ? path : resolve(base, path);
}

function listWorkspaceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  walk(root);
  return out;
}

function mimeFromExtension(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.md':
      return 'text/markdown';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

function findArtifactPath(
  artifactId: string,
  mediaTypes: readonly string[],
  ctx: ExecuteVerificationContext,
): string | undefined {
  if (!ctx.workspaceDir) return undefined;
  return listWorkspaceFiles(ctx.workspaceDir).find((path) => {
    const stem = basename(path, extname(path));
    return stem === artifactId && mediaTypes.includes(mimeFromExtension(path));
  });
}

/**
 * Resolve a path by artifact id, preferring text-friendly media for document checks.
 */
function findArtifactPathById(
  artifactId: string,
  ctx: ExecuteVerificationContext,
  preferMediaTypes: readonly string[] = ['text/markdown', 'text/html'],
): string | undefined {
  if (!ctx.workspaceDir) return undefined;
  const candidates = listWorkspaceFiles(ctx.workspaceDir).filter((path) => {
    const stem = basename(path, extname(path));
    return stem === artifactId;
  });
  if (candidates.length === 0) return undefined;
  const ranked = [...candidates].sort((a, b) => {
    const rank = (path: string): number =>
      preferMediaTypes.includes(mimeFromExtension(path)) ? 0 : 1;
    return rank(a) - rank(b);
  });
  return ranked[0];
}

/** Match ATX headings (`#`…`######`) whose title equals `title` (case-insensitive). */
export function hasMarkdownHeading(
  text: string,
  title: string,
  minLevel = 1,
  maxLevel = 3,
): boolean {
  const lo = Math.min(minLevel, maxLevel);
  const hi = Math.max(minLevel, maxLevel);
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#{${lo},${hi}}\\s+${escaped}\\s*$`, 'im');
  return re.test(text);
}

/** Match `<hN>…</hN>` titles (nested tags stripped, case-insensitive). */
export function hasHtmlHeading(
  html: string,
  title: string,
  minLevel = 1,
  maxLevel = 3,
): boolean {
  const lo = Math.min(minLevel, maxLevel);
  const hi = Math.max(minLevel, maxLevel);
  const want = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const re = new RegExp(
    `<h([${lo}-${hi}])\\b[^>]*>([\\s\\S]*?)<\\/h\\1>`,
    'gi',
  );
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const inner = (match[2] ?? '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
    if (inner === want) return true;
  }
  return false;
}

function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('empty finalText');
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // fall through to fenced / brace extraction
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim()) as unknown;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
  }
  throw new Error('no JSON object found in finalText');
}

type CheckEval = {
  result: VerificationCheckResult;
  evidenceRefs: string[];
};

async function evaluateCheck(
  check: VerificationCheck,
  ctx: ExecuteVerificationContext,
): Promise<CheckEval> {
  switch (check.kind) {
    case 'nonEmpty': {
      const passed = Boolean(ctx.finalText?.trim());
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed,
          detail: passed ? 'non-empty final output' : 'empty final output',
        },
        evidenceRefs: [],
      };
    }
    case 'contains': {
      const hay = check.caseInsensitive
        ? (ctx.finalText ?? '').toLowerCase()
        : (ctx.finalText ?? '');
      const needle = check.caseInsensitive
        ? check.text.toLowerCase()
        : check.text;
      const passed = hay.includes(needle);
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed,
          detail: passed ? `found "${check.text}"` : `missing "${check.text}"`,
        },
        evidenceRefs: [],
      };
    }
    case 'artifact': {
      if (!ctx.workspaceDir) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: 'workspace directory unavailable',
          },
          evidenceRefs: [],
        };
      }
      const path = findArtifactPath(check.artifactId, check.mediaTypes, ctx);
      const label = `${check.artifactId} [${check.mediaTypes.join(',')}]`;
      if (!path) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: !check.required,
            detail: check.required ? `${label}: missing` : `${label}: optional missing`,
          },
          evidenceRefs: [],
        };
      }
      const size = statSync(path).size;
      if (size < check.minBytes) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: `${label}: ${size}B < ${check.minBytes}B`,
          },
          evidenceRefs: [],
        };
      }
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed: true,
          detail: `${label} present (${size}B)`,
        },
        evidenceRefs: [path],
      };
    }
    case 'document': {
      let text: string;
      let source: string;
      let evidenceRefs: string[] = [];
      let mimeHint = 'text/markdown';
      if (check.sourcePath) {
        const base = baseDirFor(check.baseDir, ctx);
        if (!base) {
          return {
            result: {
              id: check.id,
              kind: check.kind,
              severity: check.severity,
              passed: false,
              detail: `no ${check.baseDir} directory available in verify context`,
            },
            evidenceRefs: [],
          };
        }
        const abs = resolveUnder(base, check.sourcePath);
        try {
          text = readFileSync(abs, 'utf8');
          source = check.sourcePath;
          mimeHint = mimeFromExtension(abs);
          evidenceRefs = [abs];
        } catch (err) {
          return {
            result: {
              id: check.id,
              kind: check.kind,
              severity: check.severity,
              passed: false,
              detail: `failed to read ${check.sourcePath}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
            evidenceRefs: [],
          };
        }
      } else if (check.artifactId) {
        const path = findArtifactPathById(check.artifactId, ctx);
        if (!path) {
          return {
            result: {
              id: check.id,
              kind: check.kind,
              severity: check.severity,
              passed: false,
              detail: `${check.artifactId}: missing`,
            },
            evidenceRefs: [],
          };
        }
        text = readFileSync(path, 'utf8');
        source = check.artifactId;
        mimeHint = mimeFromExtension(path);
        evidenceRefs = [path];
      } else {
        text = ctx.finalText ?? '';
        source = 'finalText';
      }
      const isHtml =
        mimeHint === 'text/html' || /<\/?[hH][1-6]\b/.test(text);
      const missing = check.sections.filter((section) =>
        isHtml
          ? !hasHtmlHeading(text, section, check.minLevel, check.maxLevel)
          : !hasMarkdownHeading(text, section, check.minLevel, check.maxLevel),
      );
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed: missing.length === 0,
          detail:
            missing.length === 0
              ? `all required sections present (${source})`
              : `missing sections in ${source}: ${missing.join(', ')}`,
        },
        evidenceRefs,
      };
    }
    case 'jsonSchema': {
      const repoRoot = ctx.cwd ?? process.cwd();
      const schemaPath = isAbsolute(check.schemaRef)
        ? check.schemaRef
        : resolve(repoRoot, check.schemaRef);
      let schema: unknown;
      try {
        schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
      } catch (err) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: `failed to load schema: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          evidenceRefs: [],
        };
      }

      let data: unknown;
      let source: string;
      const evidenceRefs: string[] = [];
      if (check.sourcePath) {
        const base = baseDirFor(check.baseDir, ctx);
        if (!base) {
          return {
            result: {
              id: check.id,
              kind: check.kind,
              severity: check.severity,
              passed: false,
              detail: `no ${check.baseDir} directory available in verify context`,
            },
            evidenceRefs: [],
          };
        }
        const abs = resolveUnder(base, check.sourcePath);
        source = check.sourcePath;
        try {
          data = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
          evidenceRefs.push(abs);
        } catch (err) {
          return {
            result: {
              id: check.id,
              kind: check.kind,
              severity: check.severity,
              passed: false,
              detail: `failed to read ${source}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
            evidenceRefs: [],
          };
        }
      } else {
        source = 'finalText';
        try {
          data = extractJsonValue(ctx.finalText ?? '');
        } catch (err) {
          return {
            result: {
              id: check.id,
              kind: check.kind,
              severity: check.severity,
              passed: false,
              detail: `JSON extract failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            },
            evidenceRefs: [],
          };
        }
      }

      const ajv = new Ajv({ allErrors: true, strict: false });
      let validate;
      try {
        validate = ajv.compile(schema as object);
      } catch (err) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: `invalid schema: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          evidenceRefs,
        };
      }
      const passed = Boolean(validate(data));
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed,
          detail: passed
            ? `${source} satisfies schema`
            : `${source}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
        },
        evidenceRefs,
      };
    }
    case 'command': {
      const base = baseDirFor(check.baseDir, ctx);
      if (!base) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: `no ${check.baseDir} directory available in verify context`,
          },
          evidenceRefs: [],
        };
      }
      const runner = ctx.processRunner ?? createDefaultProcessRunner();
      let result;
      try {
        result = await runner({
          bin: check.bin,
          args: [...check.args],
          cwd: resolveUnder(base, check.subdir),
          timeoutMs: check.timeoutMs,
          maxOutputBytes: 64_000,
          shell: check.shell,
        });
      } catch (err) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: `spawn failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
          evidenceRefs: [],
        };
      }
      if (result.timedOut) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: `timed out after ${check.timeoutMs}ms`,
          },
          evidenceRefs: [],
        };
      }
      if (result.exitCode !== check.expectExitCode) {
        const tail = (result.stderr || result.stdout).trim().slice(-400);
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: `exit ${result.exitCode} (expected ${check.expectExitCode})${
              tail ? `: ${tail}` : ''
            }`,
          },
          evidenceRefs: [],
        };
      }
      if (check.outputContains) {
        const combined = `${result.stdout}\n${result.stderr}`;
        if (!combined.includes(check.outputContains)) {
          return {
            result: {
              id: check.id,
              kind: check.kind,
              severity: check.severity,
              passed: false,
              detail: `output missing "${check.outputContains}"`,
            },
            evidenceRefs: [],
          };
        }
      }
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed: true,
          detail: `exit ${result.exitCode}`,
        },
        evidenceRefs: [],
      };
    }
    case 'custom': {
      const fn = ctx.custom?.[check.verifierId];
      if (!fn) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: 'verifier not registered',
          },
          evidenceRefs: [],
        };
      }
      const passed = await fn(ctx);
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed,
        },
        evidenceRefs: [],
      };
    }
    case 'agent': {
      const grader = ctx.agentGraders?.[check.graderId];
      if (!grader) {
        return {
          result: {
            id: check.id,
            kind: check.kind,
            severity: check.severity,
            passed: false,
            detail: 'agent grader not registered',
          },
          evidenceRefs: [],
        };
      }
      const outcome = await grader(ctx);
      return {
        result: {
          id: check.id,
          kind: check.kind,
          severity: check.severity,
          passed: outcome.passed,
          detail: outcome.detail,
        },
        evidenceRefs: outcome.evidenceRefs ?? [],
      };
    }
    default: {
      const _exhaustive: never = check;
      return {
        result: {
          id: String(_exhaustive),
          kind: 'custom',
          severity: 'required',
          passed: false,
          detail: 'unknown check kind',
        },
        evidenceRefs: [],
      };
    }
  }
}

function aggregateOutcome(
  checks: VerificationCheckResult[],
): VerificationResult['outcome'] {
  const required = checks.filter((c) => c.severity === 'required');
  if (required.length === 0) return 'not-gated';
  if (required.some((c) => !c.passed)) return 'failed';
  return 'passed';
}

/**
 * Execute a serializable VerificationPlan outside the worker agent policy.
 */
export async function executeVerificationPlan(
  plan: VerificationPlan,
  ctx: ExecuteVerificationContext,
): Promise<VerificationResult> {
  const checkResults: VerificationCheckResult[] = [];
  const evidenceRefs: string[] = [];

  for (const check of plan.checks) {
    const evaluated = await evaluateCheck(check, ctx);
    checkResults.push(evaluated.result);
    evidenceRefs.push(...evaluated.evidenceRefs);
  }

  const outcome = aggregateOutcome(checkResults);
  return verificationResultSchema.parse({
    outcome,
    passed: outcome === 'passed',
    planId: 'verification',
    checks: checkResults,
    evidenceRefs: [...new Set(evidenceRefs)],
  });
}

/** @deprecated Prefer ExecuteVerificationContext. */
export type VerifyContext = ExecuteVerificationContext;
