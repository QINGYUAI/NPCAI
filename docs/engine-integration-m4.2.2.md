# M4.2.2 · 记忆向量化（Memory Embedding, M-1 → M-2）细设

> 本文是 [`m4.2-roadmap.md`](./m4.2-roadmap.md) §3.1 / §4.2 / §5.1-5.3 的展开实施方案，与 [`engine-integration-m4.2.1.md`](./engine-integration-m4.2.1.md) 同级。目的是把 Stanford Generative Agents 的「Observation → Retrieval → Plan」链路在 `AINPC` 里最小闭环落地。
>
> **范围限定**：只做“长期记忆向量化 + top-K 检索注入”。**反思循环（M4.2.3）、事件总线（M4.2.4）、人工记忆编辑 UI 的高级筛选** 不在本节点内。

## 0. 版本历史

| 版本 | 日期 | 作者 | 说明 |
| --- | --- | --- | --- |
| 0.1 | 2026-04-21 | AINPC-Dev | 初稿，拉票关键设计点：嵌入时机 / 检索 query 构造 / memory content 粒度 / 前端 Drawer 是否随版发布 / 保留策略 |
| 0.2 | 2026-04-21 | AINPC-Dev | **评审结论录入**：业主选择全默认方案 `Q1 a, Q2 a, Q3 a, Q4 a, Q5 a`。即：retrieve query = `prevSummary + 同场 NPC 名`；store 触发 = say/action 各一条；写入 = 同步双写；Embed cache = 磁盘文件 + 内存 LRU；前端 = 顶栏 🧠 薄徽章（不做 Drawer）。可进入实施。 |

---

## 1. 目标与非目标

### 1.1 要做（in-scope）

1. **数据层**：新增 `npc_memory` MySQL 表（元数据 + 原文），Qdrant 侧 `npc_memory` collection（1536 维 Cosine）。
2. **双写契约**：MySQL 为真实来源，Qdrant 为派生索引。写入 `pending → embedded`；失败标记 `failed` 等 cron 异步重嵌。
3. **引擎节点**：`plan` 前插 `memory-retrieve` 注入 top-K 相关记忆；`speak` 后插 `memory-store` 把 `latest_say+latest_action` 入库。
4. **提示词**：`plan` / `speak` prompt 新增 `【相关记忆】` 段，直接拼接 retrieve 结果。
5. **LLM 层**：`embedText` 扩展——模型名、维度来自 env；带 30 天磁盘缓存（SHA-1(content+model) 作 key）；失败有可重试标记。
6. **REST API**：`GET/POST/DELETE /api/npc/:id/memories(+/:mid)`，供后台管理 / 沙盒 Drawer 使用。
7. **降级**：Qdrant 健康检查失败 → `memory-retrieve` 回退 MySQL `importance DESC, created_at DESC`；`memory-store` 仍写 MySQL 并标记 `pending`，cron 重试。
8. **观测**：沙盒顶栏加 `⚡M` / `⚠M` 小徽章（引擎 status 返回 `memory_degraded=true` 时亮），并把 M4.2.1 的 `Σ cost·tokens` 自然复用（embed 调用也计入 `ai_call_log`）。
9. **初始化脚本**：`npm run qdrant:init` 幂等创建 collection + payload index；首次启用时跑一遍。
10. **向下兼容**：`simulation_meta.memory_summary` **保留**，memory 节点继续维护它作为“短期口袋摘要”；新记忆系统并行工作（双写）。

### 1.2 不做（out-of-scope，保留需求）

| 保留项 | 说明 | 预期节点 |
| --- | --- | --- |
| 反思循环 reflect 节点 | 每 N tick 压缩高层抽象 | M4.2.3 |
| 事件 event-intake 节点 | 外部事件流注入 | M4.2.4 |
| 重要度 LLM 打分 | M4.2.2 先用规则：`latest_say` 含问句 / 点名 → importance=7，否则 5 | M4.2.3 复用 reflect LLM 顺带打分 |
| 记忆遗忘 / 归档策略 | `MEMORY_RETENTION_DAYS` env 先只读不执行；后台 cron 暂不实装 | M4.2.5（待规划） |
| 记忆编辑 Drawer 的全文检索 / 类型过滤 | 首版仅“最新 50 条 + 手动追加 + 删除” | M4.2.5+ |
| 跨 NPC 记忆共享（group memory） | Qdrant filter 已预留 `scene_id`，但引擎不使用 | 未排期 |
| 自适应维度（切换 `text-embedding-3-large`=3072 维） | 本期锁 1536；换模型须重建 collection | 未排期 |

---

## 2. 总架构

```
┌─────────────────────── 引擎 tick（每 NPC） ──────────────────────┐
│                                                                  │
│   ┌─────────┐   query      ┌───────────┐                         │
│   │ buildRetrieve│◀──prevSummary / latestSay──┐                  │
│   │  (node)  │ ───embed──▶│ llmClient.embedText(+cache) │        │
│   └────┬────┘                 └────────┬────────┘                 │
│        │ vector                         │                         │
│        ▼                                │                         │
│   ┌─────────┐  search(filter:npc_id) ┌──▼──────┐                 │
│   │ Qdrant  │ ────────────────────▶ │ top-K ids │                │
│   └────┬────┘                       └─────┬─────┘                │
│        │Qdrant 不可达                     │                      │
│        ▼降级                              ▼                      │
│   MySQL importance DESC ───────────── SELECT content FROM npc_memory WHERE id IN(...)
│        │                                   │                      │
│        ▼                                   ▼                      │
│  【相关记忆】 段 ──▶ plan prompt ──▶ speak prompt ──▶ memory-store │
│                                                         │          │
│                                                         ▼          │
│                                   INSERT npc_memory(pending)      │
│                                                         │          │
│                                                         ▼          │
│                                   embedText + qdrant.upsert       │
│                                   成功→embedded / 失败→failed      │
└──────────────────────────────────────────────────────────────────┘
```

**关键术语**

| 术语 | 含义 |
| --- | --- |
| point_id | Qdrant 向量 id，与 `npc_memory.id` 严格相等 |
| memory | 一条原子观察/对话条目（`content` ≤ 1000 字） |
| retrieve | 读操作：query embedding → Qdrant search → MySQL 反查 content |
| store | 写操作：MySQL INSERT → Qdrant upsert（异步 or 同步由 §5 决定） |
| embed_status | `pending/embedded/failed`，cron 重嵌扫描字段 |

---

## 3. 数据模型

### 3.1 MySQL —— 已在 roadmap §3.1 定稿，此处只补索引与迁移

```sql
CREATE TABLE IF NOT EXISTS npc_memory (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  npc_id BIGINT NOT NULL,
  scene_id BIGINT DEFAULT NULL,
  tick BIGINT DEFAULT NULL,
  type VARCHAR(16) NOT NULL,            -- observation / dialogue / reflection / event / manual
  content TEXT NOT NULL,
  importance TINYINT DEFAULT 5,         -- 1~10
  embed_status VARCHAR(16) DEFAULT 'pending',
  embed_model VARCHAR(64) DEFAULT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_accessed_at DATETIME(3) DEFAULT NULL,
  access_count INT DEFAULT 0,
  INDEX idx_npc_time (npc_id, created_at),
  INDEX idx_npc_importance (npc_id, importance DESC),
  INDEX idx_embed_status (embed_status),
  CONSTRAINT fk_mem_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**迁移脚本**：新增 `backend/src/db/migrate-m422.ts`（仿 `migrate-m42.ts` 风格），CREATE IF NOT EXISTS 幂等、可重复执行，挂到 `npm run db:migrate:m422`。

### 3.2 Qdrant collection

启动时由 `npm run qdrant:init`（或后端首次请求 retrieve 时懒加载）保证存在：

```jsonc
{
  "collection": "npc_memory",
  "vectors":    { "size": 1536, "distance": "Cosine" },
  "payload_indices": [
    { "field_name": "npc_id",     "field_schema": "integer" },
    { "field_name": "scene_id",   "field_schema": "integer" },
    { "field_name": "type",       "field_schema": "keyword" },
    { "field_name": "importance", "field_schema": "integer" }
  ]
}
```

Payload 字段严格：`{ npc_id, scene_id?, type, importance, tick?, created_at }`（unix ms），**不冗余 content**。

---

## 4. 引擎节点

### 4.1 新节点 `memory-retrieve`（plan 前置）

- **输入**：`npc`, `prevMeta`, `scene`, `tick`
- **query 文本构造**（拉票 Q1）：
  - **Q1-a（推荐）**：`prevSummary + '\n' + (neighbors.map(n=>n.name).join('、'))`——零额外 LLM 调用、延迟低
  - **Q1-b**：先跑一个超短 `queryGen` LLM（30 tokens 以内）把“当前意图”抽成一句话——检索更准但多一次 LLM
  - **Q1-c**：只用 `prevSummary`——最简，但冷启动（summary 空）时退化为全局排序
- **检索**：`qdrant.search({ collection, vector, filter: { must: [{ key:'npc_id', match:{ value: npc.id } }] }, limit: MEMORY_TOP_K })`
- **反查 content**：`SELECT id, content, importance, type, created_at FROM npc_memory WHERE id IN (...)` 保持 Qdrant 相似度顺序
- **注入**：在 `plan` prompt 的 user 段追加：

```
【相关记忆（近似度由高到低）】
1. [observation·2t前] 今早在湖边看到了陌生的商人…
2. [dialogue·5t前] 我答应了她明天回来…
...
```

- **失败策略**：任何环节异常 → 写 `debug.memory_retrieve_degraded=true` → 走 MySQL `importance DESC, created_at DESC LIMIT K`；`plan` 照常执行不抛。

### 4.2 新节点 `memory-store`（speak 之后，memory 之前）

- **触发粒度**（拉票 Q2）：
  - **Q2-a（推荐）**：speak 成功且 `latest_say` 非空 → 一条 `type='dialogue'`；`latest_action` 与 `latest_say` 不同时 → 追加一条 `type='observation'`；两条都有则本 tick 写 2 条
  - **Q2-b**：每 tick 固定写 1 条合并文本 `"[action] [say]"`
  - **Q2-c**：仅 speak 成功时写 1 条（静默 tick 不写）
- **重要度打分（规则版）**：
  ```
  importance = 5
  if say 含 '？' / '?' / '我答应' / '记住' / '永远' → 8
  if say 提到 neighbor 名字 → max(importance, 7)
  if emotion ∈ {angry, scared, sad}                → max(importance, 6)
  ```
  LLM 打分留给 M4.2.3。
- **写入时序**（拉票 Q3）：
  - **Q3-a（推荐·同步双写）**：`INSERT npc_memory(embed_status='pending')` → `await embedText` → `await qdrant.upsert` → `UPDATE embed_status='embedded', embed_model=...`；任一步失败留 `pending/failed`，不抛到上层；约 +400~800ms/tick
  - **Q3-b（异步 fire-and-forget）**：`INSERT npc_memory` 后 `setImmediate(...)` 在后台嵌；tick 延迟不受影响但检索延迟一致性差 1-2 tick
  - **Q3-c（全异步批量）**：积 N 条或 1s 内批量 embed（Qdrant batch upsert）；吞吐最好，实现复杂度最高
- **失败保证**：embed 或 upsert 失败只影响当前条目，不影响 speak/memory 输出。

### 4.3 旧 `memory` 节点保留

继续产出 `simulation_meta.memory_summary`，作为“口袋短摘要”持续注入 plan（低成本、不读 Qdrant）。这是 M4.1 的契约，前端 NpcForm 也在用，**不删**。

### 4.4 提示词改动

`graph/prompts.ts` 新增辅助函数 `buildMemoryBlock(entries: MemoryEntry[]): string`，供 `buildPlanPrompt`、`buildSpeakPrompt` 各自在 user 段拼接。无则整段省略（不要留空占位）。

---

## 5. 依赖与 LLM 层

### 5.1 包

```bash
npm i @qdrant/js-client-rest
```

理由：官方库、无依赖链、支持完整 REST。Grpc 客户端目前不需要。

### 5.2 `llmClient.embedText` 扩展

当前写死 `text-embedding-3-small`。本期修改：

```ts
export async function embedText(
  config: { api_key: string; base_url?: string | null; provider: string },
  text: string,
  options?: {
    timeout?: number
    logContext?: LogContext
    model?: string           // 新增：默认读 env MEMORY_EMBED_MODEL
    useCache?: boolean       // 新增：默认 true
  }
): Promise<{ vector: number[]; model: string; cached: boolean; tokens?: number }>
```

- 返回类型从 `number[]` 改为结构体——调用方（新）拿 vector、旧调用点（aiLogger 自测脚本，如有）需适配。
- **磁盘缓存**（拉票 Q4）：
  - **Q4-a（推荐）**：`backend/.cache/embed/<sha1>.bin` 纯文件 + 内存 LRU (1000 entries)，30 天 TTL；key = `sha1(model + '\n' + text.slice(0,8000))`
  - **Q4-b**：MySQL `embed_cache` 新表；优势：跨进程共享；劣势：多一张运维表
  - **Q4-c**：不做缓存，依赖 OpenAI 侧重复成本可接受（1k tokens ≈ $0.00002，本项目量级无压力）
- 失败仍写 `ai_call_log`（`api_type='embed'`），M4.2.1 的 cost 计算继续工作。

### 5.3 `backend/src/engine/memory/qdrantClient.ts`（新文件）

单例封装：

```ts
export interface QdrantConfig {
  url: string
  apiKey?: string
  collection: string
  vectorSize: number
}

export class QdrantMemoryStore {
  async ensureCollection(): Promise<void>        // idempotent
  async upsert(id: number, vector: number[], payload: Payload): Promise<void>
  async search(npcId: number, vector: number[], topK: number): Promise<Array<{ id: number; score: number }>>
  async deleteByIds(ids: number[]): Promise<void>
  async health(): Promise<boolean>               // 2s timeout
}
```

- 默认 `timeout: 3000` + 1 次重试；第二次失败抛 `QdrantUnavailableError`，由节点捕获降级。
- 进程启动读取 env 实例化单例；可用 `setQdrantMemoryStoreForTest()` 覆写供单测。

---

## 6. REST API

> 前缀 `/api/npc/:id/memories`；复用 `controllers/npc.ts`。

| 方法 | 路径 | Body / Query | 行为 |
| --- | --- | --- | --- |
| `GET` | `/api/npc/:id/memories` | `?limit=50&type=&since=ISO` | `SELECT ... ORDER BY created_at DESC` |
| `POST` | `/api/npc/:id/memories` | `{content, type?='manual', importance?=6}` | 同引擎 `memory-store` 写入流程；返回 `{id, embed_status}` |
| `DELETE` | `/api/npc/:id/memories/:mid` | – | MySQL DELETE + `qdrant.deleteByIds([mid])`（Qdrant 失败仅 warn 不 500） |

- **无分页游标**：首版 `limit` 固定 1~200，`since` 做时间截断即可。
- 校验：`content.length ≤ 1000`、`importance ∈ [1,10]`、`type ∈ {observation,dialogue,reflection,event,manual}`。

---

## 7. 环境变量

```bash
# 开关
MEMORY_EMBED_ENABLED=true              # 关掉则 retrieve/store 节点直接短路；不影响 memory_summary
# 模型 & 维度
MEMORY_EMBED_MODEL=text-embedding-3-small
MEMORY_EMBED_DIM=1536                  # 与 collection 严格一致，启动时校验
MEMORY_TOP_K=5
MEMORY_RETENTION_DAYS=30               # 本期只记录，不执行
MEMORY_STORE_MODE=sync                 # sync | async（对应 Q3-a / Q3-b）
MEMORY_RETRIEVE_QUERY_MODE=prev_summary_plus_neighbors   # 对应 Q1-a
# Qdrant
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=
QDRANT_COLLECTION=npc_memory
QDRANT_VECTOR_SIZE=1536
# Embed cache
EMBED_CACHE_ENABLED=true
EMBED_CACHE_TTL_DAYS=30
EMBED_CACHE_DIR=.cache/embed
```

启动校验：`MEMORY_EMBED_DIM !== QDRANT_VECTOR_SIZE` 则 fatal；`MEMORY_EMBED_ENABLED=true` 但 Qdrant URL 不通 → 启动继续但首日志 `WARN: memory embedding disabled due to qdrant unreachable`。

---

## 8. 降级矩阵

| 故障点 | 现象 | 行为 | scheduler.status 字段 |
| --- | --- | --- | --- |
| `MEMORY_EMBED_ENABLED=false` | 手动关停 | retrieve/store 节点整体 skip | `memory_embed=false`（无 warn） |
| Qdrant 不可达（ensureCollection / search / upsert 异常） | 2s 超时 + 1 次重试仍失败 | retrieve 降级 MySQL；store 只写 MySQL（`pending`） | `memory_degraded=true`，appendWarn `'qdrant_down'` |
| embedText 失败（API 限流 / key 错） | 单次失败 | store 仍写 MySQL（`failed`）；retrieve 降级 MySQL | `memory_embed_fail_rate` 滚动窗口 |
| MySQL npc_memory 写失败 | 视为严重 | 本条 memory 丢弃，tick 不中断 | `bus.emitError('memory_mysql_fail')` |

降级判据：`warn` 只冒泡进 scheduler.status；**绝不阻塞 plan/speak/memory 主流程**。

---

## 9. 前端（拉票 Q5）

| 方案 | 本期交付 | 体积 |
| --- | --- | --- |
| **Q5-a（推荐·薄）** | 仅 `Sandbox.vue` 顶栏加 `🧠` 徽章：hover 显 `M: total · degraded? · avg_latency_ms`；不做 Drawer | +80 行 |
| **Q5-b（全量）** | 上述 + `MemoryDrawer.vue`（NPC 右键菜单 → 最新 50 条 + 手动追加 + 删除） | +300 行，多一个 commit |
| **Q5-c（零前端）** | 纯后端节点，前端无感知；等 M4.2.3 一起做 Drawer | 0 行 |

> 若选 Q5-a/Q5-b，需给 WS 消息扩展：`tick.end.memory = { retrieved_count, store_status }`；这个扩展对 M4.2.1 是向后兼容的增量字段。

---

## 10. 测试方案

### 10.1 单测（backend/tests/）

| 文件 | 用例 | 行数预估 |
| --- | --- | --- |
| `engine-memory-store.test.ts` | 规则重要度打分；静默 tick 不写；模拟 Qdrant 失败记 `failed` | ~80 |
| `engine-memory-retrieve.test.ts` | Mock QdrantStore 返回 id 列表 → 断言 MySQL 反查顺序一致；Qdrant 抛错 → 走 MySQL 排序 | ~100 |
| `memory-api.test.ts` | supertest 三端点：GET/POST/DELETE；校验 content 长度、type 白名单 | ~120 |
| `embed-cache.test.ts` | 同 text+model 二次调用 cache hit=true；换 model 不命中 | ~60 |

### 10.2 集成 smoke

`backend/src/scripts/smoke-engine.ts`（已有）扩展：

- 跑 1 场景 × 2 NPC × 10 tick；
- 断言 `SELECT COUNT(*) FROM npc_memory WHERE npc_id=X` ≥ 8；
- 断言 Qdrant collection 点数 = MySQL 已 `embed_status='embedded'` 条数；
- 断言最后一条 `latest_say` prompt 里出现 `【相关记忆】` 注入（通过 `ai_call_log.request_content` grep）。

### 10.3 降级 smoke

新脚本 `smoke-memory-degraded.ts`：人工关闭 Qdrant docker → 跑 5 tick → 断言引擎仍出 success，`scheduler.status().memory_degraded===true`。

---

## 11. commit 拆分（对齐 M4.2.1 的三段式）

| commit | 范围 | 依赖 |
| --- | --- | --- |
| **M4.2.2.a** | 数据层：`npc_memory` 迁移、Qdrant 客户端、`qdrant:init` 脚本、`embedText` 扩展 + 磁盘缓存、env 校验；新增 `embed-cache.test.ts` | 独立，可 review |
| **M4.2.2.b** | 引擎节点：`memory-retrieve` + `memory-store` 接入 `buildGraph`、提示词改造、降级路径；新增 `engine-memory-*.test.ts` + smoke 扩展 | 依赖 a |
| **M4.2.2.c** | REST API 三端点 + Q5 选择的前端变更（`🧠` 徽章 或 Drawer） | 依赖 a（b 可并行） |

每个 commit 都要求：`npm test` 全绿 + `vue-tsc` 零错 + 不回归 M4.2.1 observability。

---

## 12. 待拉票项汇总（请业主投票）

| # | 主题 | 选项 | 默认推荐 |
| --- | --- | --- | --- |
| Q1 | retrieve query 文本构造 | **a** prevSummary+neighbors / b 额外 queryGen LLM / c 仅 prevSummary | **Q1-a** |
| Q2 | memory-store 触发粒度 | **a** say/action 各一条 / b 合并 1 条 / c 仅 speak 成功 | **Q2-a** |
| Q3 | 写入时序 | **a** 同步双写 / b 异步 fire-and-forget / c 全异步批量 | **Q3-a** |
| Q4 | Embed 缓存策略 | **a** 磁盘文件+LRU / b MySQL embed_cache 表 / c 不缓存 | **Q4-a** |
| Q5 | 前端范围 | **a** 顶栏 🧠 薄徽章 / b 徽章+MemoryDrawer / c 零前端 | **Q5-a** |

> 回复格式例：`Q1 a, Q2 a, Q3 a, Q4 a, Q5 a` 即接受全默认推荐。

---

## 13. 风险与回滚

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| Qdrant 版本升级致 API 破坏 | 低 | 固定 `@qdrant/js-client-rest` minor，CI 锁 lockfile |
| embedding 成本飙升（冷启动全量回填） | 中 | 本期 **不做历史回填**；只新 tick 产出；有 `MEMORY_EMBED_ENABLED` kill-switch |
| MySQL/Qdrant 点不一致（孤儿 point / 缺 content） | 中 | cron 扫描 `embed_status='failed' OR pending > 10min` 重嵌；DELETE 两步幂等 |
| 提示词变长致 4k 上下文超限 | 低 | `top_k=5` + `content≤1000` ≈ +5k chars ≈ +1.5k tokens；超了 M4.2.0 的软阈值会自动告警 |
| 记忆 PII / 敏感内容泄漏 | 低 | 记忆只在服务端存储，REST 需鉴权（M3 已有），Drawer 仅管理员可见 |

**回滚**：`MEMORY_EMBED_ENABLED=false` 秒级关停；`npc_memory` 表保留不删；Qdrant collection 可 `DELETE /collections/npc_memory` 独立清理。引擎行为退化回 M4.2.1（继续跑 plan/speak/memory 三节点）。

---

## 14. 交付验收（Definition of Done）

- [ ] `npm run db:migrate:m422` 幂等成功
- [ ] `npm run qdrant:init` 幂等成功
- [ ] 跑 10 tick 后：`SELECT COUNT(*) FROM npc_memory WHERE embed_status='embedded'` ≥ 8；Qdrant collection points 数一致
- [ ] `latest_say` prompt 中出现 `【相关记忆】` 段
- [ ] 关停 Qdrant 容器后引擎继续 success，scheduler.status `memory_degraded=true`
- [ ] 后端测试 ≥ 55（原 47 + 新 8）全绿；前端 vue-tsc + vitest 不回归
- [ ] `docs/m4.2-roadmap.md` 版本升至 0.8，勾选 M4.2.2，指向 M4.2.3
- [ ] `docs/engine-integration-m4.2.2.md` 升至 v1.0（本文）
