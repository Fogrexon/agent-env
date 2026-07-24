# agent-env

並列・自律エージェント用の **TypeScript テンプレート / ハーネス**。オーケストレーションは [Google ADK](https://google.github.io/adk-docs/)（`@google/adk`）、LLM 呼び出しは **provider アダプタ**（`@agent-env/llm`）、データソースは **connector**（`@agent-env/harness`）経由で差し替え・併用できます。

## 構成

```
agents/                  # ADK エージェント（rootAgent）
  dev-env/               # このリポ専用の env 配線（@agent-env/repo-env・ライブラリAPIではない）
packages/
  shared/                # Zod（ModelRef / RunSpec / Connector meta）
  llm/                   # provider ファクトリ・registry（env を読まない）
  harness/               # runAgent / runFromSpec / connectors（env を読まない）
docs/                    # ARCHITECTURE + 研究レポート
apps/                    # 将来の管理 UI
scripts/                 # run / run-spec / smoke
```

## セットアップ

```bash
cp .env.example .env     # このリポのエージェント用。本番では任意の秘密管理で可
npm install
npm run build
```

Node.js **≥ 24.13** / npm **≥ 11.8** を想定しています。

## 設定と秘密情報

`@agent-env/llm` と `@agent-env/harness` は **env 名も `.env` も知りません**。  
利用側が `create*Provider` / `create*Connector` にキーや URL を渡します。

このリポジトリのエージェントは `@agent-env/repo-env`（`agents/dev-env/`）から env を読んで渡しています。別アプリではそのパッケージを使わず、自前で `registerProviders` / connector を配線してください。

## Provider の例

```typescript
import {
  registerProviders,
  createOpenaiCompatibleProvider,
  registerProvider,
  resolveModel,
} from '@agent-env/llm';

registerProviders({
  gemini: { apiKey: () => mySecrets.gemini },
  openai: { apiKey: mySecrets.openai },
  anthropic: { apiKey: () => mySecrets.anthropic },
  cursor: { apiKey: () => mySecrets.cursor },
  openaiCompatible: [
    {
      id: 'lm-studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: () => mySecrets.lmStudio,
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

## RunSpec（Phase A）

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
```

| ファクトリ | 用途 |
|------------|------|
| `createMemoryConnector` | フィクスチャ / ローカル配列 |
| `createSimpleHttpJsonConnector` | REST JSON（最速追加） |
| `createHttpJsonConnector` | リクエスト / マッピング完全制御 |
| `createGithubGhConnector` | `gh search` issues/PRs |
| `createWebSearchConnector` | 公開 Web（Tavily / Brave） |
| `createGrokBuildXSearchConnector` | X posts（Grok Build headless） |

```typescript
import {
  createWebSearchConnector,
  createGrokBuildXSearchConnector,
  createGithubGhConnector,
  registerConnectors,
} from '@agent-env/harness';

await registerConnectors({
  demo: true,
  githubGh: { repo: 'owner/name' },
  grokBuildX: { model: 'grok-4' },
  webSearch: {
    provider: 'tavily',
    apiKey: () => mySecretStore.get('tavily'),
  },
});

registerConnector(
  createWebSearchConnector({
    provider: 'tavily',
    apiKey: () => mySecretStore.get('tavily'),
  }),
);
```

詳細は [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

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
