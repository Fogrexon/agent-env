/**
 * agent-env — Google ADK (TypeScript) による並列・自律エージェントのテンプレート / ハーネス
 *
 * ## 目的
 * - エージェント定義・オーケストレーション・スクリプト連携の再利用可能な土台を置く
 * - 将来の Web 管理ツールと型（Zod）を共有できるようにする
 *
 * ## 技術選定
 * - オーケストレーション: `@google/adk`（Sequential / Parallel / Loop + tools）
 * - 言語: TypeScript（型安全 + 将来の管理 UI と同一スタック）
 * - Cursor SDK は使わない（エージェント呼び出し用の低レベル API であり、本リポの関心外）
 *
 * ## レイアウト
 * - `agents/` … 各エージェント（`export const rootAgent` 必須）
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
 * `.env` に `GEMINI_API_KEY`（`.env.example` 参照）
 */
