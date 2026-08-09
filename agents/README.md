# Agent packs

Each subdirectory of `agents/` (except `dev-env/`) is a **pack**: an agents
root whose children are `<id>/agent.ts` workflow definitions. The execution
host discovers them and runs them via `runDiscoveredAgent` / admin — packs do
not own the run loop.

## In-tree packs

| pack | purpose |
|------|---------|
| [`builtin/`](./builtin/) | Thin host demos (`hello`, `harness-demo`, `code-exec`) |
| [`showcase/`](./showcase/) | Thin public demos (character chat, web Q&A) |
| [`meta/`](./meta/) | Meta tooling (agent authoring / scaffolding) |
| [`dev-env/`](./dev-env/) | Host wiring only — not an agents pack |

## Personal automation (separate git)

Heavy host-owner workflows live in a **separate private repo** and are cloned
into `agents/personal/` (gitignored here):

```bash
git clone git@github.com:Fogrexon/agent-env-plugins-personal.git agents/personal
npm install
```

Or set `AGENT_ENV_PLUGIN_DIRS` to that pack's absolute path.

## Add another pack

```bash
# From the agent-env (execution environment) root:
git clone <pack-repo-url> agents/<pack-name>
npm install
```

Or copy a pack tree into `agents/<pack-name>/`.

### Grouping

- **Pack** = one subdirectory of `agents/` (e.g. `builtin`, `showcase`, `meta`, `personal`).
- **Agent** = `agents/<pack>/<id>/agent.ts` (id equals directory name).
- Discovery scans every pack automatically; no registry or root `package.json` script per agent.
- Choose an existing pack when the theme fits; create `agents/<new-pack>/` for a new boundary.
- Prefer `personal/` (or a new pack) for new workflows — do not extend `builtin` / `meta` / `showcase` unless shipping with the host.
