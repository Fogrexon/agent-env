import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { Ajv } from 'ajv';
import type {
  EvaluationSpec,
  GraderSpec,
  RunSpec,
  SuccessCriterion,
  VerifyBaseDir,
  VerificationResult,
} from '@agent-env/shared';
import {
  createDefaultProcessRunner,
  type ProcessRunner,
} from './process-runner.js';

export interface VerifyContext {
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
    (ctx: VerifyContext) => Promise<boolean> | boolean
  >;
  /** Independent agent-grader host supplied by repo wiring. */
  agentGrader?: (
    grader: Extract<GraderSpec, { kind: 'agent' }>,
    ctx: VerifyContext,
  ) => Promise<GraderOutcome>;
  /** Optional adapters such as promptfoo. */
  externalGrader?: (
    grader: Extract<GraderSpec, { kind: 'external' }>,
    ctx: VerifyContext,
  ) => Promise<GraderOutcome>;
}

export interface GraderOutcome {
  passed: boolean;
  score?: number;
  detail?: string;
  evidenceRefs?: string[];
}

/** Execute a versioned EvaluationSpec outside the worker agent policy. */
export async function verifyRunSpec(
  _spec: RunSpec,
  evaluation: EvaluationSpec,
  ctx: VerifyContext,
): Promise<VerificationResult> {
  const outcomes = new Map<string, GraderOutcome>();
  for (const grader of evaluation.graders) {
    let outcome: GraderOutcome;
    if (grader.kind === 'deterministic') {
      outcome = await runDeterministicGrader(grader, evaluation, ctx);
    } else if (grader.kind === 'agent') {
      outcome = ctx.agentGrader
        ? await ctx.agentGrader(grader, ctx)
        : { passed: false, detail: 'agent grader host not configured' };
    } else {
      outcome = ctx.externalGrader
        ? await ctx.externalGrader(grader, ctx)
        : { passed: false, detail: 'external grader adapter not configured' };
    }
    outcomes.set(grader.id, outcome);
  }

  const checks = evaluation.acceptance.all.map((assertion) => {
    const outcome = outcomes.get(assertion.grader);
    const thresholdPassed =
      assertion.scoreAtLeast === undefined ||
      (outcome?.score !== undefined &&
        outcome.score >= assertion.scoreAtLeast);
    const passed = Boolean(outcome?.passed && thresholdPassed);
    return {
      criterion: `${assertion.grader}:${assertion.assertion}`,
      passed,
      detail:
        outcome?.detail ??
        (outcome ? `score=${outcome.score ?? 'n/a'}` : 'grader did not run'),
    };
  });

  return {
    passed: checks.every((c) => c.passed),
    graderVersion: `${evaluation.metadata.id}@${evaluation.metadata.version}`,
    checks,
    evidenceRefs: [...outcomes.values()].flatMap(
      (outcome) => outcome.evidenceRefs ?? [],
    ),
  };
}

/** Resolve a criterion path against the workspace or the repo root. */
function baseDirFor(base: VerifyBaseDir, ctx: VerifyContext): string | undefined {
  if (base === 'workspace') return ctx.workspaceDir;
  return ctx.cwd ?? process.cwd();
}

function resolveUnder(
  base: string,
  path: string | undefined,
): string {
  if (!path) return base;
  return isAbsolute(path) ? path : resolve(base, path);
}

type DeterministicGrader = Extract<GraderSpec, { kind: 'deterministic' }>;

async function runDeterministicGrader(
  grader: DeterministicGrader,
  evaluation: EvaluationSpec,
  ctx: VerifyContext,
): Promise<GraderOutcome> {
  switch (grader.ref) {
    case 'grader://non-empty/v1': {
      const passed = Boolean(ctx.finalText?.trim());
      return {
        passed,
        score: passed ? 1 : 0,
        detail: passed ? 'non-empty final output' : 'empty final output',
      };
    }
    case 'grader://contains/v1': {
      const text =
        typeof grader.config['text'] === 'string'
          ? grader.config['text']
          : undefined;
      if (!text) return { passed: false, detail: 'config.text is required' };
      const caseInsensitive = grader.config['caseInsensitive'] !== false;
      const hay = caseInsensitive
        ? (ctx.finalText ?? '').toLowerCase()
        : (ctx.finalText ?? '');
      const needle = caseInsensitive ? text.toLowerCase() : text;
      const passed = hay.includes(needle);
      return {
        passed,
        score: passed ? 1 : 0,
        detail: passed ? `found "${text}"` : `missing "${text}"`,
      };
    }
    case 'grader://artifact-contract/v1':
      return evaluateArtifactContracts(evaluation, ctx);
    case 'grader://document-contract/v1':
      return evaluateDocumentContract(grader.config, evaluation, ctx);
    case 'grader://json-schema/v1': {
      const schemaRef =
        typeof grader.config['schemaRef'] === 'string'
          ? grader.config['schemaRef']
          : undefined;
      if (!schemaRef) {
        return { passed: false, detail: 'config.schemaRef is required' };
      }
      const sourcePath =
        typeof grader.config['sourcePath'] === 'string'
          ? grader.config['sourcePath']
          : undefined;
      const check = evaluateJsonSchema(
        {
          type: 'json_schema',
          schemaRef,
          ...(sourcePath ? { sourcePath } : {}),
          baseDir: 'workspace',
        },
        ctx,
      );
      return {
        passed: check.passed,
        score: check.passed ? 1 : 0,
        detail: check.detail,
      };
    }
    case 'grader://command/v1': {
      const bin =
        typeof grader.config['bin'] === 'string'
          ? grader.config['bin']
          : undefined;
      if (!bin) return { passed: false, detail: 'config.bin is required' };
      const args = Array.isArray(grader.config['args'])
        ? grader.config['args'].map(String)
        : [];
      const check = await evaluateCommand(
        {
          type: 'command',
          bin,
          args,
          baseDir: grader.config['baseDir'] === 'repo' ? 'repo' : 'workspace',
          expectExitCode:
            typeof grader.config['expectExitCode'] === 'number'
              ? grader.config['expectExitCode']
              : 0,
          timeoutMs:
            typeof grader.config['timeoutMs'] === 'number'
              ? grader.config['timeoutMs']
              : 120_000,
          shell: grader.config['shell'] === true,
          ...(typeof grader.config['subdir'] === 'string'
            ? { subdir: grader.config['subdir'] }
            : {}),
          ...(typeof grader.config['outputContains'] === 'string'
            ? { outputContains: grader.config['outputContains'] }
            : {}),
        },
        ctx,
      );
      return {
        passed: check.passed,
        score: check.passed ? 1 : 0,
        detail: check.detail,
      };
    }
    default:
      return {
        passed: false,
        detail: `unknown deterministic grader: ${grader.ref}`,
      };
  }
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

function findArtifactPathForContract(
  contract: { id: string; mediaTypes: readonly string[] },
  ctx: VerifyContext,
): string | undefined {
  if (!ctx.workspaceDir) return undefined;
  return listWorkspaceFiles(ctx.workspaceDir).find((path) => {
    const stem = basename(path, extname(path));
    return (
      stem === contract.id &&
      contract.mediaTypes.includes(mimeFromExtension(path))
    );
  });
}

/**
 * Resolve a path by artifact id. When multiple contracts share an id
 * (e.g. report.md + report.pdf), prefer text-friendly media for document graders.
 */
function findArtifactPathById(
  artifactId: string,
  evaluation: EvaluationSpec,
  ctx: VerifyContext,
  preferMediaTypes: readonly string[] = ['text/markdown', 'text/html'],
): string | undefined {
  const contracts = evaluation.artifacts.filter((item) => item.id === artifactId);
  if (contracts.length === 0) return undefined;
  const ordered = [...contracts].sort((a, b) => {
    const rank = (mediaTypes: readonly string[]): number =>
      mediaTypes.some((m) => preferMediaTypes.includes(m)) ? 0 : 1;
    return rank(a.mediaTypes) - rank(b.mediaTypes);
  });
  for (const contract of ordered) {
    const path = findArtifactPathForContract(contract, ctx);
    if (path) return path;
  }
  return undefined;
}

function evaluateArtifactContracts(
  evaluation: EvaluationSpec,
  ctx: VerifyContext,
): GraderOutcome {
  if (!ctx.workspaceDir) {
    return { passed: false, detail: 'workspace directory unavailable' };
  }
  const problems: string[] = [];
  const evidenceRefs: string[] = [];
  for (const contract of evaluation.artifacts) {
    const label = `${contract.id} [${contract.mediaTypes.join(',')}]`;
    const path = findArtifactPathForContract(contract, ctx);
    if (!path) {
      if (contract.required) problems.push(`${label}: missing`);
      continue;
    }
    const size = statSync(path).size;
    if (size < contract.minBytes) {
      problems.push(`${label}: ${size}B < ${contract.minBytes}B`);
    } else {
      evidenceRefs.push(path);
    }
  }
  return {
    passed: problems.length === 0,
    score: problems.length === 0 ? 1 : 0,
    detail:
      problems.length === 0
        ? `${evidenceRefs.length} artifact contract(s) satisfied`
        : problems.join('; '),
    evidenceRefs,
  };
}

function evaluateDocumentContract(
  config: Record<string, unknown>,
  evaluation: EvaluationSpec,
  ctx: VerifyContext,
): GraderOutcome {
  const artifactId =
    typeof config['artifact'] === 'string' ? config['artifact'] : 'report';
  const sections = Array.isArray(config['sections'])
    ? config['sections'].map(String)
    : [];
  const path = findArtifactPathById(artifactId, evaluation, ctx);
  if (!path) return { passed: false, detail: `${artifactId}: missing` };
  const text = readFileSync(path, 'utf8');
  const isHtml = mimeFromExtension(path) === 'text/html';
  const missing = sections.filter((section) =>
    isHtml
      ? !hasHtmlHeading(text, section, 1, 6)
      : !hasMarkdownHeading(text, section, 1, 6),
  );
  return {
    passed: missing.length === 0,
    score:
      sections.length === 0 ? 1 : (sections.length - missing.length) / sections.length,
    detail:
      missing.length === 0
        ? `${artifactId} document contract satisfied`
        : `missing sections: ${missing.join(', ')}`,
    evidenceRefs: [path],
  };
}

async function evaluateCriterion(
  criterion: SuccessCriterion,
  ctx: VerifyContext,
): Promise<VerificationResult['checks'][number]> {
  switch (criterion.type) {
    case 'command':
      return evaluateCommand(criterion, ctx);
    case 'file_exists':
      return evaluateFileExists(criterion, ctx);
    case 'json_schema':
      return evaluateJsonSchema(criterion, ctx);
    case 'markdown_headings': {
      const loaded = loadDocumentText(criterion, ctx);
      if (!loaded.ok) {
        return {
          criterion: `markdown_headings:${criterion.headings.join('|')}`,
          passed: false,
          detail: loaded.detail,
        };
      }
      const missing = criterion.headings.filter(
        (title) =>
          !hasMarkdownHeading(
            loaded.text,
            title,
            criterion.minLevel,
            criterion.maxLevel,
          ),
      );
      return {
        criterion: `markdown_headings:${criterion.headings.join('|')}`,
        passed: missing.length === 0,
        detail:
          missing.length === 0
            ? `all required headings present (${loaded.source})`
            : `missing headings in ${loaded.source}: ${missing.join(', ')}`,
      };
    }
    case 'html_headings': {
      const loaded = loadDocumentText(criterion, ctx);
      if (!loaded.ok) {
        return {
          criterion: `html_headings:${criterion.headings.join('|')}`,
          passed: false,
          detail: loaded.detail,
        };
      }
      const missing = criterion.headings.filter(
        (title) =>
          !hasHtmlHeading(
            loaded.text,
            title,
            criterion.minLevel,
            criterion.maxLevel,
          ),
      );
      return {
        criterion: `html_headings:${criterion.headings.join('|')}`,
        passed: missing.length === 0,
        detail:
          missing.length === 0
            ? `all required headings present (${loaded.source})`
            : `missing headings in ${loaded.source}: ${missing.join(', ')}`,
      };
    }
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
        detail: 'test_suite verifier not wired; use type: command',
      };
    default: {
      const _exhaustive: never = criterion;
      return { criterion: String(_exhaustive), passed: false };
    }
  }
}

async function evaluateCommand(
  criterion: Extract<SuccessCriterion, { type: 'command' }>,
  ctx: VerifyContext,
): Promise<VerificationResult['checks'][number]> {
  const label = `command:${criterion.bin}${
    criterion.args.length ? ` ${criterion.args.join(' ')}` : ''
  }`;
  const base = baseDirFor(criterion.baseDir, ctx);
  if (!base) {
    return {
      criterion: label,
      passed: false,
      detail: `no ${criterion.baseDir} directory available in verify context`,
    };
  }

  const runner = ctx.processRunner ?? createDefaultProcessRunner();
  let result;
  try {
    result = await runner({
      bin: criterion.bin,
      args: [...criterion.args],
      cwd: resolveUnder(base, criterion.subdir),
      timeoutMs: criterion.timeoutMs,
      maxOutputBytes: 64_000,
      shell: criterion.shell,
    });
  } catch (err) {
    return {
      criterion: label,
      passed: false,
      detail: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.timedOut) {
    return {
      criterion: label,
      passed: false,
      detail: `timed out after ${criterion.timeoutMs}ms`,
    };
  }
  if (result.exitCode !== criterion.expectExitCode) {
    const tail = (result.stderr || result.stdout).trim().slice(-400);
    return {
      criterion: label,
      passed: false,
      detail: `exit ${result.exitCode} (expected ${criterion.expectExitCode})${tail ? `: ${tail}` : ''}`,
    };
  }
  if (criterion.outputContains) {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (!combined.includes(criterion.outputContains)) {
      return {
        criterion: label,
        passed: false,
        detail: `output missing "${criterion.outputContains}"`,
      };
    }
  }
  return {
    criterion: label,
    passed: true,
    detail: `exit ${result.exitCode}`,
  };
}

function evaluateFileExists(
  criterion: Extract<SuccessCriterion, { type: 'file_exists' }>,
  ctx: VerifyContext,
): VerificationResult['checks'][number] {
  const label = `file_exists:${criterion.paths.join('|')}`;
  const base = baseDirFor(criterion.baseDir, ctx);
  if (!base) {
    return {
      criterion: label,
      passed: false,
      detail: `no ${criterion.baseDir} directory available in verify context`,
    };
  }

  const problems: string[] = [];
  for (const path of criterion.paths) {
    const abs = resolveUnder(base, path);
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) {
        problems.push(`${path}: not a file`);
      } else if (stat.size < criterion.minBytes) {
        problems.push(`${path}: ${stat.size}B < ${criterion.minBytes}B`);
      }
    } catch {
      problems.push(`${path}: missing`);
    }
  }

  return {
    criterion: label,
    passed: problems.length === 0,
    detail:
      problems.length === 0
        ? `${criterion.paths.length} artifact(s) present`
        : problems.join('; '),
  };
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

type HeadingDocCriterion = Extract<
  SuccessCriterion,
  { type: 'markdown_headings' | 'html_headings' }
>;

function loadDocumentText(
  criterion: HeadingDocCriterion,
  ctx: VerifyContext,
):
  | { ok: true; text: string; source: string }
  | { ok: false; detail: string } {
  if (criterion.sourcePath) {
    const base = baseDirFor(criterion.baseDir, ctx);
    if (!base) {
      return {
        ok: false,
        detail: `no ${criterion.baseDir} directory available in verify context`,
      };
    }
    const abs = resolveUnder(base, criterion.sourcePath);
    try {
      return {
        ok: true,
        text: readFileSync(abs, 'utf8'),
        source: criterion.sourcePath,
      };
    } catch (err) {
      return {
        ok: false,
        detail: `failed to read ${criterion.sourcePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }
  return {
    ok: true,
    text: ctx.finalText ?? '',
    source: 'finalText',
  };
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

function evaluateJsonSchema(
  criterion: Extract<SuccessCriterion, { type: 'json_schema' }>,
  ctx: VerifyContext,
): VerificationResult['checks'][number] {
  const label = `json_schema:${criterion.schemaRef}`;
  const repoRoot = ctx.cwd ?? process.cwd();
  const schemaPath = isAbsolute(criterion.schemaRef)
    ? criterion.schemaRef
    : resolve(repoRoot, criterion.schemaRef);

  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as unknown;
  } catch (err) {
    return {
      criterion: label,
      passed: false,
      detail: `failed to load schema: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let data: unknown;
  let source: string;
  if (criterion.sourcePath) {
    const base = baseDirFor(criterion.baseDir, ctx);
    if (!base) {
      return {
        criterion: label,
        passed: false,
        detail: `no ${criterion.baseDir} directory available in verify context`,
      };
    }
    const abs = resolveUnder(base, criterion.sourcePath);
    source = criterion.sourcePath;
    try {
      data = JSON.parse(readFileSync(abs, 'utf8')) as unknown;
    } catch (err) {
      return {
        criterion: label,
        passed: false,
        detail: `failed to read ${source}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    source = 'finalText';
    try {
      data = extractJsonValue(ctx.finalText ?? '');
    } catch (err) {
      return {
        criterion: label,
        passed: false,
        detail: `JSON extract failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  let validate;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    return {
      criterion: label,
      passed: false,
      detail: `invalid schema: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const passed = Boolean(validate(data));
  return {
    criterion: label,
    passed,
    detail: passed
      ? `${source} satisfies schema`
      : `${source}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
  };
}
