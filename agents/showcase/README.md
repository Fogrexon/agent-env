# @agent-env/agents-showcase

Thin workflow demos for agent-env execution environments.

This pack only exports `agentDefinition` modules (`<id>/agent.ts`). It does **not**
run agents by itself — place it under an agent-env host's `agents/showcase/` directory.

Heavier personal automation lives in `agents/personal/` (same host, different pack).

```bash
cd /path/to/agent-env && npm install
npm run run -- hello "ping"                 # builtin sample
npm run run -- character-chat "今日のおすすめは？"  # this pack
npm run run -- web-qa "…"                   # this pack
npm run admin
```

## Agents

| id | role |
|---|---|
| character-chat | Stay-in-character chat (no tools) |
| web-qa | Web search → short answer |

## Contract

- Depends on `@agent-env/harness` / `@agent-env/shared` (provided by the host workspaces).
- Do not import `@agent-env/repo-env` from agent definitions.
- Secrets stay in the host `.env`, not in this pack (`web-qa` needs `TAVILY_API_KEY` or `BRAVE_API_KEY`).
