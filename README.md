# agent-env

並列・自律エージェント用の **TypeScript テンプレート / ハーネス**。オーケストレーションは [Google ADK](https://google.github.io/adk-docs/)（`@google/adk`）、LLM 呼び出しは **provider アダプタ**（`@agent-env/llm`）、データソースは **connector**（`@agent-env/harness`）経由で差し替え・併用できます。

## 構成

このリポジトリは **実行環境**（ハーネス + admin + CLI）です。ワークフロー定義は `agents/<pack>/` のパックとして読み込み、実行の主体は常にホスト側（`runDiscoveredAgent` → `executeAgentRun`）にあります。

```
agents/                  # 定義パック + ホスト配線
  <pack>/<id>/           # builtin / showcase / meta / personal など
    agent.ts             # export agentDefinition（必須）
    params.yaml          # 任意
  dev-env/               # discovery / .env bootstrap / host limits（@agent-env/repo-env）
packages/
  shared/                # Zod（ModelRef / AgentExecutionLimits / Connector meta）
  llm/                   # provider ファクトリ・registry（env を読まない）
  harness/               # defineAgent / executeAgentRun / connectors（env を読まない）
docs/                    # ARCHITECTURE + 研究レポート
apps/admin/              # 管理 UI（実行環境の一部）
scripts/                 # run / smoke
```

## セットアップ

```bash
cp .env.example .env     # 実行環境用。秘密はここだけ
npm install
npm run build
```

パックを足す場合:

```bash
# 薄いデモは agents/showcase に同梱
# 個人自動化:
git clone git@github.com:Fogrexon/agent-env-plugins-personal.git agents/personal
npm install
```

詳細は [agents/README.md](agents/README.md)。

Node.js **≥ 24.13** / npm **≥ 11.8** を想定しています。

## 設定と秘密情報

`@agent-env/llm` と `@agent-env/harness` は **env 名も `.env` も知りません**。  
利用側が `create*Provider` / `create*Connector` にキーや URL を渡します。

このリポジトリの実行環境ホストは `@agent-env/repo-env`（`agents/dev-env/`）から env を読んで渡します。ワークフロー定義パック（`agents/<pack>/`）は env を読まず、ホストが注入した context だけを使います。

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
  openrouter: { apiKey: () => mySecrets.openrouter },
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

## エージェント定義と検証

```bash
npm run smoke:runtime
npm run run -- harness-demo "短いデモを実行して"
```

実行は常に discovery 経由で `agents/<id>/agent.ts` の `agentDefinition` を読み、`runDiscoveredAgent` → `executeAgentRun` で走らせます。実行制限（`limits`: maxSteps / maxToolCalls / maxWallSeconds / maxSubagentDepth）は `agentDefinition` 自身が持ち、host 側の既定ポリシー（`agents/dev-env/execution-policy.ts`）と自動的にマージされます（各フィールドは agent 値と host 値の小さい方）。ランタイムはこれを唯一の真として実行し、run 単位のモデル上書きはありません。

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
});
// 許可時だけ tools に載せる（例: AGENT_ENV_CODE_EXEC_ALLOW=1）
```

## Python スクリプト（YOLO 等の事前宣言パイプライン）

YOLO / OpenCV のような固定処理は **`agents/<id>/python/`** に置き、`createPythonScriptTool` で typed tool 化する（モデルに任意コードを書かせない）。

```
agents/<id>/python/
  requirements.txt
  scripts/detect.py
  .venv/                 # uv が生成（gitignore）
```

```bash
npm run smoke:python-env
npm run run -- python-vision "scene-person.jpg を triage して"
```

実 YOLO に差し替えるときは `requirements.txt` に `ultralytics` 等を足し、`scripts/detect.py` を本物の推論に置き換える。stdout の JSON 契約（`detections[]` 等）を維持すればエージェント側はほぼそのまま。

依存管理は **uv**（`ensurePythonEnv` → `uv venv` + `uv pip install`）。`python -m venv` / 生 pip は使わない。

AI 生成 Pythonが必要な場合のみ `createPythonCodeRunnerTool`（T2）。

## Knowledge / RAG

ローカル Markdown・コード・PDF を差分インデックスし、BM25 + optional embeddings のハイブリッド検索で根拠付き回答します。

```bash
npm run smoke:knowledge
npm run run -- knowledge-assistant "実行 limits はどこで定義しますか？"
```

- Index: `.agent-env/knowledge/<collection>.sqlite`
- Tools: `knowledge_sync` / `knowledge_search` / live `glob_files`・`search_text`
- Embedder は呼び出し側注入（既定デモは決定論的。本番は OpenAI-compatible / Gemini）

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
| `createGitTools` | `git status` / `diff` / `add` / `commit` / `push`（approve 注入） |
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

### Builtin（`agents/builtin/`）

| id | 内容 | 追加要件 |
|----|------|----------|
| `hello` | 最小の単一エージェント | — |
| `harness-demo` | `limits` + guarded tools + typed result handoff | — |
| `code-exec` | FunctionTool + 任意の TS code runner | — |

### Showcase（`agents/showcase/` — 薄いデモ）

| id | 内容 | 追加要件 |
|----|------|----------|
| `character-chat` | キャラなりきり対話のみ（ツールなし） | — |
| `web-qa` | Web 検索して答えるだけ | `TAVILY_API_KEY` または `BRAVE_API_KEY` |

### Personal（別リポ → `agents/personal/`）

個人自動化は [Fogrexon/agent-env-plugins-personal](https://github.com/Fogrexon/agent-env-plugins-personal)（private）を clone する。

```bash
git clone git@github.com:Fogrexon/agent-env-plugins-personal.git agents/personal
npm install
```

| id | 内容 | 追加要件 |
|----|------|----------|
| `parallel-pipeline` | PRO/CON 開弁→反論×2（並列）→判定（web/X 検索可） | `TAVILY_API_KEY`（任意・推奨） |
| `collector` | 複数コネクタ並列収集 → brief | 任意: `gh` / `TAVILY_API_KEY` |
| `deep-research` | **Tavily** + optional **X (Grok Build)** deep research | `TAVILY_API_KEY`（X は `grok login`） |
| `security-audit` | GitHub clone → 並列 scout → Finding/Patch → 評価 → 構造化 PR | `git` / PR には `gh` |
| `python-vision` | 局所 Python（uv）で mock YOLO → 判断 | `uv` |
| `knowledge-assistant` | local hybrid RAG（BM25+embeddings）+ citations | — |
| `investigator` | 再利用可能な Web 調査（単体でも親からも） | `TAVILY_API_KEY` または `BRAVE_API_KEY` |
| `research-desk` | `createSubagentTool` で `investigator` を呼んで統合 | 同上 |

```bash
npm run run -- character-chat "今日のおすすめは？"
npm run run -- web-qa "…"
npm run run -- deep-research "…"   # personal pack が必要
npm run run -- knowledge-assistant "実行 limits はどこで定義しますか？"
```

security-audit の書き込み系ツールは、エージェントが env / params でツールを載せるかどうかのデモです:

- `write_fix`… `AGENT_ENV_AUDIT_ALLOW_WRITE=1` のときだけ tools に載る
- `create_pr`… `AGENT_ENV_AUDIT_ALLOW_PR=1` + push 権限のときだけ載る
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

エージェント内では通常 `provider:model` 文字列を ADK の `LlmAgent.model` に直接渡すだけでよい（ADK LLMRegistry が registry 経由で解決する）:

```typescript
model: 'cursor:auto'
model: 'gemini:gemini-3.6-flash'
```

明示的に `BaseLlm` インスタンスが要る場合（provider を跨いだ切替・カスタムルーティング等）は `resolveModel` を使う:

```typescript
model: resolveModel({ provider: 'cursor', model: 'auto' })
model: resolveModel({ provider: 'gemini', model: 'gemini-3.6-flash' })
model: resolveModel({ provider: 'lm-studio', model: 'local-model' })
```

どちらの経路でも run 単位のモデル上書きはありません（モデルは `agentDefinition` が決める）。

| kind / 典型 id | 用途 |
|----------------|------|
| `cursor` | Cursor SDK（デモの既定。FunctionTools は SDK customTools 経由でブリッジ） |
| `gemini` | Google Gemini（ADK ネイティブ FunctionTools。API key または Vertex ADC。フォールバック） |
| `openai` | OpenAI 公式 |
| `openrouter` | OpenRouter（OpenAI 互換。モデル id は `openai/gpt-4o-mini` 等） |
| `anthropic` | Anthropic（API key または Vertex ADC） |
| 任意 id (`lm-studio` 等) | OpenAI 互換（`kind: "openai-compatible"`） |

## 新しいエージェント

1. `agents/<id>/agent.ts`（`export const agentDefinition = defineAgent({ id, name, description, limits, createAgent })`、必要なら connector 配線）
2. 完了 — `packages/*`・ルート `package.json` は触らない（`scripts/` / admin が `agents/*/` を自動発見）

任意:

- `agents/<id>/params.yaml`（呼出し入力フォーム定義。無ければ既定の単一 `message` フィールド）
- workspace 用に `agents/<id>/package.json` + root `tsconfig.json` references（型チェック用）

詳細手順・CLI `--params` は [docs/AGENT_PACKAGE.md](./docs/AGENT_PACKAGE.md)。

## ドキュメント

- **エージェント追加の正本:** [docs/AGENT_PACKAGE.md](./docs/AGENT_PACKAGE.md)
- ADK TypeScript: https://google.github.io/adk-docs/get-started/typescript/
- Cursor SDK: https://cursor.com/docs/sdk/typescript
- [AGENTS.md](./AGENTS.md)
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
