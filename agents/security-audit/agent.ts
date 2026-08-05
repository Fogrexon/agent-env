import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LlmAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import {
  createGitCloneTool,
  createGithubTools,
  createGuardedTool,
  createHandoffArtifact,
  createReviewLoopAgent,
  createWorkspaceFsTools,
  defineAgent,
  formatModelRef,
  isProviderConfigured,
  parseModelRef,
  verify,
  type AgentBuildContext,
} from '@agent-env/harness';
import { z } from 'zod';
import {
  AUDIT_FINDINGS_HANDOFF_SCHEMA_ID,
  auditEvaluationSchema,
  auditFindingSchema,
  auditFilePatchSchema,
  auditFindingsListSchema,
  auditPatchesListSchema,
  defaultAuditPrTitle,
  parseJsonPayload,
  renderAuditPullRequestBody,
  type AuditEvaluation,
  type AuditFinding,
  type AuditFilePatch,
  type AuditPackage,
  type AuditPullRequest,
} from './schema.js';

/**
 * Security-audit pipeline (Cursor SDK by default):
 *
 *   1. cloner              — clone_repo → workdir
 *   2. Parallel scouts     — injection / auth-secrets / supply-config
 *   3. consolidator        — merge → record_findings (Zod)
 *   4. review_loop         — createReviewLoopAgent: fix_author (producer) →
 *                            audit_fix_evaluator (2nd-model reviewer) →
 *                            audit_patch_reviser on REVISE, up to maxIterations
 *   5. gatekeeper          — publish_security_pr → structured GitHub PR report
 *
 * Independent evaluate/revise runs in-session via createReviewLoopAgent (shares the
 * outer invocation's budget/abort/tool-approval instead of nesting runAgent()).
 * Structured artifact: AuditPackage → GitHub PR.
 */
export const agentDefinition = defineAgent({
  id: 'security-audit',
  name: 'Security Audit',
  description:
    'Clone → parallel security scouts → consolidate findings → author patches → evaluate → publish structured GitHub PR.',
  limits: {
    maxSteps: 100,
    maxToolCalls: 140,
    maxWallSeconds: 3600,
    maxRepairs: 0,
  },
  verification: {
    checks: [verify.nonEmpty({ severity: 'advisory' })],
  },
  createAgent(context: AgentBuildContext) {
    const RUNS_DIR = resolve(context.repoRoot, '.runs', 'security-audit');
    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    const workRoots = new Set<string>();

    /** In-run audit package — filled by tools as the pipeline progresses. */
    const auditState: {
      pkg: Partial<AuditPackage> & {
        findings: AuditFinding[];
        patches: AuditFilePatch[];
      };
      reviseHistory: Array<{
        attempt: number;
        verdict: AuditEvaluation['verdict'];
        summary: string;
      }>;
    } = {
      pkg: { findings: [], patches: [] },
      reviseHistory: [],
    };

    const allowWrite = () =>
      context.config('AGENT_ENV_AUDIT_ALLOW_WRITE') === '1';
    const allowPr = () => context.config('AGENT_ENV_AUDIT_ALLOW_PR') === '1';

    const fs = createWorkspaceFsTools({
      roots: () => [...workRoots],
      write: {
        name: 'write_fix',
        description:
          'Overwrite one file inside a cloned workdir (T2). Prefer publish_security_pr which applies validated patches.',
        approve: () => allowWrite(),
      },
    });

    const cloneRepo = createGitCloneTool({
      parentDir: RUNS_DIR,
      description:
        'Shallow-clone a public GitHub repository into .runs/security-audit.',
      onCloned: (workdir) => {
        workRoots.add(workdir);
        auditState.pkg.workdir = workdir;
      },
    });

    const github = createGithubTools({
      resolveWorkdir: (path) => fs.resolvePath(path),
      createPr: {
        approve: () => allowPr(),
      },
    });

    function evaluatorModel(): string {
      const fromConfig = context
        .config('AGENT_ENV_AUDIT_EVALUATOR_MODEL')
        ?.trim();
      if (fromConfig) {
        return formatModelRef(parseModelRef(fromConfig));
      }
      return isProviderConfigured('gemini')
        ? 'gemini:gemini-3.6-flash'
        : 'cursor:gpt-5.6-sol';
    }
    const evalModel = evaluatorModel();
    const MAX_REVISIONS = 2;

    function absInWorkdir(relPath: string): string {
      const workdir = auditState.pkg.workdir;
      if (!workdir) {
        throw new Error('workdir is not set — call clone_repo first');
      }
      return fs.resolvePath(join(workdir, relPath));
    }

    /** Persist validated findings into the run package. */
    const recordFindings = createGuardedTool({
      contract: {
        name: 'record_findings',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description:
        'Validate and store the consolidated findings JSON (schema: { findings: Finding[] }). Call once after merging scout outputs.',
      parameters: z.object({
        repoUrl: z.string().min(8),
        findingsJson: z
          .string()
          .min(20)
          .describe(
            'JSON object { "findings": [ ... ] } matching AuditFinding schema',
          ),
      }),
      execute: ({ repoUrl, findingsJson }) => {
        const parsed = parseJsonPayload(findingsJson, auditFindingsListSchema);
        // Re-number ids F1..Fn for stability
        const findings = parsed.findings.map((f, i) =>
          auditFindingSchema.parse({ ...f, id: `F${i + 1}` }),
        );
        auditState.pkg.repoUrl = repoUrl;
        auditState.pkg.findings = findings;
        const handoff = createHandoffArtifact({
          fromAgent: 'consolidator',
          toAgent: 'patch_author',
          objective: `Validated security findings for ${repoUrl}`,
          outputSchema: AUDIT_FINDINGS_HANDOFF_SCHEMA_ID,
          payload: { findings },
          payloadSchema: auditFindingsListSchema,
          doneCriteria: [
            'findings validated against AuditFinding schema',
            'ids renumbered F1..Fn',
          ],
          contextSummary: `${findings.length} findings recorded for ${repoUrl}`,
        });
        return {
          status: 'success' as const,
          count: findings.length,
          ids: findings.map((f) => f.id),
          severities: Object.fromEntries(
            (['critical', 'high', 'medium', 'low', 'info'] as const).map(
              (s) => [s, findings.filter((f) => f.severity === s).length],
            ),
          ),
          handoffDigest: handoff.digest,
          handoffSchema: handoff.outputSchema,
        };
      },
    });

    /** Persist validated before/after patches. */
    const recordPatches = createGuardedTool({
      contract: {
        name: 'record_patches',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description:
        'Validate and store file patches JSON (schema: { patches: FilePatch[] }). before must be an exact substring of the current file.',
      parameters: z.object({
        patchesJson: z
          .string()
          .min(20)
          .describe(
            'JSON object { "patches": [ ... ] } matching AuditFilePatch schema',
          ),
      }),
      execute: ({ patchesJson }) => {
        const parsed = parseJsonPayload(patchesJson, auditPatchesListSchema);
        const findingIds = new Set(auditState.pkg.findings.map((f) => f.id));
        const patches: AuditFilePatch[] = [];
        const errors: string[] = [];

        for (const raw of parsed.patches) {
          const patch = auditFilePatchSchema.parse(raw);
          if (!findingIds.has(patch.findingId)) {
            errors.push(`${patch.findingId}: unknown findingId`);
            continue;
          }
          if (patch.before === patch.after) {
            errors.push(`${patch.findingId}@${patch.path}: before === after`);
            continue;
          }
          try {
            const abs = absInWorkdir(patch.path);
            const current = readFileSync(abs, 'utf8');
            if (!current.includes(patch.before)) {
              errors.push(
                `${patch.findingId}@${patch.path}: \`before\` not found in file (must be an exact contiguous substring)`,
              );
              continue;
            }
            patches.push(patch);
          } catch (err) {
            errors.push(
              `${patch.findingId}@${patch.path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        auditState.pkg.patches = patches;
        return {
          status: patches.length > 0 ? ('success' as const) : ('error' as const),
          accepted: patches.length,
          rejected: errors.length,
          errors,
          patchSummaries: patches.map((p) => ({
            findingId: p.findingId,
            path: p.path,
            summary: p.summary,
          })),
        };
      },
    });

    /** Read-only snapshot of the recorded audit state (for reviewer/reviser/gatekeeper). */
    const getRecordedState = createGuardedTool({
      contract: {
        name: 'get_recorded_state',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description:
        'Read the currently recorded findings, patches, evaluation (if any), and revise history for this audit run.',
      parameters: z.object({}),
      execute: () => ({
        status: 'success' as const,
        findings: auditState.pkg.findings,
        patches: auditState.pkg.patches,
        evaluation: auditState.pkg.evaluation ?? null,
        reviseHistory: auditState.reviseHistory,
      }),
    });

    /** Persist the independent reviewer's verdict JSON (Zod-validated). */
    const recordEvaluation = createGuardedTool({
      contract: {
        name: 'record_evaluation',
        version: '1.0',
        riskClass: 'T0',
        sideEffect: 'none',
        idempotency: 'supported',
      },
      description:
        'Validate and store the independent evaluator verdict JSON (schema: AuditEvaluation minus evaluatorModel). Call once per review iteration.',
      parameters: z.object({
        evaluationJson: z
          .string()
          .min(20)
          .describe(
            'JSON object matching AuditEvaluation (verdict/summary/perFix/residualRisks; no evaluatorModel)',
          ),
      }),
      execute: ({ evaluationJson }) => {
        const parsed = parseJsonPayload(
          evaluationJson,
          auditEvaluationSchema.omit({ evaluatorModel: true }),
        );
        const evaluation = auditEvaluationSchema.parse({
          ...parsed,
          evaluatorModel: evalModel,
        });
        auditState.pkg.evaluation = evaluation;
        auditState.reviseHistory.push({
          attempt: auditState.reviseHistory.length,
          verdict: evaluation.verdict,
          summary: evaluation.summary,
        });
        auditState.pkg.reviseHistory = auditState.reviseHistory;
        return {
          status: 'success' as const,
          verdict: evaluation.verdict,
          attempt: auditState.reviseHistory.length - 1,
        };
      },
    });

    /** Independent second-model reviewer: reads recorded state, emits AuditEvaluation JSON. */
    const evaluator = new LlmAgent({
      name: 'audit_fix_evaluator',
      model: evalModel,
      description: 'Independent reviewer for structured security patches.',
      instruction: `You are a strict independent security reviewer. You did NOT write these fixes.

1. Call get_recorded_state to read the current findings and patches.
2. Review the patches: does \`before\` → \`after\` correctly and safely fix the linked finding?
   Could it introduce regressions or incomplete fixes?
3. Call record_evaluation ONCE with a JSON object (no markdown fence) matching:
{
  "verdict": "APPROVE" | "REVISE" | "REJECT",
  "summary": "one short paragraph",
  "perFix": [{ "findingId": "F1", "accepted": true, "notes": "..." }],
  "residualRisks": ["..."]
}
Use APPROVE only if every submitted patch is acceptable.
Use REVISE if patches need changes but the approach is salvageable.
Use REJECT if the patches are wrong or dangerous.
4. After the tool call, output ONLY that same JSON object as your final response
   (no prose, no markdown fence).`,
      tools: [getRecordedState, recordEvaluation],
      outputKey: 'auditEvaluationJson',
    });

    /** Revises recorded patches after an independent REVISE verdict. */
    const patchReviser = new LlmAgent({
      name: 'audit_patch_reviser',
      model,
      description:
        'Revises recorded patches after an independent REVISE verdict.',
      instruction: `You revise security patches after an independent reviewer said REVISE.

1. Call get_recorded_state to see the current findings, patches, and the latest evaluation feedback
   (evaluation.summary, evaluation.perFix, evaluation.residualRisks).
2. Focus first on findings flagged not-accepted in evaluation.perFix (or all patches if perFix is empty).
3. Re-read target files with read_file as needed.
4. Craft improved exact before→after patches (before must be an exact contiguous substring).
5. Call record_patches ONCE with the FULL updated patches array (include still-good patches you keep).
6. End with a one-line note of which findingIds you changed.

Do not apply patches to disk. Do not open a PR.`,
      tools: [getRecordedState, fs.readFile, recordPatches],
      outputKey: 'patches_summary',
    });

    /**
     * Apply recorded patches (substring replace) and open a GitHub PR.
     * Orchestration tool (T1): write/PR authority stays on write_fix / create_pr gates.
     */
    const publishSecurityPr = createGuardedTool({
      contract: {
        name: 'publish_security_pr',
        version: '1.0',
        riskClass: 'T1',
        sideEffect: 'irreversible',
        idempotency: 'required',
        timeoutMs: 180_000,
      },
      description:
        'If evaluation verdict is APPROVE: apply recorded patches (needs AGENT_ENV_AUDIT_ALLOW_WRITE=1), then open a GitHub PR (needs AGENT_ENV_AUDIT_ALLOW_PR=1) with a structured markdown body. Otherwise records skipped_not_approved.',
      parameters: z.object({
        branch: z
          .string()
          .regex(/^[\w./-]+$/)
          .optional()
          .describe('Branch name (default security/audit-fixes)'),
      }),
      execute: async ({ branch }) => {
        const workdir = auditState.pkg.workdir;
        const findings = auditState.pkg.findings;
        const patches = auditState.pkg.patches;
        const evaluation = auditState.pkg.evaluation;
        const repoUrl = auditState.pkg.repoUrl ?? 'unknown';

        if (!workdir) {
          return { status: 'error' as const, message: 'No workdir — clone first.' };
        }
        if (!evaluation) {
          return {
            status: 'error' as const,
            message: 'No evaluation — call evaluate_audit first.',
          };
        }

        const prBranch = branch ?? 'security/audit-fixes';
        const title = defaultAuditPrTitle(findings);
        const body = renderAuditPullRequestBody({
          repoUrl,
          workdir,
          findings,
          patches,
          evaluation,
          ...(auditState.pkg.reviseHistory
            ? { reviseHistory: auditState.pkg.reviseHistory }
            : {}),
        });

        if (evaluation.verdict !== 'APPROVE') {
          const pr: AuditPullRequest = {
            branch: prBranch,
            title,
            body,
            status: 'skipped_not_approved',
            detail: `Verdict was ${evaluation.verdict}; PR not opened.`,
          };
          auditState.pkg.pr = pr;
          return { status: 'skipped' as const, pr };
        }

        if (!allowWrite()) {
          const pr: AuditPullRequest = {
            branch: prBranch,
            title,
            body,
            status: 'policy_denied',
            detail: 'AGENT_ENV_AUDIT_ALLOW_WRITE is not 1 — patches not applied.',
          };
          auditState.pkg.pr = pr;
          return { status: 'policy_denied' as const, pr };
        }

        const acceptedIds = new Set(
          evaluation.perFix.length
            ? evaluation.perFix.filter((r) => r.accepted).map((r) => r.findingId)
            : patches.map((p) => p.findingId),
        );
        const applied: string[] = [];
        for (const patch of patches) {
          if (!acceptedIds.has(patch.findingId)) continue;
          const abs = absInWorkdir(patch.path);
          const current = readFileSync(abs, 'utf8');
          if (!current.includes(patch.before)) {
            return {
              status: 'error' as const,
              message: `Patch ${patch.findingId}@${patch.path} no longer matches file contents.`,
            };
          }
          writeFileSync(abs, current.replace(patch.before, patch.after), 'utf8');
          applied.push(`${patch.findingId}:${patch.path}`);
        }

        if (!allowPr()) {
          const pr: AuditPullRequest = {
            branch: prBranch,
            title,
            body,
            status: 'policy_denied',
            detail:
              'Patches applied locally but AGENT_ENV_AUDIT_ALLOW_PR is not 1 — PR not opened.',
          };
          auditState.pkg.pr = pr;
          return { status: 'policy_denied' as const, applied, pr };
        }

        const prResult = (await github.createPr.runAsync({
          args: { workdir, branch: prBranch, title, body },
          toolContext: {} as never,
        })) as Record<string, unknown>;

        if (prResult?.['status'] === 'policy_denied') {
          const pr: AuditPullRequest = {
            branch: prBranch,
            title,
            body,
            status: 'policy_denied',
            detail: String(prResult['message'] ?? 'create_pr policy_denied'),
          };
          auditState.pkg.pr = pr;
          return { status: 'policy_denied' as const, applied, pr };
        }

        const prUrl =
          typeof prResult?.['prUrl'] === 'string' ? prResult['prUrl'] : undefined;
        const pr: AuditPullRequest = {
          branch: prBranch,
          title,
          body,
          url: prUrl,
          status: prUrl ? 'opened' : 'error',
          detail: prUrl ? undefined : JSON.stringify(prResult),
        };
        auditState.pkg.pr = pr;
        return { status: 'success' as const, applied, pr };
      },
    });

    function scoutAgent(opts: {
      name: string;
      focus: string;
      outputKey: string;
    }): LlmAgent {
      return new LlmAgent({
        name: opts.name,
        model,
        description: `Security scout focused on: ${opts.focus}`,
        instruction: `You are a specialist security scout (${opts.focus}).

Clone result from the previous step:
{clone_result}

1. Parse the workdir path from clone_result.
2. Use list_files on that workdir, then read_file on the most relevant files for YOUR focus only
   (at most 8 reads). Skip vendored/minified noise.
3. Emit ONLY a JSON object (no prose, no markdown fence) of the form:
{
  "findings": [
    {
      "id": "F1",
      "severity": "critical"|"high"|"medium"|"low"|"info",
      "category": "injection"|"auth"|"crypto"|"ssrf"|"xss"|"secrets"|"dependency"|"misconfig"|"other",
      "title": "...",
      "file": "relative/path",
      "lineStart": 12,
      "lineEnd": 18,
      "evidence": "verbatim quote from the file",
      "impact": "...",
      "recommendation": "...",
      "cwe": "CWE-89"
    }
  ]
}
Rules:
- 0–5 findings. Prefer high-confidence issues with real evidence quotes.
- Do not invent files or evidence. If nothing solid, return {"findings":[]}.
- Ids may be temporary (consolidator will renumber).`,
        tools: [fs.listFiles, fs.readFile],
        outputKey: opts.outputKey,
      });
    }

    const cloner = new LlmAgent({
      name: 'repo_cloner',
      model,
      description: 'Clones the target GitHub repository.',
      instruction: `Extract the https://github.com/owner/repo URL from the user message.
Call clone_repo once. Then output a short JSON object only:
{"repoUrl":"...","workdir":"...","topEntries":[...]}
Use the tool result fields. No prose.`,
      tools: [cloneRepo],
      outputKey: 'clone_result',
    });

    const scouts = new ParallelAgent({
      name: 'security_scouts',
      description: 'Parallel specialist scouts over the cloned tree.',
      subAgents: [
        scoutAgent({
          name: 'scout_injection',
          focus: 'injection / XSS / SSRF / unsafe eval / command execution / SQL',
          outputKey: 'scout_injection',
        }),
        scoutAgent({
          name: 'scout_auth_secrets',
          focus:
            'authn/authz flaws, plaintext passwords, hardcoded secrets, weak crypto',
          outputKey: 'scout_auth_secrets',
        }),
        scoutAgent({
          name: 'scout_supply_config',
          focus:
            'dependency risks, insecure defaults, debug flags, CORS, missing security headers',
          outputKey: 'scout_supply_config',
        }),
      ],
    });

    const consolidator = new LlmAgent({
      name: 'findings_consolidator',
      model,
      description: 'Merges scout findings into one validated AuditFinding list.',
      instruction: `Merge the scout outputs into one deduplicated findings list.

Clone:
{clone_result}

Scout — injection:
{scout_injection}

Scout — auth/secrets:
{scout_auth_secrets}

Scout — supply/config:
{scout_supply_config}

Rules:
1. Keep at most 8 findings. Prefer critical/high. Drop weak or duplicate items.
2. Call record_findings with repoUrl (from clone_result) and findingsJson.
3. After the tool succeeds, briefly list the accepted ids and severities.
Do not invent new evidence.`,
      tools: [recordFindings],
      outputKey: 'findings_summary',
    });

    /** Producer for the review loop: authors the initial patches. */
    const fixAuthor = new LlmAgent({
      name: 'fix_author',
      model,
      description: 'Authors exact before/after patches for top findings.',
      instruction: `You author concrete patches for the recorded findings.

Clone:
{clone_result}

Findings summary:
{findings_summary}

1. Re-read each target file with read_file as needed.
2. For the top 1–3 highest-severity findings that you can fix safely in-place,
   craft patches where \`before\` is an EXACT contiguous substring of the current file
   and \`after\` is the fixed version. Keep patches as small as possible.
3. Call record_patches once with patchesJson:
{
  "patches": [
    {
      "findingId": "F1",
      "path": "relative/path",
      "summary": "what changed",
      "language": "js",
      "before": "...exact...",
      "after": "...fixed..."
    }
  ]
}
4. If record_patches returns errors, fix and retry once.
5. End with a short note of which findingIds received patches.

Never claim a patch was applied to disk — record_patches only validates/stores.`,
      tools: [fs.readFile, recordPatches],
      outputKey: 'patches_summary',
    });

    /**
     * In-session producer → reviewer → reviser loop (shares this invocation's
     * budget/abort/tool-approval instead of nesting runAgent()).
     */
    const reviewLoop = createReviewLoopAgent({
      name: 'audit_review_loop',
      description:
        'Author patches, then independent second-model evaluation → revise until approved/rejected or exhausted.',
      producer: fixAuthor,
      reviewer: evaluator,
      reviser: patchReviser,
      reviewKey: 'auditEvaluationJson',
      reviewSchema: auditEvaluationSchema.omit({ evaluatorModel: true }),
      isApproved: (review) => review.verdict !== 'REVISE',
      maxIterations: MAX_REVISIONS + 1,
    });

    const gatekeeper = new LlmAgent({
      name: 'audit_gatekeeper',
      model,
      description: 'Publishes the structured GitHub PR and final report.',
      instruction: `You are the gatekeeper for the security audit.

1. Call get_recorded_state to read the final findings, patches, evaluation, and reviseHistory.
2. Call publish_security_pr once (optional branch security/audit-fixes).
   - If the final verdict != APPROVE, publish will skip — that is expected.
   - If tools return policy_denied, report the gate; do not retry.
3. Write the FINAL user-facing report with EXACT section headers:

## Audit package
(repoUrl, workdir, finding counts by severity, patch count)

## Findings
For each finding: id, severity, file, title, evidence quote (one line).

## Patches
For each patch: findingId, path, and a unified-diff style before/after block
(use '-' / '+' lines). Diffs must be readable.

## Evaluation
evaluatorModel, final verdict, summary, residual risks.
Also list reviseHistory (attempt → verdict) when present.

## PR
status, title, branch, url (or skip/deny reason). Include a short preview of the
PR body headings that would be posted to GitHub.`,
      tools: [getRecordedState, publishSecurityPr],
    });

    return new SequentialAgent({
      name: 'security_audit',
      description:
        'Clone → parallel security scouts → consolidate findings → author/evaluate/revise patches → publish structured GitHub PR.',
      subAgents: [cloner, scouts, consolidator, reviewLoop, gatekeeper],
    });
  },
});
