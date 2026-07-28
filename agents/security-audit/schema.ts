import { z } from 'zod';

/** Severity for security findings (maps cleanly into PR labels / body). */
export const auditSeveritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'info',
]);
export type AuditSeverity = z.infer<typeof auditSeveritySchema>;

export const auditCategorySchema = z.enum([
  'injection',
  'auth',
  'crypto',
  'ssrf',
  'xss',
  'secrets',
  'dependency',
  'misconfig',
  'other',
]);
export type AuditCategory = z.infer<typeof auditCategorySchema>;

/**
 * One concrete, file-anchored finding.
 * Evidence must be a short quote from the source — not a paraphrase-only claim.
 */
export const auditFindingSchema = z.object({
  id: z
    .string()
    .regex(/^F\d+$/, 'Finding id must look like F1, F2, …')
    .describe('Stable id within this audit run'),
  severity: auditSeveritySchema,
  category: auditCategorySchema,
  title: z.string().min(8).max(160),
  /** Path relative to the cloned workdir (posix-style). */
  file: z.string().min(1),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  /** Verbatim snippet from the file (≤ ~400 chars). */
  evidence: z.string().min(8).max(800),
  impact: z.string().min(8).max(500),
  recommendation: z.string().min(8).max(500),
  cwe: z
    .string()
    .regex(/^CWE-\d+$/i)
    .optional()
    .describe('Optional CWE id, e.g. CWE-89'),
});
export type AuditFinding = z.infer<typeof auditFindingSchema>;

/**
 * A single-file fix as an exact before → after replacement.
 * `before` must match the current file contents (substring replace).
 * Prefer the smallest unique contiguous snippet that makes the fix clear.
 */
export const auditFilePatchSchema = z.object({
  findingId: z.string().regex(/^F\d+$/),
  /** Path relative to the cloned workdir. */
  path: z.string().min(1),
  summary: z.string().min(8).max(240),
  language: z.string().optional(),
  before: z.string().min(1),
  after: z.string().min(1),
});
export type AuditFilePatch = z.infer<typeof auditFilePatchSchema>;

export const auditVerdictSchema = z.enum(['APPROVE', 'REVISE', 'REJECT']);
export type AuditVerdict = z.infer<typeof auditVerdictSchema>;

export const auditFixReviewSchema = z.object({
  findingId: z.string().regex(/^F\d+$/),
  accepted: z.boolean(),
  notes: z.string().min(1).max(600),
});
export type AuditFixReview = z.infer<typeof auditFixReviewSchema>;

/** Independent second-model evaluation of findings + patches. */
export const auditEvaluationSchema = z.object({
  verdict: auditVerdictSchema,
  evaluatorModel: z.string().min(1),
  summary: z.string().min(8).max(1200),
  perFix: z.array(auditFixReviewSchema).default([]),
  residualRisks: z.array(z.string()).default([]),
});
export type AuditEvaluation = z.infer<typeof auditEvaluationSchema>;

export const auditPrStatusSchema = z.enum([
  'opened',
  'skipped_not_approved',
  'policy_denied',
  'error',
]);
export type AuditPrStatus = z.infer<typeof auditPrStatusSchema>;

/** Payload ready for `gh pr create` (title + markdown body + branch). */
export const auditPullRequestSchema = z.object({
  branch: z.string().regex(/^[\w./-]+$/),
  title: z.string().min(8).max(120),
  body: z.string().min(20),
  url: z.string().url().optional(),
  status: auditPrStatusSchema,
  detail: z.string().optional(),
});
export type AuditPullRequest = z.infer<typeof auditPullRequestSchema>;

export const auditReviseAttemptSchema = z.object({
  attempt: z.number().int().nonnegative(),
  verdict: auditVerdictSchema,
  summary: z.string().min(1).max(1200),
});
export type AuditReviseAttempt = z.infer<typeof auditReviseAttemptSchema>;

/**
 * Full audit package — the structured artifact this agent builds toward a PR.
 * Sub-agents fill findings/patches; evaluator fills evaluation; publisher fills pr.
 */
export const auditPackageSchema = z.object({
  repoUrl: z.string().min(8),
  workdir: z.string().min(1),
  findings: z.array(auditFindingSchema).max(15),
  patches: z.array(auditFilePatchSchema).max(20),
  evaluation: auditEvaluationSchema.optional(),
  /** Evaluation / revise-loop trail (attempt 0 = first eval). */
  reviseHistory: z.array(auditReviseAttemptSchema).optional(),
  pr: auditPullRequestSchema.optional(),
});
export type AuditPackage = z.infer<typeof auditPackageSchema>;

/** Render a GitHub-flavored markdown PR body from a validated package. */
export function renderAuditPullRequestBody(pkg: AuditPackage): string {
  const findingsBlock = pkg.findings
    .map((f) => {
      const loc =
        f.lineStart != null
          ? `${f.file}:${f.lineStart}${f.lineEnd != null && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ''}`
          : f.file;
      const cwe = f.cwe ? ` (${f.cwe})` : '';
      return `### ${f.id} [${f.severity.toUpperCase()}] ${f.title}${cwe}

- **File:** \`${loc}\`
- **Category:** ${f.category}
- **Evidence:**
\`\`\`
${f.evidence}
\`\`\`
- **Impact:** ${f.impact}
- **Recommendation:** ${f.recommendation}`;
    })
    .join('\n\n');

  const changesBlock =
    pkg.patches.length === 0
      ? '_No patches recorded._'
      : pkg.patches
          .map((p) => {
            const lang = p.language ?? '';
            return `### \`${p.path}\` (${p.findingId}) — ${p.summary}

\`\`\`diff
${toUnifiedDiffHunk(p.before, p.after, lang)}
\`\`\``;
          })
          .join('\n\n');

  const evalBlock = pkg.evaluation
    ? `- **Model:** \`${pkg.evaluation.evaluatorModel}\`
- **Verdict:** \`${pkg.evaluation.verdict}\`
- **Summary:** ${pkg.evaluation.summary}
${
  pkg.evaluation.perFix.length
    ? pkg.evaluation.perFix
        .map(
          (r) =>
            `  - ${r.findingId}: ${r.accepted ? 'accepted' : 'needs revision'} — ${r.notes}`,
        )
        .join('\n')
    : ''
}
${
  pkg.evaluation.residualRisks.length
    ? `- **Residual risks:**\n${pkg.evaluation.residualRisks.map((r) => `  - ${r}`).join('\n')}`
    : ''
}
${
  pkg.reviseHistory && pkg.reviseHistory.length > 0
    ? `- **Revise loop:**\n${pkg.reviseHistory
        .map((h) => `  - attempt ${h.attempt}: \`${h.verdict}\` — ${h.summary}`)
        .join('\n')}`
    : ''
}`
    : '_Evaluation not run._';

  return `## Summary

Automated security audit of \`${pkg.repoUrl}\`.
This PR applies the accepted patches below. Please review carefully before merge.

## Findings

${findingsBlock || '_No findings._'}

## Changes

${changesBlock}

## Evaluation

${evalBlock}

## Test plan

- [ ] Reproduce each HIGH/CRITICAL finding on the base branch
- [ ] Confirm the patched paths behave as intended
- [ ] Grep for similar patterns elsewhere in the repo
- [ ] Run the project's existing tests / lint if available
`;
}

/** Naive unified-diff style hunk for PR readability (not a full diff algorithm). */
export function toUnifiedDiffHunk(
  before: string,
  after: string,
  _language = '',
): string {
  const beforeLines = before.replace(/\r\n/g, '\n').split('\n');
  const afterLines = after.replace(/\r\n/g, '\n').split('\n');
  const removed = beforeLines.map((l) => `-${l}`).join('\n');
  const added = afterLines.map((l) => `+${l}`).join('\n');
  return `@@\n${removed}\n${added}`;
}

/** Default PR title from top severities. */
export function defaultAuditPrTitle(findings: AuditFinding[]): string {
  const highs = findings.filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  ).length;
  const n = findings.length;
  if (highs > 0) {
    return `security: fix ${highs} high/critical issue${highs === 1 ? '' : 's'} (${n} total)`;
  }
  return `security: address ${n} audit finding${n === 1 ? '' : 's'}`;
}

/**
 * Parse a JSON object that may be wrapped in markdown fences or prose.
 * Throws ZodError / SyntaxError on failure.
 */
export function parseJsonPayload<T>(
  raw: string,
  schema: z.ZodType<T>,
): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? trimmed).trim();
  const start = candidate.indexOf('{');
  const startArr = candidate.indexOf('[');
  let jsonText = candidate;
  if (start >= 0 && (startArr < 0 || start < startArr)) {
    jsonText = candidate.slice(start);
  } else if (startArr >= 0) {
    jsonText = candidate.slice(startArr);
  }
  return schema.parse(JSON.parse(jsonText));
}

export const auditFindingsListSchema = z.object({
  findings: z.array(auditFindingSchema).min(1).max(15),
});

/** Logical schema id for typed handoffs carrying auditFindingsListSchema. */
export const AUDIT_FINDINGS_HANDOFF_SCHEMA_ID =
  'artifact://schemas/audit-findings-v1';

export const auditPatchesListSchema = z.object({
  patches: z.array(auditFilePatchSchema).min(1).max(20),
});
