# Connector rules

## When to use a connector

Reusable external data access belongs in `packages/harness/src/connectors/`:

- Web search / page extract
- GitHub / HTTP JSON / arXiv
- Workspace FS list/read/write

Do **not** reimplement vendor HTTP inside `agents/<id>/agent.ts`.

## Wiring pattern

```ts
const web = createWebSearchConnector({
  provider: 'tavily',
  apiKey: () => context.secret('TAVILY_API_KEY'),
});
```

## Error code E-KNOW-404

Raised conceptually when a knowledge citation URI cannot be resolved in the
local index. Agents should report insufficient evidence instead of inventing
URLs.
