# apps/

将来の Web 管理ツール（ラン実行・セッション閲覧・エージェント一覧）を置く場所。

## 方針

- ランタイムは TypeScript 一択（エージェント定義・ハーネス・管理 UI を同じ型で繋ぐ）
- エージェント実行の入口は `@agent-env/harness` の `runAgent` / `agentRegistry`
- 共有型・Zod スキーマは `@agent-env/shared`（API レスポンスと UI で再利用）
- ADK 公式の `adk web` は開発デバッグ用。本番の管理 UI はここに別アプリとして追加する

## 想定構成（未作成）

```
apps/admin/          # 例: Next.js / Hono + React
  src/
    server/          # runAgent を呼ぶ API
    ui/              # セッション / イベント表示
```

ワークスペースに載せるときは `package.json` の `workspaces` に `apps/*` を追加する。
