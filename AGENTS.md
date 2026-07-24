/**
 * agent-env — Google ADK (TypeScript) による並列・自律エージェントのテンプレート / ハーネス
 *
 * ## 目的
 * - エージェント定義・オーケストレーション・スクリプト連携の再利用可能な土台を置く
 * - LLM ベンダーはアダプタ経由で差し替え・併用可能（OpenAI 互換は複数 id で共存）
 * - API キー等の秘密情報の取得方法は利用側の責務（ライブラリは注入された値だけ使う）
 * - 将来の Web 管理ツールと型（Zod）を共有できるようにする
 *
 * ## 技術選定
 * - オーケストレーション: `@google/adk`
 * - LLM 実行: `@agent-env/llm`（registerProvider / create*Provider / resolveModel）
 * - Cursor SDK はオーケストレーション基盤ではなく provider 実装の一つ
 *
 * ## レイアウト
 * - `agents/` … `export const rootAgent`
 * - `packages/llm` … provider ファクトリ・registry
 * - `packages/harness` … runAgent・任意の env bootstrap
 * - `packages/shared` … Zod スキーマ
 *
 * ## 実行
 * - `npm run adk:web` / `npm run run -- hello "..."`
 *
 * ## 認証
 * 利用側が register 時に渡す。サンプルは `bootstrapProvidersFromEnv()`（`.env.example` 参照）
 */
