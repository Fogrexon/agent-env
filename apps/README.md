# apps/

Web 管理ツール置き場。ランタイムは TypeScript 一択（エージェント・ハーネス・UI で `@agent-env/shared` の**型**を共有）。

## レイヤ境界（重要）

| 置く場所 | 置いてよいもの |
|----------|----------------|
| `packages/*` | 汎用ランタイム・Zod スキーマ・loader・進捗イベント（**具体エージェント名なし**） |
| `agents/<id>/` | `agent.ts`（`agentDefinition`。`limits` を内包）+ 任意 `params.yaml`（詳細は [docs/AGENT_PACKAGE.md](../docs/AGENT_PACKAGE.md)） |
| `agents/dev-env` (`@agent-env/repo-env`) | このリポの env 配線 + **agents/*/ ディスカバリ** + `runDiscoveredAgent` |
| `scripts/` | 汎用 CLI のみ（ディスカバリ + argv。**固有 id / params を持たない**） |
| `apps/admin` | **Control Plane**（キュー / スロット / スケジュール / webhook / 認証）+ UI（同上・固有 agent id なし） |

## `@agent-env/admin` — Control Plane

Jenkins 風のローカル管理コンソール。実行本体は常に `runDiscoveredAgent`（agent 自身の `limits` + host execution policy をマージして実行、五 plane）。Control Plane は「いつ・いくつ・誰が起動するか」だけを担う。実行時モデルは agent.ts が解決する — run 単位のモデル上書きはない。

```bash
npm run admin
# → API http://127.0.0.1:8787  / UI http://127.0.0.1:5173
```

### UI ページ

| パス | 内容 |
|------|------|
| `/` | Dashboard（スロット・queue 深さ・失敗率・trigger 別 24h） |
| `/jobs/:id` | ジョブ定義（agents ディスカバリ）+ Build with Parameters |
| `/queue` | pending/running キュー + Build history（filter） |
| `/runs/:runId` | Stages / budget / SSE console / artifacts |
| `/schedules` | cron CRUD |
| `/settings` | maxSlots・認証状態・webhook トークン・audit |

### 環境変数

| 変数 | 既定 | 説明 |
|------|------|------|
| `ADMIN_API_PORT` | `8787` | API ポート |
| `ADMIN_MAX_SLOTS` | `2` | 同時実行スロット数 |
| `ADMIN_BASIC_USER` + `ADMIN_BASIC_PASSWORD` | （未設定） | 両方あるとき Basic Auth（`/api/health` と `/api/hooks/*` 以外） |

永続先: `.runs/control/control.sqlite`（queue / schedules / webhook tokens / audit）。  
起動時に `claimed`/`running` 孤児ジョブを `failed` へ reconcile する。

### エージェント追加

1. `agents/<id>/agent.ts`（`export const agentDefinition`。`limits` を含む）
2. 任意で `agents/<id>/params.yaml`（無ければ既定の単一 `message` フィールド）
3. 完了 — `packages/*` もルート `package.json` も触らない

### API

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/health` | ヘルス + control 要約（認証不要） |
| GET | `/api/control/settings` | maxSlots / auth / dbPath |
| GET | `/api/control/stats` | キュー統計・triggers24h・failureRate |
| GET | `/api/control/audit` | 簡易 audit ログ |
| GET | `/api/agents` | ディスカバリ結果 |
| GET | `/api/providers` | 登録済み provider と対応メディア |
| GET | `/api/agents/:id/params` | AgentParamsSpec + defaults |
| POST | `/api/agents/:id/graph` | フォーム値を適用して ADK グラフを構築 → `describeAgentGraph`（実行なし。Jobs 画面の「Preview graph」ボタンが呼ぶ） |
| POST | `/api/uploads` | multipart アップロード |
| GET | `/api/uploads/preview?path=` | プレビュー配信 |
| POST | `/api/agents/:id/runs` | **enqueue** → 202 `{ jobId, runId, status: pending }` |
| GET | `/api/queue` | pending/claimed/running ジョブ |
| GET | `/api/queue/stats` | 深さ・スロット |
| POST | `/api/queue/:jobId/cancel` | pending は dequeue、running は abort |
| GET/POST/PATCH/DELETE | `/api/schedules` | cron スケジュール |
| GET/POST/PATCH/DELETE | `/api/hooks/tokens` | webhook トークン（作成時のみ rawToken 返却） |
| POST | `/api/hooks/:token` | 外部トリガ enqueue（Basic 対象外） |
| GET | `/api/runs` | メモリ + キュー pending + `.runs` 履歴（`trigger` 付き） |
| GET | `/api/runs/:runId` | スナップショット（stages / budget / `effectiveGraph` / `observedGraph`） |
| GET | `/api/runs/:runId/events?after=N` | SSE（実行開始後） |
| GET | `/api/runs/:runId/files` | 成果物一覧 |
| GET | `/api/runs/:runId/files/*?download=1` | 成果物配信 |
| POST | `/api/runs/:runId/cancel` | キャンセル |
| DELETE | `/api/runs/:runId` | 完了済み削除 |

### 実行フロー

```
UI/webhook/cron → enqueue (SQLite) → WorkerPool (maxSlots)
  → AdminRunStore (SSE) + runDiscoveredAgent → .runs/runs/...
```

### ファイル / 画像

- UI: `file` / `files` / `image` / `images` は **パス手入力 + 参照ダイアログ**（アップロードは `.agent-env/uploads/`）
- 渡し方は params.yaml の `delivery` が決める（管理ツールは決めない）
  - `path`（file 既定）: パス文字列を inputs へ
  - `content`（image 既定）: バイトを LLM ユーザー入力へマルチモーダル添付
- `objectiveField`（既定 `message`）の値が RunRequest の objective になる
- `delivery: content` は provider ごとに対応メディアが違う。Jobs 画面の Providers パネル（`GET /api/providers`）で確認できる
- **テキスト化フォールバック**: `delivery: content` の PDF / Markdown / テキスト系は、provider がその MIME に非対応でもアップロードできる

### 進捗イベント

ハーネスが発行する汎用 `AgentProgressEvent`（`@agent-env/shared`）:

- `run.started` / `agent.event` / `run.state` / `run.completed` / `run.failed`
- `sequence` は run 内単調増加。SSE 再接続時は `after` でリプレイ

ライブ SSE はプロセス内 `AdminRunStore`。永続ジョブの正本は SQLite + 完了後の `.runs/runs/`。

### 成功判定

`RunRecord.state` の `COMPLETED` が正常終了（`isSuccessfulRunState`、`@agent-env/shared`）。
