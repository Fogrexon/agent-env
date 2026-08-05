/**
 * agent-env — Google ADK (TypeScript) による並列・自律エージェントのテンプレート / ハーネス
 *
 * ## レイヤ境界（厳守 — .cursor/rules/layer-boundaries.mdc）
 * - `agents/<id>/` … 固有設定の唯一の置き場（必須: `agent.ts` が `agentDefinition` を export。任意: `params.yaml`）
 * - `agents/dev-env` … このリポの env 配線・host 実行ポリス（execution-policy.ts）+ agents/*/ ディスカバリ
 * - `packages/*` … 汎用のみ（エージェント名の列挙・env 読みなし）
 * - `scripts/` / `apps/admin` … 汎用エントリのみ（固有 id の default や分岐なし）
 *
 * ## 実行
 * - `npm run run -- <agent-id> "..."`（discovery → `runDiscoveredAgent` → `executeAgentRun`）
 * - `npm run run -- <agent-id> --params ./values.json`
 * - `npm run admin`
 * - 追加: `agents/<id>/agent.ts` を置くだけ（`params.yaml` は任意）
 *
 * ## 契約の要点
 * - モデルは `agentDefinition` 内で `provider:model` 文字列（例 `cursor:auto` / `gemini:gemini-3.1-pro`）を ADK LLMRegistry に渡すだけ。run 単位のモデル上書きはない
 * - 実行制限は `agentDefinition.limits`、成功判定は `agentDefinition.verification`（`verify.*` factories）。host 側 execution-policy とマージ（agent 値が min）
 * - 終了状態は `COMPLETED`（検証チェックなし/advisory のみ = 成功扱い）/ `SUCCEEDED`（required 検証が合格）/ `FAILED`
 *
 * ## 実装者向け仕様
 * - docs/AGENT_PACKAGE.md … パッケージ規約・params / limits / verification / CLI
 * - docs/ARCHITECTURE.md … 五 plane・ハーネス全体
 * - Python 局所 env は uv 必須（.cursor/rules/python-uv.mdc）
 * - UI / グラフ等はライブラリ優先（.cursor/rules/prefer-libraries.mdc）— 例: admin のエージェントグラフは @xyflow/react + dagre
 * - Knowledge / RAG: packages/harness/src/knowledge/（docs/AGENT_PACKAGE.md）
 */
