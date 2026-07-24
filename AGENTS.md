/**
 * agent-env — Google ADK (TypeScript) による並列・自律エージェントのテンプレート / ハーネス
 *
 * ## 目的
 * - エージェント定義・オーケストレーション・スクリプト連携の再利用可能な土台を置く
 * - RunSpec / event / budget / independent verifier（研究レポート Phase A）
 * - 複数データソース connector → 並列収集 → 合成（collector オーケストレーション）
 * - LLM ベンダーはアダプタ経由で差し替え・併用可能（OpenAI 互換は複数 id で共存）
 * - API キー等の秘密情報の取得方法は利用側の責務（ライブラリは注入された値だけ使う）
 * - 将来の Web 管理ツールと型（Zod）を共有できるようにする
 *
 * ## 技術選定
 * - オーケストレーション: `@google/adk` + Phase A control plane（runFromSpec）
 * - LLM 実行: `@agent-env/llm`（registerProvider / create*Provider / resolveModel）
 * - Cursor SDK はオーケストレーション基盤ではなく provider 実装の一つ
 *
 * ## レイアウト
 * - `agents/` … `export const rootAgent`
 * - `packages/llm` … provider ファクトリ・registry
 * - `packages/harness` … runAgent / runFromSpec / guarded tools
 * - `packages/shared` … Zod（ModelRef・RunSpec・Event）
 * - `docs/` … ARCHITECTURE + 研究レポート
 *
 * ## 実行
 * - `npm run adk:web` / `npm run run -- hello "..."`
 * - RunSpec: `npm run run:spec -- agents/runspec-demo/runspec.demo.json`
 * - Collector: `npm run run:collector`
 * - アーキテクチャ: `docs/ARCHITECTURE.md`
 * - 研究根拠: `docs/research/2026-07-23-llm-agent-execution-harness.md`
 *
 * ## 認証
 * 利用側が register 時に渡す。サンプルは `bootstrapProvidersFromEnv()`（`.env.example` 参照）
 */
