# agent-env

並列・自律エージェント用の **TypeScript テンプレート / ハーネス**。オーケストレーションは [Google ADK](https://google.github.io/adk-docs/)（`@google/adk`）、LLM 呼び出しは **provider アダプタ**（`@agent-env/llm`）、データソースは **connector**（`@agent-env/harness`）経由で差し替え・併用できます。

## 構成

```
agents/                  # エージェントパッケージ（agentDefinition）
  <id>/
    agent.ts             # export agentDefinition
    params.yaml          # 呼出し入力スキーマ
    runspec.json         # 実行ポリシー
    evaluation.json      # 成功判定（EvaluationSpec）
  dev-env/               # このリポ専用の env 配線（@agent-env/repo-env）
packages/
  shared/                # Zod（ModelRef / RunSpec / EvaluationSpec / Connector meta）
  llm/                   # provider ファクトリ・registry（env を読まない）
  harness/               # defineAgent / runFromSpec / connectors（env を読まない）
docs/                    # ARCHITECTURE + 研究レポート
apps/                    # admin UI
scripts/                 # run / smoke
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
  // API key OR Vertex ADC (mutually chosen by caller)
  gemini: { apiKey: () => mySecrets.gemini },
  // gemini: { vertex: { project: 'my-gcp', location: 'us-central1' } },
  openai: { apiKey: mySecrets.openai },
  anthropic: { apiKey: () => mySecrets.anthropic },
  // anthropic: { vertex: { projectId: 'my-gcp', region: 'us-east5' } },
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

## RunSpec + EvaluationSpec

```bash
npm run smoke:runtime
npm run run -- runspec-demo "短いデモを実行して"
```

実行は常に `agents/<id>/runspec.json` と `evaluation.json` を discovery 経由で読みます（別パス指定の `run:spec` は廃止）。

## TypeScript 実行（code-exec）

固定処理はエージェント側の **FunctionTool**（LLM が関数呼び出し）。  
AI が書いた TS だけ `createTsCodeRunnerTool` で process jail 実行します（Docker/microVM は未実装）。

依存はエージェント単位の `agents/<id>/exec/package.json` に宣言し、`ensureExecEnv` / `createExecEnvGuard` が必要時に `npm install` します（モデルが任意パッケージを入れない）。

```bash
npm run smoke:code-exec
npm run exec:env -- agents/code-exec/exec          # 依存を用意
npm run run -- code-exec "sum で 1, 2, 3 を足して"
# 生成コード実行を許可する場合:
# AGENT_ENV_CODE_EXEC_ALLOW=1 npm run run -- code-exec "ms で 1h をミリ秒にして"
```

```typescript
import {
  createExecEnvGuard,
  createGuardedTool,
  createTsCodeRunnerTool,
} from '@agent-env/harness';

const hello = createGuardedTool({ /* 固定ロジック */ ... });

const execRoot = resolve(agentDir, 'exec');
const runTsCode = createTsCodeRunnerTool({
  workRoot: execRoot,
  prepare: createExecEnvGuard({ moduleRoot: execRoot }),
  approve: () => allowGeneratedCode, // T2: fail-closed without this
});
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
| `createGithubTools` | GitHub 書き込み系（`createPr` 等） |
| `createWebSearchConnector` | 公開 Web（Tavily / Brave） |
| `createTavilyExtractTool` | Tavily Extract（ページ本文） |
| `createHttpDownloadTool` | URL をルート限定でバイナリ DL（画像など） |
| `createMarkdownPdfTool` | Markdown→PDF（相対画像対応・md-to-pdf） |
| `createWorkspaceFsTools` | ルート限定の list / read / write |
| `createGitCloneTool` | `git clone`（shallow） |
| `createArxivConnector` | arXiv プレプリント（Atom API・鍵不要） |
| `createGrokBuildXSearchConnector` | X posts（Grok Build headless） |

```typescript
import {
  createArxivConnector,
  createWebSearchConnector,
  createGrokBuildXSearchConnector,
  createGithubGhConnector,
  registerConnectors,
} from '@agent-env/harness';

await registerConnectors({
  demo: true,
  arxiv: { categories: ['cs.AI'] },
  githubGh: { repo: 'owner/name' },
  grokBuildX: { model: 'grok-4' },
  webSearch: {
    provider: 'tavily',
    apiKey: () => mySecretStore.get('tavily'),
  },
});

registerConnector(
  createArxivConnector({ categories: ['cs.LG'] }),
);
```

詳細は [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## デモエージェント

すべて **Cursor SDK が既定**（`CURSOR_API_KEY`。未設定時は Gemini にフォールバック）。ツール付きエージェントも `ProviderBackedLlm` → Cursor SDK `customTools` ブリッジで Cursor 上で動きます。

| id | 内容 | 追加要件 |
|----|------|----------|
| `hello` | 最小の単一エージェント | — |
| `parallel-pipeline` | PRO/CON 開弁→反論×2（並列）→判定（web/X 検索可） | `TAVILY_API_KEY`（任意・推奨） |
| `runspec-demo` | RunSpec + guarded tools + 独立 verifier | — |
| `collector` | 複数コネクタ並列収集 → brief | 任意: `gh` / `TAVILY_API_KEY` |
| `deep-research` | **Tavily** + optional **X (Grok Build)** deep research（問い分解 → 探索 → ギャップ埋め → 一枚レポート） | `TAVILY_API_KEY`（X は `grok login`） |
| `security-audit` | GitHub clone → **並列 scout** → Finding/Patch → RunSpec 別モデル評価（**REVISE 時はパッチ修正→再評価**）→ 構造化 PR | `git` / PR には `gh` |

```bash
npm run run -- deep-research "…"
npm run run -- security-audit "Audit https://github.com/Fogrexon/CGEngine ..."
```

security-audit の書き込み系ツールは fail-closed の権限境界デモです:

- `write_fix`（T2）… `AGENT_ENV_AUDIT_ALLOW_WRITE=1` で許可
- `create_pr`（T3）… `AGENT_ENV_AUDIT_ALLOW_PR=1` + push 権限で許可
- 評価モデル上書き … `AGENT_ENV_AUDIT_EVALUATOR_MODEL=provider:model`

## 実行

```bash
npm run adk:web
npm run run -- hello "ホストの現在時刻を教えて"
npm run run -- parallel-pipeline "Remote work should be the default for small engineering teams"
# params.yaml と同形の values JSON（admin の { values } と同じ）:
# npm run run -- security-audit --params ./my-audit.json
# npm run run -- security-audit --params ./my-audit.json --input maxFindings=3 "上書きメッセージ"
npm run smoke
```

## モデル指定（ModelRef）

```typescript
model: resolveModel({ provider: 'cursor', model: 'auto' })
model: resolveModel({ provider: 'gemini', model: 'gemini-3.6-flash' })
model: resolveModel({ provider: 'lm-studio', model: 'local-model' })
```

| kind / 典型 id | 用途 |
|----------------|------|
| `cursor` | Cursor SDK（デモの既定。FunctionTools は SDK customTools 経由でブリッジ） |
| `gemini` | Google Gemini（ADK ネイティブ FunctionTools。API key または Vertex ADC。フォールバック） |
| `openai` | OpenAI 公式 |
| `anthropic` | Anthropic（API key または Vertex ADC） |
| 任意 id (`lm-studio` 等) | OpenAI 互換（`kind: "openai-compatible"`） |

## 新しいエージェント

1. `agents/<id>/agent.ts`（`export const agentDefinition = defineAgent({…})`、必要なら connector 配線）
2. `agents/<id>/params.yaml`（呼出し入力フォーム定義）
3. `agents/<id>/runspec.json` + `evaluation.json`
4. 完了 — `packages/*`・ルート `package.json` は触らない（`scripts/` / admin が `agents/*/` を自動発見）

任意: workspace 用に `agents/<id>/package.json` + root `tsconfig.json` references（型チェック用）

## ドキュメント

- ADK TypeScript: https://google.github.io/adk-docs/get-started/typescript/
- Cursor SDK: https://cursor.com/docs/sdk/typescript
- [AGENTS.md](./AGENTS.md)
