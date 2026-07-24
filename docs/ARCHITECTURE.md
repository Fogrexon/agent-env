# agent-env アーキテクチャ（研究レポート対応）

参照研究: [docs/research/2026-07-23-llm-agent-execution-harness.md](./research/2026-07-23-llm-agent-execution-harness.md)

本リポジトリは「巨大 multi-agent framework」ではなく、研究が推奨する **五つの plane** を薄い TypeScript 契約として段階導入する。

## 五 plane とパッケージ対応

| Plane | 研究上の責務 | 本リポの置き場（現状） |
|-------|--------------|------------------------|
| Specification | version 付き RunSpec | `@agent-env/shared` の `runSpecSchema` / サンプル JSON |
| Control | state machine、budget、orchestrator | `packages/harness/src/runtime/`（`runFromSpec`） |
| Execution | model / typed tool gateway | `@agent-env/llm` + `createGuardedTool` + ADK tools |
| State & evidence | append-only events、artifact | `InMemoryEventStore`（Phase A・メモリ） |
| Evaluation | 独立 verifier | `verifyRunSpec`（agent 発言を成功としない） |

オーケストレーションの workflow DSL は Google ADK（Sequential / Parallel / Loop）を継続利用する。Cursor SDK 等は LLM provider アダプタであり、control plane ではない。

## Phase ロードマップ（研究 §9 の圧縮）

### Phase A（実装済み骨格）— 測れる一実行

- [x] RunSpec / RunRecord（Zod）
- [x] Run state machine（遷移検証）
- [x] Append-only event log（in-memory）
- [x] Hard budget（tool / wall / tokens / cost）
- [x] Tool risk T0–T3 + fail-closed T2/T3（`createGuardedTool`）
- [x] Independent verifier（`contains` / `custom`）
- [x] サンプル: `agents/runspec-demo` + `npm run run:spec`

### データソース収集オーケストレーション（優先プロダクト方向）

スケジューラ（KV / 高並列 serving）は本リポの主眼にしない。代わりに **複数データソースへ接続して情報をかき集め、1 つの成果物に合成する** 経路を厚くする。

- [x] Connector 契約（`DataSourceConnector` + risk-aware tool）
- [x] Connector registry / demo fixtures（KB / CRM / status）
- [x] `agents/collector`: Parallel fan-out → synthesizer
- [x] 収集用 RunSpec: `agents/collector/runspec.collect.json`

```bash
npm run smoke:connectors
npm run run:collector   # GEMINI_API_KEY 等
```

実コネクタを足すときは `createMemoryConnector` と同型のファクトリで秘密情報を閉包し、`registerConnector` する（取得方法は利用側の責務）。

未実装（意図的に後回し）:

- 実 Docker/microVM sandbox
- durable event store / exactly-once
- Crab/DeltaBox 級 checkpoint
- workflow-aware KV scheduler（不要寄り・本プロダクトでは非優先）
- NLAH 自然言語 harness policy 実行器

## 最重要の設計判断（研究 §12.2）

1. 管理単位は model request ではなく **run**
2. agent policy と execution mechanism を分離
3. conversation と environment state を混同しない
4. tool は function list ではなく **authority boundary**
5. 成功は agent の完了文ではなく **postcondition（verifier）**
6. model × harness × environment × grader を独立 version
7. multi-agent / memory / tree search は計測後

## 使い方

```bash
# オフライン契約テスト
npm run smoke:runtime

# RunSpec 付き実行（GEMINI_API_KEY 等）
npm run run:spec -- agents/runspec-demo/runspec.demo.json
```

```ts
import { runFromSpec, createGuardedTool } from '@agent-env/harness';

const result = await runFromSpec({
  spec: myRunSpecJson,
  agent: rootAgent,
});
// result.record.state === 'SUCCEEDED' | 'FAILED' | …
// result.events → append-only evidence
```

## 作らないもの（研究 §1.4）

自由 spawn する swarm、全 tool/secret 共有、self-declared completion のみの成功判定、無制限 shell、conversation だけの「checkpoint」、公開 benchmark 単一最適化、LLM-as-judge 単独の release gate。
