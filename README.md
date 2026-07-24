# agent-env

並列・自律エージェント用の **TypeScript テンプレート / ハーネス**。オーケストレーションは [Google ADK](https://google.github.io/adk-docs/)（`@google/adk`）、LLM 呼び出しは **provider アダプタ**（`@agent-env/llm`）経由で差し替え・併用できます。

将来の Web 管理ツールと型を共有するため、エージェント定義・実行結果・レジストリをすべて TS + Zod で揃えています。

## 構成

```
agents/                  # ADK エージェント（各フォルダが rootAgent を export）
  hello/                 # FunctionTool（スクリプト連携）の最小例
  parallel-pipeline/     # 並列 fan-out（ブランチごとに ModelRef / provider）
packages/
  shared/                # Zod スキーマ・共有型（Web/API 再利用想定）
  llm/                   # LlmProvider ポート・Gemini / Cursor アダプタ・resolveModel
  harness/               # runAgent・レジストリ・createTypedTool
apps/                    # 将来の管理 UI（プレースホルダ）
scripts/run.ts           # ハーネス経由の CLI 実行
```

## セットアップ

```bash
cp .env.example .env
# いずれか（または両方）を設定:
#   GEMINI_API_KEY  https://aistudio.google.com/app/apikey
#   CURSOR_API_KEY  https://cursor.com/dashboard/api

npm install
npm run build
```

Node.js **≥ 24.13** / npm **≥ 11.8** を想定しています。

## 実行

```bash
# ADK 開発 UI（agents/ 配下を選択）
npm run adk:web

# ハーネス経由（型付き結果を収集）
npm run run -- hello "ホストの現在時刻を教えて"
npm run run -- parallel-pipeline "リモートワークを評価して"
```

`parallel-pipeline` は `CURSOR_API_KEY` があると cons ブランチを Cursor、pros / synthesizer を Gemini で並列実行します（未設定時はすべて Gemini）。

## モデル指定（ModelRef）

エージェントごとに `provider` + `model` を宣言します。

```typescript
import { resolveModel } from '@agent-env/llm';

model: resolveModel({ provider: 'gemini', model: 'gemini-2.5-flash' })
model: resolveModel({ provider: 'cursor', model: 'composer-2' })
```

環境変数でも指定できます（`provider:model` 形式）:

```bash
AGENT_ENV_MODEL=gemini:gemini-2.5-flash
AGENT_ENV_CONS_MODEL=cursor:composer-2
```

- **gemini**: ADK ネイティブ `Gemini`（FunctionTools 対応）
- **cursor**: `@cursor/sdk` の `Agent.prompt` アダプタ（v1 はテキスト完了向け。ADK FunctionTools は未ブリッジ）

新しい provider を足すときは `packages/llm` に `LlmProvider` 実装を追加し、`registry.ts` に登録します。

## 新しいエージェントを追加する

1. `agents/<id>/agent.ts` で `export const rootAgent = ...`（`resolveModel(ModelRef)` を推奨）
2. 同ディレクトリに workspace 用 `package.json` / `tsconfig.json`
3. `packages/harness/src/registry.ts` に manifest を追加
4. ルート `tsconfig.json` の `references` に追加
5. `npm install && npm run build`

並列パターンは `agents/parallel-pipeline` をコピーするのが最短です。独立タスクは `ParallelAgent`、結果の突合は後段の `LlmAgent`（`{outputKey}` を instruction に埋め込み）で行います。

## ハーネス API（将来の Web から呼ぶ入口）

```typescript
import { runAgent } from '@agent-env/harness';
import { rootAgent } from './agents/hello/agent.js';

const result = await runAgent({
  agent: rootAgent,
  message: 'Hello',
});
// result: AgentRunResult（@agent-env/shared の Zod スキーマと一致）
```

## ドキュメント

- ADK TypeScript: https://google.github.io/adk-docs/get-started/typescript/
- 並列エージェント: https://adk.dev/agents/workflow-agents/parallel-agents/
- Cursor SDK: https://cursor.com/docs/sdk/typescript
- リポジトリ向けエージェント指示: [AGENTS.md](./AGENTS.md)
