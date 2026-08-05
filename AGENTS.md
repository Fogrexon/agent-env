/**
 * agent-env — Google ADK (TypeScript) による並列・自律エージェントのテンプレート / ハーネス
 *
 * ## レイヤ境界（厳守 — .cursor/rules/layer-boundaries.mdc）
 * - `agents/<id>/` … 固有設定の唯一の置き場（agent.ts + params.yaml + runspec.json + evaluation.json）
 * - `agents/dev-env` … このリポの env 配線 + agents/*/ ディスカバリ
 * - `packages/*` … 汎用のみ（エージェント名の列挙・env 読みなし）
 * - `scripts/` / `apps/admin` … 汎用エントリのみ（固有 id の default や分岐なし）
 *
 * ## 実行
 * - `npm run run -- <agent-id> "..."`（discovery → RunSpec + EvaluationSpec）
 * - `npm run run -- <agent-id> --params ./values.json`
 * - `npm run admin`
 * - 追加: agents/<id>/ に 4 必須ファイルを置くだけ
 *
 * ## 実装者向け仕様
 * - docs/AGENT_PACKAGE.md … パッケージ規約・params / RunSpec / EvaluationSpec / CLI
 * - docs/ARCHITECTURE.md … 五 plane・ハーネス全体
 */

## Cursor Cloud specific instructions

- Node は **24 系必須**（`package.json` engines: node >=24.13 / npm >=11.8）。VM には `/exec-daemon/node`（v22）が PATH 上位に存在し nvm を隠すため、`~/.bashrc` で nvm の node 24 を PATH 先頭に差し込み済み。ログインシェル（`bash -l`）なら `node -v` は v24 になる。非ログインシェルで v22 に落ちる場合は `export PATH="$HOME/.nvm/versions/node/v24.18.0/bin:$PATH"` を先に実行する。
- 標準コマンドは `package.json` の scripts 参照（`npm run build` / `typecheck` / `adk:web` / `run`）。README にも記載あり。
- エージェントを実際に動かすには Gemini API が必要。`GEMINI_API_KEY`（または `GOOGLE_API_KEY`）を Secrets に設定すること。未設定だと `runAgent` が `assertApiKey` で throw する（ビルド・型チェック・CLI ロード・`adk:web` の起動自体はキー無しでも成功する）。
- `npm run adk:web` は ADK 開発 UI を **http://localhost:8000** で起動する（`/dev-ui/` にリダイレクト、`agents/` 配下を自動発見）。
- `npm install` 時に esbuild / sqlite3 / protobufjs 等の install script が npm の allow-scripts で警告されるが、プリビルドバイナリが入るため実行時ロードは正常。`npm approve-scripts` は不要。
