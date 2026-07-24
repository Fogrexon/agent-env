# agent-env

並列・自律エージェント用の **TypeScript テンプレート / ハーネス**。オーケストレーションは [Google ADK](https://google.github.io/adk-docs/)（`@google/adk`）、LLM 呼び出しは **provider アダプタ**（`@agent-env/llm`）、データソースは **connector**（`@agent-env/harness`）経由で差し替え・併用できます。

## 構成

```
agents/                  # ADK エージェント（rootAgent）+ collector / runspec-demo
packages/
  shared/                # Zod（ModelRef / RunSpec / Connector meta）
  llm/                   # provider ファクトリ・registry
  harness/               # runAgent / runFromSpec / connectors / guarded tools
docs/                    # ARCHITECTURE + 研究レポート
apps/                    # 将来の管理 UI
scripts/                 # run / run-spec / smoke
```

## セットアップ

```bash
cp .env.example .env     # サンプル用。本番では Vault 等でも可
npm install
npm run build
```

Node.js **≥ 24.13** / npm **≥ 11.8** を想定しています。

## 設定と秘密情報（共通方針）

ライブラリ（`@agent-env/llm` / harness connectors）は **どの env 名やシークレットストアを使うかを決めない**。  
利用側（エージェント実装・アプリ）が `create*Provider` / `create*Connector` にキーや URL を渡します。

| 層 | 注入先 | 備考 |
|----|--------|------|
| LLM | `registerProviders` / `create*Provider` | 任意ヘルパー `bootstrapProvidersFromEnv()` あり（一例） |
| Connector | `create*Connector` / `registerConnectors({ ... })` | **`*FromEnv` は置かない**。配線はエージェント側 |

## Provider の例

```typescript
import {
  registerProviders,
  createOpenaiCompatibleProvider,
  registerProvider,
  resolveModel,
} from '@agent-env/llm';

registerProviders({
  gemini: { apiKey: () => process.env.GEMINI_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY! },
  anthropic: { apiKey: () => process.env.ANTHROPIC_API_KEY },
  cursor: { apiKey: () => process.env.CURSOR_API_KEY },
  openaiCompatible: [
    {
      id: 'lm-studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: () => process.env.LM_STUDIO_API_KEY,
    },
    { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  ],
});

registerProvider(
  createOpenaiCompatibleProvider({
    id: 'vllm-prod',
    baseUrl: 'https://vllm.example.com/v1',
    apiKey: () => mySecretStore.get('vllm'),
  }),
);

resolveModel({ provider: 'lm-studio', model: 'local-model' });
```

`bootstrapProvidersFromEnv()` は **LLM だけ**の env 一例です。Vault 等なら自前で `registerProviders` してください。

複数の OpenAI 互換をそのヘルパー経由で渡す例:

```bash
OPENAI_COMPATIBLE_PROVIDERS=[{"id":"lm-studio","baseUrl":"http://127.0.0.1:1234/v1","apiKeyEnv":"LM_STUDIO_API_KEY"},{"id":"ollama","baseUrl":"http://127.0.0.1:11434/v1"}]
```

## RunSpec（Phase A）

研究レポートに沿った **version 付き実行仕様 → state machine → 独立 verifier** の入口です。

```bash
npm run smoke:runtime
npm run run:spec -- agents/runspec-demo/runspec.demo.json
```

## データソース収集（collector）

複数コネクタから並列に証拠を集め、1 つの brief に合成します（スケジューラ不要）。

```bash
npm run smoke:connectors
npm run smoke:connectors:http
npm run run:collector
# 同等: npm run run:spec -- agents/collector/runspec.collect.json collector
```

| ファクトリ | 用途 |
|------------|------|
| `createMemoryConnector` | フィクスチャ / ローカル配列 |
| `createSimpleHttpJsonConnector` | REST JSON（最速追加） |
| `createHttpJsonConnector` | リクエスト / マッピング完全制御 |
| `createGithubGhConnector` | `gh search` issues/PRs |
| `createWebSearchConnector` | 公開 Web（Tavily / Brave） |
| `createGrokBuildXSearchConnector` | X posts（Grok Build headless） |

コネクタの設定例（秘密は呼び出し側が用意）:

```typescript
import {
  createMemoryConnector,
  createSimpleHttpJsonConnector,
  createGithubGhConnector,
  createGrokBuildXSearchConnector,
  createWebSearchConnector,
  registerConnectors,
  registerConnector,
} from '@agent-env/harness';

// まとめて登録 — options はすべて呼び出し側が組み立てる
await registerConnectors({
  demo: true,
  githubGh: { repo: 'owner/name' }, // 認証は `gh auth`
  grokBuildX: { model: 'grok-4' }, // 認証は `grok login`
  webSearch: {
    provider: 'tavily',
    apiKey: () => mySecretStore.get('tavily'),
  },
  http: [
    {
      id: 'posts',
      title: 'Posts API',
      description: 'REST JSON list',
      url: 'https://jsonplaceholder.typicode.com/posts',
      titleKey: 'title',
      snippetKey: 'body',
      headers: () => ({
        Authorization: `Bearer ${mySecretStore.get('http')}`,
      }),
    },
  ],
});

// 個別追加も可
registerConnector(
  createMemoryConnector({
    id: 'notion_mirror',
    title: 'Notion mirror',
    description: 'Locally synced pages',
    records: [{ title: 'RFC', body: '...' }],
  }),
);

registerConnector(
  createWebSearchConnector({
    provider: 'tavily',
    apiKey: () => mySecretStore.get('tavily'),
  }),
);

registerConnector(
  createGithubGhConnector({
    repo: () => config.githubRepo, // env でも定数でもよい
  }),
);

registerConnector(createGrokBuildXSearchConnector());
```

サンプルの `agents/collector` はデモのために `.env` から値を読んで渡していますが、それは **そのエージェントの責務**です。harness のコネクタ API 自体は env 名を知りません。

詳細は [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) と  
[docs/research/2026-07-23-llm-agent-execution-harness.md](./docs/research/2026-07-23-llm-agent-execution-harness.md) を参照。

## 実行

```bash
npm run adk:web
npm run run -- hello "ホストの現在時刻を教えて"
npm run run -- parallel-pipeline "リモートワークを評価して"
npm run smoke
```

## モデル指定（ModelRef）

```typescript
model: resolveModel({ provider: 'gemini', model: 'gemini-2.5-flash' })
model: resolveModel({ provider: 'lm-studio', model: 'local-model' })
```

| kind / 典型 id | 用途 |
|----------------|------|
| `gemini` | Google Gemini（ADK ネイティブ / FunctionTools） |
| `cursor` | Cursor SDK |
| `openai` | OpenAI 公式 |
| `anthropic` | Anthropic |
| 任意 id (`lm-studio` 等) | OpenAI 互換（`kind: "openai-compatible"`） |

## 新しいエージェント

1. `agents/<id>/agent.ts` で provider / connector を register してから `resolveModel`
2. workspace `package.json` / `tsconfig.json`
3. `packages/harness/src/registry.ts` に manifest
4. ルート `tsconfig.json` の references
5. `npm install && npm run build`

## ドキュメント

- ADK TypeScript: https://google.github.io/adk-docs/get-started/typescript/
- Cursor SDK: https://cursor.com/docs/sdk/typescript
- [AGENTS.md](./AGENTS.md)
