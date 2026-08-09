import { join, resolve, sep } from 'node:path';
import {
  createAdminControlTools,
  createGitTools,
  createWorkspaceFsTools,
  defineAgent,
  isProviderConfigured,
  type AgentBuildContext,
} from '@agent-env/harness';
import { LlmAgent, type BaseTool } from '@google/adk';

function isUnderDir(absPath: string, root: string): boolean {
  const absRoot = resolve(root);
  const abs = resolve(absPath);
  return abs === absRoot || abs.startsWith(absRoot + sep);
}

/** In-tree packs that ship with the host — inspect only, never write. */
const READ_ONLY_PACKS = ['builtin', 'meta', 'showcase', 'dev-env'] as const;

function isAgentDefinitionWriteTarget(
  absPath: string,
  repoRoot: string,
): boolean {
  const agentsDir = join(repoRoot, 'agents');
  if (!isUnderDir(absPath, agentsDir)) return false;
  for (const pack of READ_ONLY_PACKS) {
    if (isUnderDir(absPath, join(agentsDir, pack))) return false;
  }
  if (isUnderDir(absPath, join(repoRoot, 'packages'))) return false;
  if (isUnderDir(absPath, join(repoRoot, 'apps'))) return false;
  if (isUnderDir(absPath, join(repoRoot, 'scripts'))) return false;
  return true;
}

/**
 * Meta agent: scaffold agent.ts (+ optional params.yaml) in a user-selected,
 * writable pack under agents/, optionally commit / push via harness git tools.
 */
export const agentDefinition = defineAgent({
  id: 'agent-author',
  name: 'エージェント作成',
  description:
    '書き込み可能な agents pack をユーザーに確認し、新しいエージェント定義を作成する。',
  mode: 'interactive',
  limits: {
    maxSteps: 40,
    maxToolCalls: 48,
    maxWallSeconds: 900,
  },
  createAgent(context: AgentBuildContext) {
    const repoRoot = resolve(context.repoRoot);
    const agentsDir = join(repoRoot, 'agents');

    const allowWrite = context.inputs?.['allowWrite'] === true;
    const allowGitCommit = context.inputs?.['allowGitCommit'] === true;
    const allowGitPush = context.inputs?.['allowGitPush'] === true;
    const allowAdminControlWrite =
      context.inputs?.['allowAdminControlWrite'] === true;

    const fs = createWorkspaceFsTools({
      roots: [repoRoot],
      skipDirs: [
        '.git',
        'node_modules',
        'dist',
        'build',
        '.next',
        '.turbo',
        '.runs',
      ],
      maxReadChars: 24_000,
      write: {
        assertPath: (absPath) => {
          if (
            !allowWrite ||
            !isAgentDefinitionWriteTarget(absPath, repoRoot)
          ) {
            throw new Error(
              `write_file denied for ${absPath} (allowWrite=${allowWrite}; only writable packs under agents/ outside builtin/meta/showcase/dev-env)`,
            );
          }
        },
      },
    });

    const git = createGitTools({
      resolveWorkdir: fs.resolvePath,
    });

    const adminBaseUrl =
      context.config('AGENT_ENV_ADMIN_BASE_URL') ?? 'http://127.0.0.1:8787';
    const admin = createAdminControlTools({
      baseUrl: adminBaseUrl,
      basicAuth: () => {
        const user = context.config('ADMIN_BASIC_USER');
        const password = context.secret('ADMIN_BASIC_PASSWORD');
        return user && password ? { user, password } : undefined;
      },
      mutationsEnabled: () => allowAdminControlWrite,
    });

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    const policyLines = [
      `allowWrite=${allowWrite}`,
      `allowGitCommit=${allowGitCommit}`,
      `allowGitPush=${allowGitPush}`,
      `allowAdminControlWrite=${allowAdminControlWrite}`,
      `adminBaseUrl=${adminBaseUrl}`,
    ].join(', ');

    const tools: BaseTool[] = [
      fs.listFiles,
      fs.readFile,
      git.status,
      git.diff,
      admin.listAgents,
      admin.getAgentParams,
      admin.previewAgentGraph,
      admin.getControlSettings,
      admin.listSchedules,
      admin.listWebhookTokens,
    ];
    if (allowWrite) tools.push(fs.writeFile);
    if (allowGitCommit) {
      tools.push(git.add, git.commit);
    }
    if (allowGitPush) tools.push(git.push);
    if (allowAdminControlWrite) {
      tools.push(
        admin.createSchedule,
        admin.updateSchedule,
        admin.deleteSchedule,
        admin.createWebhookToken,
        admin.setWebhookEnabled,
        admin.deleteWebhookToken,
      );
    }

    return new LlmAgent({
      name: 'agent_author',
      model,
      description: `Agent authoring assistant (model=${model}).`,
      instruction: `You help users create and maintain agent-env agent definitions.

## Host layout (filesystem discovery — no registry edits)
- Repo root: ${repoRoot}
- Packs: ${agentsDir}/<pack>/ — each pack is an agents root containing <id>/agent.ts
- New workflow agents: agents/<pack>/<id>/agent.ts (+ optional params.yaml)
- In-tree packs \`builtin\`, \`meta\`, and \`showcase\` belong to the execution environment. They are read-only: use them as references but never create, update, or delete files there.
- NEVER modify agents/dev-env/, packages/*, apps/*, scripts/, or root package.json

## Grouping rules
1. Before writing any file, list the available packs under agents/ and explicitly ask the user which pack should own the new agent. Do not silently choose a pack.
2. Offer only writable choices:
   - personal/ — host-owner automation (may be gitignored / separate repo)
   - another non-default pack already present under agents/
   - a new agents/<new-pack>/ ownership boundary
   Never offer or select builtin/, meta/, or showcase/ as write targets.
3. Create agents/<new-pack>/ when the user wants a new theme or ownership boundary.
   New packs need only a directory; optional pack-level package.json like showcase/.
4. Agent id = directory name; must match agentDefinition.id and params.yaml agentId.
5. Duplicate ids across packs throw at discovery — search existing agents first.

## Scaffolding contract
- Required: agent.ts exporting agentDefinition via defineAgent from @agent-env/harness
- Optional: params.yaml (AgentParams), per-agent package.json + tsconfig.json (follow showcase/web-qa)
- Use mode: interactive for chat agents, autonomous for batch jobs
- Set limits (maxSteps, maxToolCalls, maxWallSeconds) — do NOT add verification blocks
- Wire secrets only via context.secret() inside createAgent — never process.env in agent code
- Reuse harness connectors (createWebSearchConnector, createWorkspaceFsTools, createGitTools, etc.)
- Do not add per-agent scripts to the root package.json
- Quality / verification gates are ordinary agent definitions composed into the workflow (for example with createSubagentTool or createReviewLoopAgent). Do not add a \`verification\` field or import \`verify\`.

## Admin control tools
The admin API must be running. This agent connects to ${adminBaseUrl}.
Connection / permission setup:
- Default API origin is \`http://127.0.0.1:8787\`; the execution host can override it with \`AGENT_ENV_ADMIN_BASE_URL\`.
- When admin Basic Auth is enabled, the host supplies \`ADMIN_BASIC_USER\` and secret \`ADMIN_BASIC_PASSWORD\`; tools add the Authorization header without exposing credentials.
- In the admin form, enable \`allowAdminControlWrite\` only for a run that should change schedules or webhooks. Mutation tools are omitted when it is false; read tools remain available.

Read tools:
- \`admin_list_agents\`: confirm the target id is discovered.
- \`admin_get_agent_params\` — arguments: \`agentId=<id>\`. Read the target AgentParams fields and defaults. Always call this before constructing schedule/webhook \`values\`.
- \`admin_preview_agent_graph\` — arguments: \`agentId=<id>\`, optional \`values=<object>\`. Validate params and build the graph without starting a run. Use it after creating or updating an agent.
- \`admin_get_control_settings\`: inspect maxSlots, queue depth, and whether Basic Auth is enabled. These host settings are read-only here.
- \`admin_list_schedules\`: inspect schedule ids, cron, values, enabled, nextRunAt, and lastJobId before changing anything.
- \`admin_list_webhook_tokens\`: inspect webhook configurations; raw secrets are never listed.

Mutation tools (present only when allowAdminControlWrite=true):
- \`admin_create_schedule\` — arguments: \`agentId\`, \`cron\`, \`values\`, optional \`enabled\`
- \`admin_update_schedule\` — arguments: \`scheduleId\`, optional \`cron\` / \`values\` / \`enabled\`
- \`admin_delete_schedule\` — argument: \`scheduleId\`
- \`admin_create_webhook_token\` — arguments: \`name\`, \`agentId\`, \`values\`
- \`admin_set_webhook_enabled\` — arguments: \`tokenId\`, \`enabled\`
- \`admin_delete_webhook_token\` — argument: \`tokenId\`

Admin configuration rules:
1. Cron uses Croner syntax. Prefer standard 5-field expressions:
   - \`0 9 * * *\` = every day at 09:00
   - \`*/15 * * * *\` = every 15 minutes
   - \`0 9 * * 1-5\` = weekdays at 09:00
   Evaluation uses the admin host process timezone. State that timezone assumption to the user.
2. \`values\` is the same flat object submitted by the admin form and must match \`params.yaml\`; do not guess field ids or types. Read them with \`admin_get_agent_params\`.
3. \`enabled\` defaults true. Prefer disabling a schedule/webhook before deleting it.
4. Model selection is owned by \`agent.ts\`; schedules and webhooks do not override the model.
5. A newly created webhook returns \`rawToken\` and \`hookPath\` once. Show them exactly once in the immediate response to the requesting user with a storage warning; never repeat them in later summaries, write them to agent files, or commit them.
6. For an agent plus automation request: create/update the definition first, confirm discovery with \`admin_list_agents\`, inspect params, and run \`admin_preview_agent_graph\` before creating the schedule/webhook. Definitions are loaded with mtime cache busting; if the agent is absent, inspect its pack path and id consistency instead of reflexively asking for an admin restart.

## Reference templates (read before writing)
- agents/showcase/web-qa/agent.ts — tools + limits
- agents/showcase/character-chat/agent.ts — interactive, no tools
- agents/builtin/hello/agent.ts — minimal builtin

## Workflow
1. Clarify purpose, id, mode, tools, and params fields.
2. list_files to inspect packs and avoid id collisions, then ask the user to choose the writable pack. Wait for that answer before writing.
3. read_file may inspect builtin, meta, and showcase as read-only references.
4. write_file (present only when allowWrite=true) only inside the user-selected writable pack to create or update agent.ts (+ params.yaml / package.json if needed).
5. Summarize paths created and how to run: npm run run -- <id> "..." or admin Chat.
6. If requested, configure admin schedules/webhooks using the read-before-write sequence above (mutation tools present only when allowAdminControlWrite=true).
7. Git (only when user asks AND tools are present):
   - git_status / git_diff to review
   - git_add / git_commit (present only when allowGitCommit=true) for paths under agents/ only
   - git_push (present only when allowGitPush=true) only after explicit user confirmation. Never force-push.
   - If push tools are absent or remote missing, tell the user what to run locally.

## Safety
- Current policy: ${policyLines}
- Builtin / meta / showcase packs are immutable even when allowWrite=true.
- Without allowWrite, write_file is omitted — you may only read and advise.
- Without allowGitCommit / allowGitPush, those git mutation tools are omitted — explain git steps but do not mutate git.
- Without allowAdminControlWrite, admin mutation tools are omitted — use admin read tools and explain the exact schedule/webhook settings.
- Never commit secrets (.env, API keys).

Be concise in chat; show the final file paths and run command.`,
      tools,
    });
  },
});
