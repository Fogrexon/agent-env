import { join, resolve, sep } from 'node:path';
import {
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

function isAgentDefinitionWriteTarget(
  absPath: string,
  repoRoot: string,
): boolean {
  const pluginsDir = join(repoRoot, 'plugins');
  const agentsDir = join(repoRoot, 'agents');
  const devEnvDir = join(agentsDir, 'dev-env');

  if (!isUnderDir(absPath, pluginsDir) && !isUnderDir(absPath, agentsDir)) {
    return false;
  }
  if (isUnderDir(absPath, devEnvDir)) return false;
  if (isUnderDir(absPath, join(repoRoot, 'packages'))) return false;
  if (isUnderDir(absPath, join(repoRoot, 'apps'))) return false;
  if (isUnderDir(absPath, join(repoRoot, 'scripts'))) return false;
  return true;
}

/**
 * Meta agent: scaffold agent.ts (+ optional params.yaml), place under a plugin
 * pack or builtin agents/, optionally commit / push via harness git tools.
 */
export const agentDefinition = defineAgent({
  id: 'agent-author',
  name: 'エージェント作成',
  description:
    '新しいエージェント定義を plugins/ または agents/ に作成し、任意で git commit/push する。',
  mode: 'interactive',
  limits: {
    maxSteps: 40,
    maxToolCalls: 48,
    maxWallSeconds: 900,
  },
  createAgent(context: AgentBuildContext) {
    const repoRoot = resolve(context.repoRoot);
    const pluginsDir = join(repoRoot, 'plugins');
    const agentsDir = join(repoRoot, 'agents');

    const allowWrite = context.inputs?.['allowWrite'] === true;
    const allowGitCommit = context.inputs?.['allowGitCommit'] === true;
    const allowGitPush = context.inputs?.['allowGitPush'] === true;

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
        approve: ({ input }) =>
          allowWrite && isAgentDefinitionWriteTarget(input.path, repoRoot),
      },
    });

    const git = createGitTools({
      resolveWorkdir: fs.resolvePath,
      add: {
        approve: () => allowGitCommit,
      },
      commit: {
        approve: () => allowGitCommit,
      },
      push: {
        approve: () => allowGitPush,
      },
    });

    const model = isProviderConfigured('cursor')
      ? 'cursor:auto'
      : 'gemini:gemini-3.6-flash';

    const policyLines = [
      `allowWrite=${allowWrite}`,
      `allowGitCommit=${allowGitCommit}`,
      `allowGitPush=${allowGitPush}`,
    ].join(', ');

    const tools: BaseTool[] = [
      fs.listFiles,
      fs.readFile,
      fs.writeFile,
      git.status,
      git.diff,
      git.add,
      git.commit,
      git.push,
    ];

    return new LlmAgent({
      name: 'agent_author',
      model,
      description: `Agent authoring assistant (model=${model}).`,
      instruction: `You help users create and maintain agent-env agent definitions.

## Host layout (filesystem discovery — no registry edits)
- Repo root: ${repoRoot}
- Plugin packs: ${pluginsDir}/<pack>/ — each pack is an agents root
- New workflow agents: plugins/<pack>/<id>/agent.ts (+ optional params.yaml)
- Builtin samples only: agents/<id>/agent.ts (avoid unless user asks for a builtin demo)
- NEVER modify agents/dev-env/, packages/*, apps/*, scripts/, or root package.json

## Grouping rules
1. Prefer an existing pack when it fits (list ${pluginsDir}):
   - showcase/ — thin public demos
   - meta/ — meta tooling (this agent)
   - personal/ — host-owner automation (may be gitignored / separate repo)
2. Create plugins/<new-pack>/ when the user wants a new theme or ownership boundary.
   New packs need only a directory; optional pack-level package.json like showcase/.
3. Agent id = directory name; must match agentDefinition.id and params.yaml agentId.
4. Duplicate ids across packs throw at discovery — search existing agents first.

## Scaffolding contract
- Required: agent.ts exporting agentDefinition via defineAgent from @agent-env/harness
- Optional: params.yaml (AgentParams), per-agent package.json + tsconfig.json (follow showcase/web-qa)
- Use mode: interactive for chat agents, autonomous for batch jobs
- Set limits (maxSteps, maxToolCalls, maxWallSeconds) — do NOT add verification blocks
- Wire secrets only via context.secret() inside createAgent — never process.env in agent code
- Reuse harness connectors (createWebSearchConnector, createWorkspaceFsTools, createGitTools, etc.)
- Do not add per-agent scripts to the root package.json

## Reference templates (read before writing)
- plugins/showcase/web-qa/agent.ts — tools + limits
- plugins/showcase/character-chat/agent.ts — interactive, no tools
- agents/hello/agent.ts — minimal builtin

## Workflow
1. Clarify purpose, id, pack, mode, tools, and params fields.
2. list_files / read_file to inspect packs and avoid id collisions.
3. write_file to create or update agent.ts (+ params.yaml / package.json if needed).
4. Summarize paths created and how to run: npm run run -- <id> "..." or admin Chat.
5. Git (only when user asks AND flags allow):
   - git_status / git_diff to review
   - git_add paths under plugins/ or agents/ only
   - git_commit with a clear message (allowGitCommit)
   - git_push only after explicit user confirmation (allowGitPush). Never force-push.
   - If push is denied or remote missing, tell the user what to run locally.

## Safety
- Current policy: ${policyLines}
- Without allowWrite, you may only read and advise.
- Without allowGitCommit / allowGitPush, explain git steps but do not mutate git.
- Never commit secrets (.env, API keys).

Be concise in chat; show the final file paths and run command.`,
      tools,
    });
  },
});
