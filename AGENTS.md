/**
 * agent-env — Google ADK (TypeScript) による並列・自律エージェントのテンプレート / ハーネス
 *
 * ## 目的
 * - エージェント定義・オーケストレーション・スクリプト連携の再利用可能な土台を置く
 * - LLM ベンダーはアダプタ経由で差し替え・併用可能にする（タスク単位のモデル割当を含む）
 * - 将来の Web 管理ツールと型（Zod）を共有できるようにする
 *
 * ## 技術選定
 * - オーケストレーション: `@google/adk`（Sequential / Parallel / Loop + tools）
 * - LLM 実行: `@agent-env/llm`（LlmProvider ポート + Gemini / Cursor アダプタ）
 * - 言語: TypeScript（型安全 + 将来の管理 UI と同一スタック）
 * - Cursor SDK はオーケストレーション基盤ではなく、LLM provider アダプタの一実装として使う
 *
 * ## レイアウト
 * - `agents/` … 各エージェント（`export const rootAgent` 必須）
 * - `packages/llm` … `resolveModel` / provider アダプタ
 * - `packages/harness` … `runAgent` / レジストリ / 型付きツール
 * - `packages/shared` … 共有 Zod スキーマ（Web/API 向け）
 * - `apps/` … 将来の管理 UI
 *
 * ## エージェント追加手順
 * 1. `agents/<id>/` に `agent.ts` + `package.json` + `tsconfig.json`
 * 2. `packages/harness/src/registry.ts` に manifest 追加
 * 3. ルート `tsconfig.json` の references に追加
 * 4. `npm install && npm run build`
 *
 * ## 実行
 * - 開発 UI: `npm run adk:web`
 * - ハーネス経由: `npm run run -- hello "現在時刻は？"`
 *
 * ## 認証
 * `.env` に `GEMINI_API_KEY` および/または `CURSOR_API_KEY`（`.env.example` 参照）
 */
