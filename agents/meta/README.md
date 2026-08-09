# @agent-env/agents-meta

Meta tooling pack for agent-env: authoring / scaffolding agents.

This directory is an **agents root** (pack). The execution environment discovers
it under `agents/meta/` — place it under an agent-env host's `agents/` tree.

```bash
npm run run -- agent-author "web scraper agent を agents/personal に追加して"
```

## Notes

- Each subdirectory of `agents/` (except `dev-env`) is a **pack** (agents root).
- New workflow agents go in `agents/<pack>/<id>/agent.ts`.
- `builtin` / `meta` / `showcase` are read-only for agent-author writes.
- Heavier private automation: `agents/personal/` (often separate git).
