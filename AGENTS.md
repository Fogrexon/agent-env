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

## Cursor Cloud specific instructions

- Node は **24 系必須**（`package.json` engines: node >=24.13 / npm >=11.8）。VM には `/exec-daemon/node`（v22）が PATH 上位に存在し nvm を隠すため、`~/.bashrc` で nvm の node 24 を PATH 先頭に差し込み済み。ログインシェル（`bash -l`）なら `node -v` は v24 になる。非ログインシェルで v22 に落ちる場合は `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` を先に実行する。
- 標準コマンドは `package.json` の scripts 参照（`npm run build` / `typecheck` / `adk:web` / `run`）。README にも記載あり。
- エージェントを実際に動かすには Gemini API が必要。`GEMINI_API_KEY`（または `GOOGLE_API_KEY`）を Secrets に設定すること。未設定だと `runAgent` が `assertApiKey` で throw する（ビルド・型チェック・CLI ロード・`adk:web` の起動自体はキー無しでも成功する）。
- `npm run adk:web` は ADK 開発 UI を **http://localhost:8000** で起動する（`/dev-ui/` にリダイレクト、`agents/` 配下を自動発見）。
- `npm install` 時に esbuild / sqlite3 / protobufjs 等の install script が npm の allow-scripts で警告されるが、プリビルドバイナリが入るため実行時ロードは正常。`npm approve-scripts` は不要。
