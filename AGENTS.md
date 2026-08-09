/**
 * agent-env — 実行環境（Google ADK TypeScript ハーネス + admin）
 *
 * ## レイヤ境界（厳守 — .cursor/rules/layer-boundaries.mdc）
 * - 実行の主体は常にホスト（`runDiscoveredAgent` → `executeAgentRun`）。agent.ts は定義モジュール
 * - `mode: 'interactive' | 'autonomous'` … Chat 向け対話 / Jobs・schedule 向けワンショット（省略時 autonomous）
 * - `agents/<pack>/<id>/` … ワークフロー定義（必須: agentDefinition。任意: params.yaml）
 *   - `agents/builtin/` … 薄いホスト同梱サンプル
 *   - `agents/showcase/` … 薄い公開デモ（character-chat / web-qa）
 *   - `agents/meta/` … メタツール（agent-author）
 *   - `agents/personal/` … ホスト所有者の自動化（別 git を clone。このリポでは gitignore）
 * - `agents/dev-env` … env 配線・host 実行ポリス + pack discovery
 * - `packages/*` … 汎用のみ（エージェント名の列挙・env 読みなし）
 * - `scripts/` / `apps/admin` … 汎用エントリのみ（固有 id の default や分岐なし）
 *
 * ## 実行
 * - `npm run run -- <agent-id> "..."`（discovery → `runDiscoveredAgent` → `executeAgentRun`）
 * - `npm run run -- <agent-id> --params ./values.json`
 * - `npm run admin`
 * - 定義追加: `agents/<pack>/<id>/agent.ts` を置く
 *
 * ## 契約の要点
 * - モデルは `agentDefinition` 内で `provider:model` 文字列（例 `cursor:auto` / `gemini:gemini-3.1-pro`）を ADK LLMRegistry に渡すだけ。run 単位のモデル上書きはない
 * - 実行制限は `agentDefinition.limits`。host 側 execution-policy とマージ（agent 値が min）
 * - 終了状態: 正常終了は `COMPLETED`、失敗は `FAILED` / `BUDGET_EXHAUSTED` 等（`isSuccessfulRunState` は `COMPLETED` のみ）
 *
 * ## 実装者向け仕様
 * - docs/AGENT_PACKAGE.md … パッケージ規約・params / limits / CLI
 * - docs/ARCHITECTURE.md … 五 plane・ハーネス全体
 * - agents/README.md … pack 規約（showcase/meta in-tree / personal は別リポ）
 * - 廃止した機能の互換レイヤは残さない（.cursor/rules/no-compat-leftovers.mdc）
 * - Python 局所 env は uv 必須（.cursor/rules/python-uv.mdc）
 * - UI / グラフ等はライブラリ優先（.cursor/rules/prefer-libraries.mdc）— 例: admin のエージェントグラフは @xyflow/react + dagre
 * - Knowledge / RAG: packages/harness/src/knowledge/（docs/AGENT_PACKAGE.md）
 */
