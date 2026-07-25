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
 * - `npm run admin`
 * - 追加: agents/<id>/ に agent.ts / params.yaml / runspec.json / evaluation.json を置くだけ
 */
