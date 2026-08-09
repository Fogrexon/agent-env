# Plugin packs (workflow definitions)

Each subdirectory of `plugins/` is a **pack**: an agents root whose children are
`<id>/agent.ts` workflow definitions. The execution environment (this repo)
discovers them and runs them via `runDiscoveredAgent` / admin — packs do not
own the run loop.

## In-tree pack

| pack | purpose |
|------|---------|
| [`showcase/`](./showcase/) | Thin public demos (character chat, web Q&A) |
| [`meta/`](./meta/) | Meta tooling (agent authoring / scaffolding) |

Builtin samples that stay under `agents/`: `hello`, `harness-demo`, `code-exec`.

## Personal automation (separate git)

Heavy host-owner workflows live in a **separate private repo** and are cloned
into `plugins/personal/` (gitignored here):

```bash
git clone git@github.com:Fogrexon/agent-env-plugins-personal.git plugins/personal
npm install
```

Or set `AGENT_ENV_PLUGIN_DIRS` to that pack's absolute path.

## Add another pack

```bash
# From the agent-env (execution environment) root:
git clone <pack-repo-url> plugins/<pack-name>
npm install
```

Or copy a pack tree into `plugins/<pack-name>/`.

### Grouping

- **Pack** = one subdirectory of `plugins/` (e.g. `showcase`, `meta`, `personal`).
- **Agent** = `plugins/<pack>/<id>/agent.ts` (id equals directory name).
- Discovery scans every pack automatically; no registry or root `package.json` script per agent.
- Choose an existing pack when the theme fits; create `plugins/<new-pack>/` for a new boundary.
- Builtin samples live under `agents/<id>/` only for thin host demos — prefer `plugins/` for new workflows.
