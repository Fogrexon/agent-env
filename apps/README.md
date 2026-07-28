# apps/

Web 管理ツール置き場。ランタイムは TypeScript 一択（エージェント・ハーネス・UI で `@agent-env/shared` の**型**を共有）。

## レイヤ境界（重要）

| 置く場所 | 置いてよいもの |
|----------|----------------|
| `packages/*` | 汎用ランタイム・Zod スキーマ・loader・進捗イベント（**具体エージェント名なし**） |
| `agents/<id>/` | `agent.ts`（`agentDefinition`）+ `params.yaml` + `runspec.json` + `evaluation.json`（詳細は [docs/AGENT_PACKAGE.md](../docs/AGENT_PACKAGE.md)） |
| `agents/dev-env` (`@agent-env/repo-env`) | このリポの env 配線 + **agents/*/ ディスカバリ** + `runDiscoveredAgent` |
| `scripts/` | 汎用 CLI のみ（ディスカバリ + argv。**固有 id / params を持たない**） |
| `apps/admin` | 汎用 UI/API（同上） |

## `@agent-env/admin`

```bash
npm run admin
# → API http://127.0.0.1:8787  / UI http://127.0.0.1:5173
```

UI は `POST /runs` → `EventSource(/events)` で進捗をライブ表示します。

### エージェント追加

1. `agents/<id>/agent.ts`（`export const agentDefinition`）
2. `agents/<id>/params.yaml`
3. `agents/<id>/runspec.json` + `evaluation.json`
4. 完了 — `packages/*` もルート `package.json` も触らない

### API

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/agents` | ディスカバリ結果 |
| GET | `/api/providers` | 登録済み provider と対応メディア（MIME / カテゴリ / 上限） |
| GET | `/api/agents/:id/params` | AgentParamsSpec + defaults |
| POST | `/api/uploads` | multipart アップロード → repo 相対パス |
| GET | `/api/uploads/preview?path=` | プレビュー用ファイル配信 |
| POST | `/api/agents/:id/runs` | `{ values }` で非同期開始 → `{ runId }`（常に RunSpec 経路） |
| GET | `/api/runs/:runId` | 状態・イベント・最終結果 |
| GET | `/api/runs/:runId/events?after=N` | SSE（progress / terminal / heartbeat） |
| GET | `/api/runs/:runId/files` | 履歴ディレクトリ配下の成果物一覧 |
| GET | `/api/runs/:runId/files/*?download=1` | 成果物配信（path jail。`download=1` で attachment） |
| POST | `/api/runs/:runId/cancel` | AbortController でキャンセル |

### ファイル / 画像

- UI: `file` / `files` / `image` / `images` は **パス手入力 + 参照ダイアログ**（アップロードは `.agent-env/uploads/`）
- 渡し方は params.yaml の `delivery` が決める（管理ツールは決めない）
  - `path`（file 既定）: パス文字列を inputs へ
  - `content`（image 既定）: バイトを LLM ユーザー入力へマルチモーダル添付
- `objectiveField`（既定 `message`）の値が RunRequest の objective になる
- `delivery: content` は provider ごとに対応メディアが違う。サイドバーの「対応メディア」パネル（`GET /api/providers`）で確認できる
  - gemini: 画像 / 音声 / 動画 / PDF / テキスト
  - openai: 画像 / 音声（wav・mp3、audio 対応モデル）/ PDF
  - anthropic: 画像 / PDF
  - cursor: 画像のみ
  - openai-compatible: 既定は画像のみ（ファクトリの `media` で明示可）
- **テキスト化フォールバック**: `delivery: content` の PDF / Markdown / テキスト系は、provider がその MIME に非対応でもアップロードできる。実行時に自動でテキスト抽出してユーザー turn に差し込む（PDF は `unpdf`、それ以外は UTF-8 読み）。Cursor など画像のみの provider でも PDF / テキストを利用可能
  - 抽出したファイルは添付イベントの `transcripts`（chars / truncated / pages）として progress に記録される
  - 1 ファイル 120,000 文字・合計 400,000 文字を超えると切り詰め
- 抽出できない非対応メディア（画像 / 音声 / 動画）やサイズ超過は `UnsupportedMediaError` で実行が失敗する（無視して送信しない）

### 進捗イベント

ハーネスが発行する汎用 `AgentProgressEvent`（`@agent-env/shared`）:

- `run.started` / `agent.event` / `run.state` / `verification` / `run.completed` / `run.failed`
- `sequence` は run 内単調増加。SSE 再接続時は `after` でリプレイ

保持は **単一プロセスのメモリ**（上限件数 + TTL）。API 再起動後の履歴はディスク（`.runs/`）からマージされます。
