# @agent-env/plugins-meta

Meta workflow agents for [agent-env](https://github.com/) hosts — scaffolding and
maintaining other agent definitions.

This pack only exports `agentDefinition` modules (`<id>/agent.ts`). It does
**not** run agents by itself — place it under an agent-env host's `plugins/`
directory.

```bash
cd /path/to/agent-env && npm install
npm run run -- agent-author "web scraper agent を plugins/showcase に追加して"
npm run admin   # Catalog → Meta → エージェント作成（Chat）
```

## Agents

| id | title | role |
|---|---|---|
| agent-author | エージェント作成 | Scaffold `agent.ts` (+ optional `params.yaml`), choose or create a plugin pack, optional git commit/push |

## Grouping (packs)

- Each subdirectory of `plugins/` is a **pack** (agents root).
- New workflow agents go in `plugins/<pack>/<id>/agent.ts`.
- Builtin samples stay in `agents/<id>/` (thin demos only).
- Heavier private automation: `plugins/personal/` (often separate git).
- Discovery is filesystem-only — no registry edits.

## Contract

- Depends on `@agent-env/harness` / `@agent-env/shared` (host workspaces).
- Do not import `@agent-env/repo-env` from agent definitions.
- Git push uses host `git` / remote auth; never force-push.
