# agent-env

並列・自律エージェント用の **TypeScript テンプレート / ハーネス**。オーケストレーションは [Google ADK](https://google.github.io/adk-docs/)（`@google/adk`）、LLM 呼び出しは **provider アダプタ**（`@agent-env/llm`）経由で差し替え・併用できます。

## 構成

```
agents/                  # ADK エージェント（各フォルダが rootAgent を export）
packages/
  shared/                # Zod スキーマ・共有型
  llm/                   # LlmProvider ポート・ファクトリ・registry・resolveModel
  harness/               # runAgent・（任意）env からの bootstrap
apps/                    # 将来の管理 UI
scripts/run.ts           # CLI
```

## セットアップ

```bash
cp .env.example .env
# 利用する provider に必要な値を設定（またはコードから registerProviders）
npm install
npm run build
```

Node.js **≥ 24.13** / npm **≥ 11.8** を想定しています。

## Provider の考え方

- **ライブラリ**は「どう秘密情報を取るか」を決めない
- **利用側**が `create*Provider` / `registerProviders` で API キーや Base URL を渡す
- OpenAI 互換サーバは **id を分けて複数登録**できる（LM Studio / Ollama / vLLM …）

```typescript
import {
  registerProviders,
  createOpenaiCompatibleProvider,
  registerProvider,
  resolveModel,
} from '@agent-env/llm';

registerProviders({
  gemini: { apiKey: () => process.env.GEMINI_API_KEY },
  openai: { apiKey: process.env.OPENAI_API_KEY! },
  anthropic: { apiKey: () => process.env.ANTHROPIC_API_KEY },
  cursor: { apiKey: () => process.env.CURSOR_API_KEY },
  openaiCompatible: [
    {
      id: 'lm-studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: () => process.env.LM_STUDIO_API_KEY, // 任意
    },
    { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  ],
});

// 追加の互換エンドポイントを後から足すことも可
registerProvider(
  createOpenaiCompatibleProvider({
    id: 'vllm-prod',
    baseUrl: 'https://vllm.example.com/v1',
    apiKey: () => mySecretStore.get('vllm'),
  }),
);

resolveModel({ provider: 'lm-studio', model: 'local-model' });
resolveModel({ provider: 'ollama', model: 'llama3.2' });
```

ハーネスの `bootstrapProvidersFromEnv()` は **env を読む一例**です（`runAgent` / サンプルエージェントが利用）。Vault 等にしたい場合は自前で `registerProviders` してください。

複数の OpenAI 互換を env で渡す例:

```bash
OPENAI_COMPATIBLE_PROVIDERS=[{"id":"lm-studio","baseUrl":"http://127.0.0.1:1234/v1","apiKeyEnv":"LM_STUDIO_API_KEY"},{"id":"ollama","baseUrl":"http://127.0.0.1:11434/v1"}]
```

## 実行

```bash
npm run adk:web
npm run run -- hello "ホストの現在時刻を教えて"
npm run run -- parallel-pipeline "リモートワークを評価して"
npm run smoke:llm
```

## モデル指定（ModelRef）

```typescript
model: resolveModel({ provider: 'gemini', model: 'gemini-2.5-flash' })
model: resolveModel({ provider: 'lm-studio', model: 'local-model' })
```

| kind / 典型 id | 用途 |
|----------------|------|
| `gemini` | Google Gemini（ADK ネイティブ / FunctionTools） |
| `cursor` | Cursor SDK |
| `openai` | OpenAI 公式 |
| `anthropic` | Anthropic |
| 任意 id (`lm-studio` 等) | OpenAI 互換（`kind: "openai-compatible"`） |

## 新しいエージェント

1. `agents/<id>/agent.ts` で provider を register してから `resolveModel`
2. workspace `package.json` / `tsconfig.json`
3. `packages/harness/src/registry.ts` に manifest
4. ルート `tsconfig.json` の references
5. `npm install && npm run build`

## ドキュメント

- ADK TypeScript: https://google.github.io/adk-docs/get-started/typescript/
- Cursor SDK: https://cursor.com/docs/sdk/typescript
- [AGENTS.md](./AGENTS.md)
