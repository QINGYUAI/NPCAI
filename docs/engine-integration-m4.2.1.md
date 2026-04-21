# M4.2.1 观测性 细设

| 文档版本 | 日期 | 说明 |
|---------|------|------|
| 0.1 | 2026-04-21 | 初稿：M4.2 roadmap v0.3 里 M4.2.1 观测性（WebSocket + tokens/cost 真实化 + tick 时间线浮窗）的工程落地规格；**待评审** |
| 0.2 | 2026-04-21 | **首轮评审通过**（见 §10.0）：Tokenizer = **`tiktoken` (wasm)**；浮窗 = **P1 右侧独立列**；WS = **`ws` 复用 express**；单价表 = **硬编码**；**3 个 commit** 分拆。§12 原「明确不做」保留但降级为「**后续扩展点**」（需求入档，不进本节点）。下一步：**开始 M4.2.1.a** |
| 0.3 | 2026-04-21 | **✅ M4.2.1.a 后端计费完成**：`ai_call_log` 扩 4 列（prompt/completion/total_tokens、cost_usd）+ `(source,created_at)` 复合索引；新增 `engine/tokenCounter.ts`（tiktoken + 硬编码单价表 + `COST_ACCOUNTING_ENABLED` 开关）；`llmClient.chatCompletion` 采集 provider usage / 本地估算双路径，`onMetrics` 回调；`graph/build.ts` tick 粒度累加 `tokens` + `cost_usd`；`scheduler.lastTickTokensByNpc` 接入真实值（M4.2.0 占位到此**真正生效**）；新增 11 条单测（tokenCounter 8 + llmClient 3），后端 **41/41 全绿** + tsc build 通过。下一步：**M4.2.1.b WebSocket 推送** |
| 0.4 | 2026-04-21 | **✅ M4.2.1.b WebSocket 推送完成**：新增 `engine/wsServer.ts`（`/ws/engine?scene_id=<id>`，与 express 同端口复用，自定义关闭码 4000/4001/4002 + 心跳 30s / idle 60s + `OBSERVABILITY_WS_MAX_PER_SCENE`）；`types.ts` `TickEvent` 扩展 —— `tick.npc.updated` 增 `status/duration_ms/tokens/cost_usd/npc_name`、新增 `meta.warn`、`tick.end` 增 `cost_usd_total`；`scheduler.pushMetaWarn` 同步 emit 事件；`index.ts` 改 `http.createServer` 以挂载 ws；`GET /api/engine/status` 开启时响应附加 `ws_endpoint`；前端 `api/engine.ts` 新增 `openEngineWs`（指数退避 1/2/4/8/16s + idle 重连 + `degraded` 回调）；`Sandbox.vue` WS 优先、连续失败回落 3s 轮询、`meta.warn` 实时更新、顶栏新增 WS 状态徽章（● WS / ◐ WS… / ○ 轮询）；新增 **6 条 WS 单测**，后端 **47/47 全绿** + tsc build 通过，前端 vue-tsc 通过。下一步：**M4.2.1.c 前端 tick 时间线浮窗 P1** |
| 0.5 | 2026-04-21 | **✅ M4.2.1.c 前端 tick 时间线完成 → M4.2.1 整节点收官**：新增 `frontend/src/types/timeline.ts`（`TimelineTickRow / TimelineNpcEntry` 纯数据模型）与 `components/SandboxTimeline.vue`（P1 右侧独立列 panel + v-model:collapsed；小屏 <1280px 自动切 el-drawer + v-model:visible）——内部 20 条 ring buffer，每行可展开显示 NPC 明细（状态图标 / duration / prompt→completion tokens / cost / `meta_summary.latest_say` or `latest_action`）；`Sandbox.vue` 扩展 WS 订阅（`onTickStart` 新建 row、`onNpcUpdated` 追加 NPC 记录 + 累计 session tokens/cost、`onTickEnd` 写回 duration 与 `ended_at`），顶栏新增 `Σ $0.xxxx · Ntok` 会话累计标签（点击切 panel 折叠 / drawer 开关），切场景 / 组件卸载归零；添加 `resize` 监听在 1280px 断点动态切 panel/drawer 形态。前端 **vue-tsc 通过 + vitest 13/13 绿**，后端零变更仍 **47/47**。**M4.2.1 观测性整节点收官**，后续扩展点 E1-E4 保留在 §12；下一节点 **M4.2.2 记忆向量化** |

> 关联：[`m4.2-roadmap.md`](./m4.2-roadmap.md) §4.1 / §5.2 / §5.3 / §6；[`engine-integration-m4.1.md`](./engine-integration-m4.1.md)。
> **本文档只定义工程规格，不修改任何已交付代码。**

---

## 0. 摘要（TL;DR）

- **目标**：把 M4.1/M4.2.0 里"日志 + 3s 轮询 + cost 占位 0"的观察侧升级为 **实时推送 + 真实计费 + 时间线可视化**，为后续 M4.2.2~M4.2.4（记忆 / 反思 / 事件）提供观察与调试基础。
- **三条子线**（按依赖顺序，**分 3 个 commit**）：
  - **M4.2.1.a 后端计费**（~1 天）：`ai_call_log` 扩列 + tokenizer 选型 + `llmClient` 写入真实 `prompt_tokens / completion_tokens / cost_usd` + `scheduler.lastTickTokensByNpc` 接入真实值（M4.2.0 占位到此真正生效）
  - **M4.2.1.b WebSocket 服务端**（~0.5 天）：`/ws/engine?scene_id=xxx` 订阅 + `bus` 事件广播 + 降级兼容（HTTP 轮询保留）
  - **M4.2.1.c 前端时间线**（~1 天）：Sandbox 从 3s 轮询切换为 WS 订阅 + 右侧 tick 时间线浮窗 + 顶栏 tokens/cost 累计
- **不改**：`simulation_meta` 结构 / 推理图节点 / 现有 5 个 REST 接口行为 / 数据库已有表的现有列。
- **可回退**：`OBSERVABILITY_WS_ENABLED=false` 时 WebSocket 不启动，前端自动回落 3s 轮询。

---

## 1. 范围

### 1.1 范围内（M4.2.1）

1. `ai_call_log` 幂等追加列：`prompt_tokens` / `completion_tokens` / `total_tokens` / `cost_usd`（4 列，均可空）。
2. Tokenizer 选型 + 封装：`src/engine/tokenCounter.ts`（本地估算 prompt tokens + 计费单价查表）。
3. `llmClient.ts` 改造：调用 LLM 后写真实 tokens/cost 到 `ai_call_log`，并把 tokens 回传到 graph 的 `GraphOutput.tokens`。
4. `scheduler.ts` 把真实 tokens 塞进 `lastTickTokensByNpc`，使 M4.2.0 的预算 skip 真正生效；`cost_usd_total` 累加改为来自 LLM 真实值。
5. **WebSocket 服务**：`ws` 包 + `/ws/engine` 路由；`bus.emitEvent` 在发送本地事件的同时广播到所有订阅了该 `scene_id` 的客户端；心跳 ping/pong。
6. 前端：
   - Sandbox 引擎控制条区域新增「**tick 时间线浮窗**」（可收起），展示最近 20 tick × NPC 的 `status / duration / tokens / cost / 简短 say`。
   - 3s 轮询改成 **WS 首选 + HTTP 兜底**（WS 断线自动降级轮询）。
   - 顶栏 `meta-warn` 徽章旁边新增 `Σ $0.0012 · 1.2k tok` 累计指示。

### 1.2 不在范围

- 记忆向量化（M4.2.2）
- 反思循环（M4.2.3）
- 事件总线对 `scene_event` 表的持久化（M4.2.4）
- 账单报表 / 成本分摊 / 月度导出（不在 M4.2 任何节点）
- tokenizer 多语言模型特化（只保留 OpenAI 兼容系列的 cl100k/o200k 两个编码表）

---

## 2. 依赖与环境变量

### 2.1 新增依赖

| 名称 | 作用 | 位置 | 候选（见 §10 评审投票） |
|------|------|------|------------------------|
| `ws` | WebSocket 服务端 | backend | **锁定** `ws`（§10.3 = W1） |
| `tiktoken` | 本地估算 prompt tokens（wasm） | backend | **锁定** `tiktoken` (wasm, ~2MB)（§10.1 = B） |

> 前端**不引入 WebSocket 库**，直接用浏览器内置 `WebSocket` API；自动重连逻辑自己手写约 40 行。

### 2.2 环境变量

```env
OBSERVABILITY_WS_ENABLED=true          # 总开关；false 则 /ws/engine 不挂载，前端自动回落轮询
OBSERVABILITY_WS_PATH=/ws/engine       # 路径（一般不改）
OBSERVABILITY_WS_MAX_PER_SCENE=8       # 单场景最多 8 个并发订阅，超出踢掉最老的
OBSERVABILITY_WS_PING_MS=30000         # 心跳间隔
COST_ACCOUNTING_ENABLED=true           # 关掉则不估算 prompt_tokens、不查单价表（全部置 0）
```

---

## 3. 数据模型变更

### 3.1 `ai_call_log` 追加列（迁移 `migrate-m42.ts` 扩展）

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `prompt_tokens` | `INT NULL` | `NULL` | 由 tokenizer 本地估算或 provider `usage` 返回；`COST_ACCOUNTING_ENABLED=false` 时保持 NULL |
| `completion_tokens` | `INT NULL` | `NULL` | 同上，优先用 provider 返回值 |
| `total_tokens` | `INT NULL` | `NULL` | `prompt+completion`，冗余字段为了查询便利 |
| `cost_usd` | `DECIMAL(10,6) NULL` | `NULL` | 按 §5.2 单价表计算 |

> **不动** `response_info` / `context` JSON 列；保证旧日志查询兼容。

**迁移文件**：在现有 `backend/src/db/migrate-m42.ts` 里继续追加幂等块（不开新文件）：

```ts
// M4.2.1.a：ai_call_log 追加 tokens / cost
for (const col of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
  if (!(await hasColumn(conn, dbName, 'ai_call_log', col))) {
    await conn.query(`ALTER TABLE ai_call_log ADD COLUMN ${col} INT NULL COMMENT '[M4.2.1]'`);
  }
}
if (!(await hasColumn(conn, dbName, 'ai_call_log', 'cost_usd'))) {
  await conn.query(`ALTER TABLE ai_call_log ADD COLUMN cost_usd DECIMAL(10,6) NULL COMMENT '[M4.2.1]'`);
}
```

### 3.2 不新增表

- M4.2.1 无新表；tick 时间线浮窗所需数据全部来自 `npc_tick_log` + 新增 4 列的 `ai_call_log`，前端按 `tick` 聚合渲染。

---

## 4. API 变更

### 4.1 WebSocket `GET /ws/engine?scene_id=<id>`

**连接**：
- 握手时校验 `scene_id` 存在；不存在返回 4000 Close（自定义码）。
- 单场景订阅超 `OBSERVABILITY_WS_MAX_PER_SCENE` 时，踢掉最老一个（返回 4001 Close），新客户端接入。

**服务端 → 客户端消息**：

```ts
// 原样转发 bus 事件，加 ts 服务端时间戳
{ ts: "2026-04-21T10:30:00.000Z", type: "tick.start", scene_id: 1, tick: 12 }
{ ts: "...", type: "tick.npc.updated", scene_id: 1, tick: 12, npc_id: 2,
  status: "success", duration_ms: 1340,
  tokens: { prompt: 420, completion: 85, total: 505 },
  cost_usd: 0.000378,
  meta_summary: { latest_say: "今天天气真好", emotion: "happy" }   // 仅必要子集，避免 > 4KB
}
{ ts: "...", type: "tick.end", scene_id: 1, tick: 12, cost_usd_total: 0.002 }
{ ts: "...", type: "error", scene_id: 1, tick: 12, npc_id: 2, message: "..." }
{ ts: "...", type: "meta.warn", scene_id: 1, tick: 12, npc_id: 2, bytes: 70245 }  // 新增
{ ts: "...", type: "ping" }      // 服务端心跳
```

**客户端 → 服务端消息**：

```ts
{ type: "pong" }                    // 回应心跳
{ type: "subscribe_scenes", scene_ids: [1, 2] }   // 同一连接订阅多场景（可选，M4.2.1 不强制）
```

**错误码**：
| Code | 含义 |
|------|------|
| 1000 | 正常关闭 |
| 4000 | scene_id 参数错误 / 场景不存在 |
| 4001 | 被 `MAX_PER_SCENE` 踢出（附 reason） |
| 4002 | 心跳超时 |

### 4.2 HTTP 扩展（向后兼容，非破坏）

- `GET /api/engine/status` 响应 `data` 增加一个顶层 `ws_endpoint: "/ws/engine"` 字段；前端用它判断是否启用了 WS，没这字段就走轮询。

---

## 5. 引擎内部变更

### 5.1 `src/engine/tokenCounter.ts`（新文件，~80 行）

```ts
/** [M4.2.1] 本地 token 计数 + 单价表 */
export function countTokens(model: string, text: string): number
export function priceFor(model: string): { in_per_1k: number; out_per_1k: number } | null
export function calcCostUsd(model: string, prompt: number, completion: number): number
```

- **tokenizer（锁定 B = `tiktoken` wasm）**：按模型选 encoding（`gpt-4o`/`gpt-4o-mini` 用 `o200k_base`，其它 OpenAI 兼容用 `cl100k_base`，未知模型退回 `cl100k_base`）。加载失败时走字符数 /4 兜底并写 `ai_logger` 警告。
- `priceFor` 内建单价表（硬编码 + 注释 "截至 2026-04"）：
  ```ts
  const PRICES = {
    'gpt-4o-mini':       { in_per_1k: 0.00015, out_per_1k: 0.00060 },
    'gpt-4o':            { in_per_1k: 0.00250, out_per_1k: 0.01000 },
    'deepseek-chat':     { in_per_1k: 0.00014, out_per_1k: 0.00028 },
    'glm-4-flash':       { in_per_1k: 0.00000, out_per_1k: 0.00000 },  // 免费
    // ... 未匹配时返回 null，cost_usd 存 NULL
  };
  ```
- **不下载 wasm / 不联网**；全部本地。

### 5.2 `src/engine/llmClient.ts`（改造）

调用路径：

```
buildPrompt(...)
  → 本地 countTokens(model, prompt)  → prompt_tokens_est
  → fetch(LLM)
  → 优先读 response.usage.{prompt_tokens, completion_tokens}
  → 其次用 prompt_tokens_est + countTokens(model, completion) 兜底
  → calcCostUsd → cost_usd
  → aiLogger.log({ ..., prompt_tokens, completion_tokens, total_tokens, cost_usd })
  → return { content, tokens: { prompt, completion, total }, cost_usd }
```

- **现有调用方全部改造**：`plan` / `speak` / `memory` 三个节点在 `graph/build.ts` 里会把 LLM 返回的 tokens 累加到 `GraphOutput.tokens` 与 `GraphOutput.cost_usd`。

### 5.3 `src/engine/graph/build.ts`（微调）

`GraphOutput.tokens` 在 M4.2.0 已预留 `number`；升级为：

```ts
export interface GraphOutput {
  nextMeta: SimulationMetaV1;
  inputSummary: string;
  cost_usd?: number;       // 已有，改为真实累加
  tokens?: number;         // 已有，改为真实累加（三节点 total 之和）
}
```

- `runDryRun` 保持 `tokens = 0, cost_usd = 0`。
- `runLive`：每个 LLM 节点返回后累加到 local 聚合器。

### 5.4 `src/engine/scheduler.ts`（微调）

```diff
- this.lastTickTokensByNpc.set(npc.id, Number(result.tokens ?? 0));
+ this.lastTickTokensByNpc.set(npc.id, Number(result.tokens ?? 0));  // 不变
- this.costUsdTotal += result.cost_usd || 0;                          // 原来始终 0
+ this.costUsdTotal += result.cost_usd || 0;                          // 现在有值
```

这一处代码形式上不变，但语义从"占位 0"变成"真实累加"。**配合单测**：M4.2.0 的 budget-skip 用例现在可以删掉那个手动 mock tokens 的旁路，改成 mock 一次真实 LLM 响应。

### 5.5 `src/engine/wsServer.ts`（新文件，~120 行）

```ts
export function mountEngineWs(server: http.Server, app: Express): void {
  if (process.env.OBSERVABILITY_WS_ENABLED === 'false') return;
  const wss = new WebSocketServer({ server, path: '/ws/engine' });
  // 每个 scene_id → Set<WebSocket>
  // bus.on('tick.start' | 'tick.npc.updated' | 'tick.end' | 'error' | 'meta.warn', broadcast)
  // 心跳 / 订阅超限踢人 / 心跳超时 close
}
```

- 在 `src/index.ts` 从 `app.listen()` 改成 `http.createServer(app).listen()`，以便 `ws` 挂载（改动小，已有成熟范式）。
- `bus` 里 **新增一个事件类型** `meta.warn`：`scheduler.pushMetaWarn()` 时同时 `bus.emitEvent({type:'meta.warn', ...})`，这样前端能实时弹徽章而非等 status 轮询。

### 5.6 `src/engine/bus.ts`（微扩）

- 原有 `'tick.start' | 'tick.npc.updated' | 'tick.end' | 'error'` 枚举中加入 `'meta.warn'`；类型定义在 `engine/types.ts` 同步扩充。
- noop `'error'` listener 保留（M4.2.0 修复）。

---

## 6. 前端改造

### 6.1 `frontend/src/api/engine.ts`（新文件 or 追加）

```ts
export function openEngineWs(
  sceneId: number,
  handlers: {
    onTickStart?: (e: WsTickStart) => void;
    onNpcUpdated?: (e: WsNpcUpdated) => void;
    onTickEnd?: (e: WsTickEnd) => void;
    onError?: (e: WsError) => void;
    onMetaWarn?: (e: WsMetaWarn) => void;
    onConnectionChange?: (state: 'connecting'|'open'|'closed'|'degraded') => void;
  }
): () => void    // 返回 close 函数
```

- **自动重连**：指数退避 1s / 2s / 4s / 8s / 16s，失败 5 次后 `onConnectionChange('degraded')`，外层回落 3s 轮询。
- **心跳**：收到 `ping` 回 `pong`；30s 未收到任何消息主动 close 重连。

### 6.2 `frontend/src/components/Sandbox.vue`（改造 ~150 行）

**§6.2.1 订阅切换**：
- `onMounted` 时：读 `status.ws_endpoint`，有就 `openEngineWs(scene_id, ...)`；没有或连接 `degraded` 时启动 3s `setInterval` 轮询（现有逻辑抽成 `startHttpPolling`）。
- `engineStatus.value` 的更新来源变为：
  - WS `tick.end` → 覆盖 `tick` / `last_tick_at` / `last_duration_ms` / `cost_usd_total`
  - WS `meta.warn` → 推进 `meta_warns[]`（保留 M4.2.0 去重 toast 逻辑）
  - HTTP 轮询：仅在降级模式下跑

**§6.2.2 tick 时间线浮窗（新组件 `SandboxTimeline.vue`）**：

```
┌────────────────────────────────────┐
│ 时间线 [20/20]   [收起]             │
├────────────────────────────────────┤
│ t=12 10:30:42  Σ$0.0012 · 505tok   │
│  ├─ 小美 ✓ 1.3s  420→85  "今天..."  │
│  └─ 小明 ✓ 1.1s  380→72  "嗯..."    │
│ t=11 10:30:37  Σ$0.0010 · 480tok   │
│  ├─ 小美 ⚠ skip  budget=2000       │
│  └─ 小明 ✓ 1.2s  ...               │
└────────────────────────────────────┘
```

- 列表**最多 20 条**（ring buffer），新 tick 入栈把最老踢掉。
- 每条可点击展开，显示 `input_summary` 和 `meta_summary.latest_say`。
- **位置**：Sandbox 右侧（若浏览器宽度 < 1280px 自动折叠为抽屉）。

**§6.2.3 顶栏累计指示**：
- 在 meta-warn 徽章右侧（或左侧）加一个 `Σ $0.0012 · 1.2k tok` 静态标签（点击展开时间线浮窗）。

### 6.3 `frontend/src/types/engine.ts`（补）

追加 WS 消息类型定义 + `EngineStatus` 加 `ws_endpoint?: string`。

---

## 7. 测试矩阵

| 模块 | 测试 | 位置 | 技术 |
|------|------|------|------|
| tokenCounter | cl100k/o200k 基础字符串长度断言 | `tests/token-counter.test.ts`（新） | vitest |
| tokenCounter | 未知 model 退回 `cl100k`；价格表未命中返回 null | 同上 | vitest |
| llmClient | mock `fetch` 返回带 `usage`；断言 `ai_call_log` 四列被写入 | `tests/llm-client.test.ts`（新） | vitest + mock |
| llmClient | provider 不返回 usage 时用本地估算兜底 | 同上 | vitest |
| scheduler | 用真实 `tokens` 替代 M4.2.0 的 mock，再验预算 skip | `tests/engine-budget.test.ts`（扩展） | vitest |
| wsServer | 启动 → 订阅 → 广播 → 断开；MAX_PER_SCENE 踢旧；心跳超时踢人 | `tests/engine-ws.test.ts`（新） | vitest + `ws` 客户端 |
| 前端 Sandbox | WS 断线降级为轮询；时间线浮窗入栈/溢出；顶栏累计 | 人工验收（同 M4.2.0 形式） | 手点 + MCP 浏览器 |

**目标**：后端单测 30 → **40+** 全绿；前端 `vue-tsc` 通过。

---

## 8. 风险与降级

| 风险 | 影响 | 对策 |
|------|------|------|
| tokenizer 打包体积膨胀 | 后端 cold start 变慢 | 选项 A/C 纯 JS；选项 B wasm 首次加载较大 —— 见 §10 投票 |
| 单价表过时 | `cost_usd` 失真 | 注释明确"截至 2026-04"；易于手动更新；未命中返回 NULL 避免误导 |
| provider 不返 `usage` | `completion_tokens` 只能本地估算 | 本地 tokenize 完成内容兜底，并在 `ai_call_log.context.usage_source='estimated'` 标记 |
| WebSocket 连接风暴 | 后端压力 | `MAX_PER_SCENE=8`；超过踢最老（已在 §4.1） |
| WebSocket 兼容性（代理 / 公司网关） | 部分部署环境阻断 | `OBSERVABILITY_WS_ENABLED=false` 一键关；前端自动走轮询 |
| 前端时间线内存泄漏 | 长时间运行占内存 | ring buffer 上限 20；组件 `beforeUnmount` 清 timer |
| 浮窗遮挡沙盒画布 | UX 差 | 右侧独立列 + 可收起；< 1280px 时变抽屉 |

---

## 9. 验收清单（DoD）

### M4.2.1.a 后端计费
- [ ] `migrate-m42.ts` 追加 `ai_call_log.{prompt_tokens,completion_tokens,total_tokens,cost_usd}` 并幂等
- [ ] 跑一次真实 LLM tick 后，`SELECT prompt_tokens, completion_tokens, cost_usd FROM ai_call_log ORDER BY id DESC LIMIT 6` 全部非 NULL
- [ ] `engine/status.cost_usd_total > 0`
- [ ] `ai_config.budget_tokens_per_tick` 设成 100，再跑一次 tick，第二 tick 的该 NPC `npc_tick_log.status = 'skipped'`
- [ ] tokenizer 单测（字符串长度断言 ± 5%）全绿
- [ ] `npm run smoke:engine` 仍然 🟢 PASS

### M4.2.1.b WebSocket
- [ ] `OBSERVABILITY_WS_ENABLED=true` 启动后，`curl -i -H "Upgrade: websocket" ... /ws/engine?scene_id=1` 101 Switching Protocols
- [ ] 单测覆盖：订阅 / 广播 / MAX_PER_SCENE 踢人 / 心跳超时
- [ ] `OBSERVABILITY_WS_ENABLED=false` 时 `/ws/engine` 404

### M4.2.1.c 前端
- [ ] Sandbox 启动 → DevTools Network 看到 `ws://.../ws/engine?scene_id=1` 101
- [ ] 跑 tick 时，浮窗实时追加条目；关闭后端 WS → 5s 内切换为轮询
- [ ] 顶栏实时看到 `Σ $... · ... tok` 累计，且与 `engine/status.cost_usd_total` 一致
- [ ] 浏览器宽度 < 1280px 时浮窗变抽屉，不遮挡 Phaser 画布
- [ ] `vue-tsc` 通过

### 文档
- [ ] `m4.2-roadmap.md` 更新 v0.4，M4.2.1 勾选完成
- [ ] `requirements-character-scene.md` 更新 v1.4 添加 M4.2.1 交付要点
- [ ] 本文档升级 v1.0 收官

---

## 10. 评审投票点

### 10.0 首轮评审结论（2026-04-21）

| # | 决策项 | 选项 | 结果 |
|---|--------|------|------|
| 10.1 | Tokenizer | A/B/C | **B** `tiktoken` (wasm, ~2MB) —— 精度优先 |
| 10.2 | 时间线浮窗形态 | P1/P2/P3 | **P1** 右侧独立列（宽屏展开，窄屏抽屉） |
| 10.3 | WebSocket 实现 | W1/W2/W3 | **W1** `ws` 包 + 复用 express http server |
| 10.4 | 单价表来源 | S1/S2 | **S1** 硬编码在 `tokenCounter.ts`（M4.2.x 再升级 S2） |
| 10.5 | 拆分 commit | 1/3 | **3 个 commit**：a → b → c |
| §12 | 明确不做 | - | **保留需求入档**，降级为"后续扩展点"（见 §12 v0.2） |

→ 以下 10.1~10.5 为历史投票选项，保留供溯源。

> 这是立项阶段**必须先定**的几个选项，以下任意一个变更都会影响 §5 的编码。

### 10.1 Tokenizer 选型（**必选一**）

| 选项 | 包名 | 大小 | 准确度 | 速度 | 打包/部署 |
|------|------|------|--------|------|-----------|
| **A. `js-tiktoken`** | `js-tiktoken` | ~1MB | 与 OpenAI 一致 | 中 | 纯 JS，无 wasm，Windows/Linux/Electron 开箱即用 |
| **B. `tiktoken`** | `tiktoken` (wasm) | ~2MB | 与 OpenAI 一致 | 快 | 首启加载 wasm；某些沙箱环境装载需要额外配置 |
| **C. `gpt-tokenizer`** | `gpt-tokenizer` | ~500KB | 近似，社区维护 | 最快 | 最轻但精度略低（差 1-3%） |

**我的建议**：**A**（兼容性 > 速度；对象只有 3 个 LLM 节点 × 2 NPC，性能不是瓶颈）。

### 10.2 tick 时间线浮窗交互形态（**三选一**）

- **P1. 右侧独立列**（宽屏展开，窄屏抽屉）—— 见 §6.2.2 草图
- **P2. 底部抽屉**（占 1/4 高度，永远展开）
- **P3. 悬浮在 Sandbox 右上角的小卡片 + 展开按钮**（最省空间）

**我的建议**：**P1**（信息密度 × 可读性最平衡）。

### 10.3 WebSocket 实现路径（**必选一**）

- **W1. `ws` 包 + 复用 express http server**（推荐；改 `src/index.ts` 一处）
- **W2. Socket.IO**（房间/广播方便但体积大、版本耦合）
- **W3. SSE 单向推送**（更简单但前端时间线双向需求弱，未来 M4.2.4 可能要客户端→服务端订阅）

**我的建议**：**W1**（体积 / 一致性最好；前端用原生 API，无依赖）。

### 10.4 单价表来源（**二选一**）

- **S1. 硬编码在 `tokenCounter.ts`**（当前草案）—— 易读，需手动更新
- **S2. 独立 `docs/llm-pricing.md` + `backend/src/data/pricing.json`**（后续扩展方便）

**我的建议**：**S1**（M4.2.1 够用，M4.2.x 扩展到更多 provider 时再升级 S2）。

### 10.5 拆分 commit 策略

- **a / b / c 分 3 个 commit**（推荐；每个 commit 都可独立跑 smoke 验证）
- 合成 1 个 commit（快但回滚粒度粗）

**我的建议**：**3 个 commit**，按顺序 a → b → c。

---

## 11. 里程碑拆分（预计 2.5 工作日）

| 子节点 | 关键产物 | 预计 | 依赖 |
|-------|---------|------|------|
| M4.2.1.a | 迁移 + tokenCounter + llmClient 接入 + 单测 | 1.0 天 | 评审通过 §10.1 §10.4 |
| M4.2.1.b | wsServer.ts + bus.meta.warn + 单测 | 0.5 天 | §10.3 确定 |
| M4.2.1.c | Sandbox 时间线浮窗 + 顶栏累计 + 降级链路 | 1.0 天 | §10.2 确定 |
| 文档 & 验收 | 三份 doc 更新 + 本地 smoke 跑通 | 含在上面 | - |

---

## 12. 后续扩展点（v0.2：保留需求入档，不进本节点）

> v0.1 中标为 ❌「明确不做」的四项，首轮评审（§10.0）决定**保留需求登记**，方便未来单独立项扩展。本节点仍**不实现**；等触发条件后新建子里程碑（M4.2.x+ / M5）处理。

| # | 需求 | 不在 M4.2.1 做的原因 | 触发扩展的条件 | 预估工期 | 可复用的基建 |
|---|------|---------------------|----------------|----------|-------------|
| E1 | **Tick 回放**（按历史 tick 重跑 / 查看帧） | 调试需求弱于实时监控；数据已全量在 `npc_tick_log` | 业主需要离线复现某次诡异行为 | 2-3 天 | 现有 `npc_tick_log` 全量 I/O 已归档 |
| E2 | **前端成本图表**（tokens 折线 / cost 柱状图） | 初期文字累计足够；避免 chart 库侵入 | 运行时间超过一周 / 需要周报 | 1-2 天 | M4.2.1 已采集真实 tokens/cost |
| E3 | **按节点拆分 tokens**（plan=X, speak=Y, memory=Z） | `ai_call_log.source` 字段已存节点标识，聚合 SQL 能做 | 优化 prompt 预算时需要定位高耗节点 | 0.5-1 天 | `ai_call_log.source` 已在 M4.1.b 写入 |
| E4 | **`/api/ai-logs` 列表接口** | 日志表偏内部；REST 暴露会拉高体量传输 | 外部 BI 工具 / 运维需要只读视图 | 0.5 天 | `ai_call_log` 表；新增分页接口即可 |

**保留策略**：这 4 项在未来 3 个月内若被触发，直接单点立项（命名建议 `M4.3.E1` 等）；暂不排期、不占 M4.2.x 工期预算。

---

## 12.1 非目标（本节点硬性边界）

以下内容**本节点仍然不做**（与 §1.2 对齐）：
- 记忆向量化（M4.2.2）/ 反思循环（M4.2.3）/ 事件总线持久化（M4.2.4）
- 账单报表 / 成本分摊 / 月度导出
- tokenizer 多语言模型特化（只保留 cl100k / o200k 两个 OpenAI 兼容编码表）

---

## 13. 后续里程碑对接

- **M4.2.2 记忆**：复用本节的 WebSocket 通道推送 `memory.stored` / `memory.retrieved` 事件，前端时间线直接加一行 memory 子事件
- **M4.2.3 反思**：每 N tick 的 `reflect` 节点耗时和 tokens 天然走同一通道
- **M4.2.4 事件**：`scene.event.injected` 事件通过 WS 广播，前端可以在时间线上打不同颜色的标记

---

> 评审通过后：本文档 bump 到 v0.2，开始实现 M4.2.1.a。实现完一子步，更新本文档对应 DoD 勾选。
