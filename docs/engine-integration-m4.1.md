# M4.1 引擎集成细设

| 文档版本 | 日期 | 说明 |
|---------|------|------|
| 0.1 | 2026-04-20 | 初稿：承接 `docs/engine-selection.md`（C1+C2 推荐方案）的**工程落地规格**，可直接作为 M4.1 立项输入；**待评审** |

> 关联：选型依据见 [`engine-selection.md`](./engine-selection.md)；字段与里程碑见 [`requirements-character-scene.md`](./requirements-character-scene.md)。
> **本文档只定义工程规格，不修改现有 M1~M3.3 已交付代码。**

---

## 0. 摘要（TL;DR）

- **形态**：**A 同进程**（Node/TS 后端新增 `src/engine/` 模块）+ **LangGraph.js** 驱动推理子图，写回 `npc.simulation_meta`。
- **调度**：后端进程内**场景级 Tick 循环**（`setInterval` + 背压门），每个场景一把运行时锁。
- **通信**：新增 `POST/GET /api/engine/*` REST + 可选 `WS /ws/engine`；前端沙盒增加「运行 / 暂停 / 步进」控件（占位按钮已在 §8 小补丁内规划）。
- **记忆流**：**M-0（摘要字符串）起步**，`simulation_meta.memory_summary` 单字段；M-1/M-2 延后。
- **兼容**：不破坏任何已有表结构；新增均为**可空字段**与**新表**，可在单独迁移脚本中幂等创建。
- **可回退**：M4.1 一键禁用（环境变量 `ENGINE_ENABLED=false`），沙盒退化为只读可视化。

---

## 1. 范围

### 1.1 范围内（M4.1）

1. `src/engine/` 模块：**调度器 / 推理图 / 事件总线 / 持久化** 四层。
2. `POST/GET /api/engine/{start,stop,status,ticks}` 四个 REST 接口与错误码表。
3. `simulation_meta` **v1.0 字段规范**（建议不强校验；仅软大小阈值）。
4. `npc_tick_log`（**新增表**）：按 tick 归档一次决策的 I/O，供回放 / 观测。
5. 前端沙盒：**运行控制条**（开始 / 暂停 / 步进 / 速率）+ 状态气泡**实时订阅**（SSE 轮询即可，WebSocket 为可选增强）。
6. 单测矩阵与集成 smoke case。

### 1.2 不在范围

- 路径寻路 / 动画 / 碰撞等**空间仿真**；
- 记忆向量化（M-2）、反思图谱、长期关系演化；
- 多进程 / 水平扩缩；
- 前端 E2E、生产压测。

---

## 2. 模块架构

```
backend/src/
├── engine/
│   ├── index.ts                # 引擎入口：注册路由、挂载调度器
│   ├── scheduler.ts            # SceneScheduler：场景级 Tick 循环
│   ├── registry.ts             # 进程内单例 Map<sceneId, SceneScheduler>
│   ├── graph/
│   │   ├── build.ts            # buildAgentGraph()：LangGraph.js 图定义
│   │   ├── nodes/
│   │   │   ├── loadContext.ts  # 读取 NPC + scene + 邻居 + 最近 tick
│   │   │   ├── reflect.ts      # 短期反思（可选，Prompt 模板）
│   │   │   ├── plan.ts         # 本 tick 规划
│   │   │   ├── speak.ts        # 生成 latest_say / latest_action
│   │   │   └── persist.ts      # 写 simulation_meta + tick_log
│   │   └── prompts/            # Markdown / .hbs 模板，集中版本管理
│   ├── bus.ts                  # EventEmitter：tick.*、error.*
│   ├── ws.ts                   # （可选）/ws/engine 广播
│   └── types.ts                # TickEvent、AgentState、EngineConfig
├── controllers/
│   └── engine.ts               # REST 处理层
└── routes/
    └── engine.ts               # /api/engine/*
```

**设计原则**

- `scheduler` 不直接持有 LLM 客户端；通过 `graph` 调用已有 `services/aiClient.ts`（复用 `ai_config` + 日志）。
- `graph` 不直接写数据库；由 `nodes/persist.ts` 汇总并在事务内一次性写入。
- `registry` 是**进程级单例**；重启即失效（M4.1 不做持久化运行态，冷启后需手动 `POST /engine/start`）。

---

## 3. 数据层变更

### 3.1 **新增表** `npc_tick_log`（观测 / 回放）

```sql
CREATE TABLE IF NOT EXISTS npc_tick_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  scene_id BIGINT NOT NULL,
  npc_id BIGINT NOT NULL,
  tick BIGINT NOT NULL COMMENT '场景内单调递增的 tick 序号',
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) DEFAULT NULL,
  status VARCHAR(16) NOT NULL COMMENT 'success / error / skipped',
  input_summary TEXT DEFAULT NULL COMMENT '本 tick 输入摘要（context + 最近对话）',
  output_meta JSON DEFAULT NULL COMMENT '本 tick 产出（与 simulation_meta 一致快照）',
  error_message TEXT DEFAULT NULL,
  duration_ms INT DEFAULT NULL,
  INDEX idx_scene_tick (scene_id, tick),
  INDEX idx_npc (npc_id),
  CONSTRAINT fk_tick_scene FOREIGN KEY (scene_id) REFERENCES scene(id) ON DELETE CASCADE,
  CONSTRAINT fk_tick_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC 单步决策归档';
```

> 清理策略：`tick_log` 每场景**最多保留最近 N=2000 行**，由调度器在每次 tick 末尾异步 prune；完整历史落冷备不在 M4.1 内。

### 3.2 **建议索引**（非强制）

若后续查询 `simulation_meta.last_tick_at` 频繁，可在 M4.1 启动前加：

```sql
ALTER TABLE npc
  ADD INDEX idx_npc_last_tick ((CAST(simulation_meta->>'$.last_tick_at' AS DATETIME)));
```

> MySQL 8.0+ 函数索引；不通过则跳过，仅降级为全表扫（NPC 量级 < 1000 可接受）。

### 3.3 迁移脚本

- 新增 `backend/src/db/migrate-engine.ts`（幂等），对应 `npm run db:migrate-engine`。
- **不修改** `npc / scene / scene_npc / ai_config / ai_call_log` 已有列。

---

## 4. `simulation_meta` v1.0 字段规范

> **软约束**：后端只做**大小 & 顶层字段白名单**校验；值本身保持 LLM 自由度。

```jsonc
{
  "version": "1.0",                    // 必填字符串
  "last_tick_at": "2026-04-20T12:34:56.789Z",  // ISO，必填
  "latest_say": "我该去码头看看了",     // 可空；气泡优先级 1
  "latest_action": "walking_to_dock",  // 可空；气泡优先级 2
  "emotion": "curious",                // 可空；六分类：neutral/happy/sad/angry/curious/scared
  "plan": ["去码头", "找老张聊船期"],   // 可空数组，<=10 项
  "memory_summary": "上午与酒保聊过…",  // M-0 主存储；<=2KB
  "relations": { "12": "朋友" },        // npcId->label，可空
  "debug": {                            // 调试面板用；生产可裁剪
    "tokens_in": 812, "tokens_out": 147, "cost_usd": 0.0012
  }
}
```

**大小阈值**

| 级别 | 阈值 | 动作 |
|------|------|------|
| 软 | 64 KB | 返回 200 + `X-Meta-Warn: soft-limit`；日志 warn |
| 硬 | 256 KB | 返回 **413 Payload Too Large**；拒绝写入 |

**气泡选择规则**（沙盒 M3.2 已有）

```
bubble = latest_say || latest_action || (emotion !== "neutral" ? emotion : null)
```

---

## 5. REST API

基础路径 `/api/engine`，全部要求 `Content-Type: application/json`。

### 5.1 `POST /api/engine/start`

启动某场景的 Tick 循环（幂等：已在跑则返回当前状态）。

**Request**

```json
{
  "scene_id": 12,
  "interval_ms": 30000,       // 可选，默认 30000，合法区间 [2000, 3600000]
  "max_ticks": 200,           // 可选，默认 null（无限）；达到后自动 stop
  "concurrency": 2,           // 可选，单 tick 内 NPC 并发推理数，默认 2，<=8
  "dry_run": false            // 可选，true 时跳过 LLM 调用，仅走图结构（自测用）
}
```

**Response 200**

```json
{ "scene_id": 12, "running": true, "tick": 0, "started_at": "...", "config": { "interval_ms": 30000, "concurrency": 2 } }
```

**错误码**

| HTTP | code | 说明 |
|------|------|------|
| 400 | `INVALID_PARAM` | `scene_id` 不存在 / `interval_ms` 越界 |
| 409 | `SCENE_BUSY` | 其它进程持有锁（M4.1 单进程，暂不触发；保留码） |
| 422 | `NO_NPC_IN_SCENE` | 场景无关联 NPC，无意义的启动 |
| 503 | `ENGINE_DISABLED` | `ENGINE_ENABLED=false` |

### 5.2 `POST /api/engine/stop`

```json
{ "scene_id": 12, "reason": "user" }   // reason: user / error / max_ticks
```

- 返回最近一次 `status` 快照；**软停**（等当前 tick 完成后退出循环）。
- `force: true` 可硬停，**立即 abort LLM 调用**（需 AbortController 支持）。

### 5.3 `GET /api/engine/status?scene_id=12`

```json
{
  "scene_id": 12,
  "running": true,
  "tick": 57,
  "last_tick_at": "...",
  "last_duration_ms": 4210,
  "npc_count": 5,
  "errors_recent": 0,
  "cost_usd_total": 0.14
}
```

### 5.4 `GET /api/engine/ticks?scene_id=12&after=42&limit=50`

- 分页读取 `npc_tick_log`，`after` 为 `tick` 游标；倒序或正序由 `order=asc|desc`（默认 `desc`）决定。
- `limit` 最大 200，默认 50。
- 返回字段与 `npc_tick_log` 一致，`output_meta` 直接透出 JSON。

### 5.5 `WS /ws/engine?scene_id=12`（可选增强）

**消息协议**（均为 JSON，客户端只读）

```jsonc
{ "type": "tick.start", "scene_id": 12, "tick": 58, "at": "..." }
{ "type": "tick.npc.updated", "scene_id": 12, "tick": 58, "npc_id": 7, "meta": { /* simulation_meta */ } }
{ "type": "tick.end", "scene_id": 12, "tick": 58, "duration_ms": 3412 }
{ "type": "error", "scene_id": 12, "tick": 58, "npc_id": 7, "message": "LLM 429" }
```

> **降级方案**：若评审认为 WS 增加复杂度，可跳过 5.5，改由前端**每 3s 轮询** `/api/engine/status` + `/api/npc?scene_id=&since=...`。

---

## 6. Tick 调度器算法

```ts
// 伪代码：scheduler.ts
class SceneScheduler {
  async tick() {
    if (this.stopping) return
    const t0 = Date.now()
    this.tickNo += 1
    bus.emit({ type: 'tick.start', scene_id, tick: this.tickNo })

    const npcs = await loadSceneNpcs(scene_id)        // 含 simulation_meta
    // 并发控制（concurrency）
    await runWithPool(npcs, this.cfg.concurrency, async (npc) => {
      const abort = new AbortController()
      const state = await buildAgentGraph().invoke({
        npc, scene, neighbors, recentTicks,
      }, { signal: abort.signal })

      await db.transaction(async tx => {
        await tx.update('npc', { id: npc.id, simulation_meta: state.nextMeta })
        await tx.insert('npc_tick_log', { ...logRow })
      })
      bus.emit({ type: 'tick.npc.updated', npc_id: npc.id, meta: state.nextMeta })
    })

    bus.emit({ type: 'tick.end', duration_ms: Date.now() - t0 })

    if (this.cfg.max_ticks && this.tickNo >= this.cfg.max_ticks) this.stop('max_ticks')
  }
}
```

**关键策略**

- **背压**：若前一次 `tick` 未完成到下一次触发时间，则**跳过**（记 `skipped` 到日志），不排队累积。
- **失败隔离**：单个 NPC 推理失败 → 记一行 `error` 到 `npc_tick_log`，**不影响**同 tick 其它 NPC，不 bubble-up 终止循环。
- **冷启**：进程重启后所有 scheduler 丢失；不自动恢复（M4.1 明确约定）。
- **锁**：`registry` 以 `sceneId` 为键互斥；同一场景仅一个 scheduler 实例。

---

## 7. LangGraph.js 推理子图

```
[loadContext] → [reflect?] → [plan] → [speak] → [persist]
                    ↑__________________|  // plan 发现信息不足时可回 reflect，最多 1 次
```

**节点说明**

| 节点 | 输入 | 输出 | LLM 调用 | 失败策略 |
|------|------|------|----------|-----------|
| `loadContext` | `npc, scene, neighbors` | `ctx: string` | ❌ 纯读 | throw → 整 tick 标 `error` |
| `reflect` | `ctx + memory_summary` | `reflection: string` | ✅ 可选 | 失败降级为空串 |
| `plan` | `ctx + reflection` | `plan: string[]` | ✅ | 失败返回旧 `plan` |
| `speak` | `plan[0], personality` | `{latest_say, latest_action, emotion}` | ✅ | 失败写 `null` |
| `persist` | 全部产出 | `nextMeta` | ❌ | 事务失败整 tick 回滚 |

**提示词模板**（版本化放在 `graph/prompts/*.md`）

- `system.md`：公共前缀（角色扮演规则、输出 JSON 规范）。
- `plan.md` / `speak.md`：节点各自模板；通过 `{{handlebars}}` 注入 `npc.name`、`npc.personality`、`ctx` 等。
- **输出 JSON 强约束**：使用 `z.object({...}).strict()`（zod）+ LLM `response_format: json_object`；解析失败则**重试 1 次**后降级。

---

## 8. 前端改动（沙盒）

| 位置 | 改动 | 备注 |
|------|------|------|
| `Sandbox.vue` 顶部工具栏 | 新增 **运行控制条**：▶ 开始 / ⏸ 暂停 / ⏭ 单步 / 速率选择 | 只有 `scene_id` 非空时可用 |
| `Sandbox.vue` 节点气泡 | 复用 M3.2 气泡轮询；轮询 URL 从 `/api/npc?scene_id=` 切到 `/api/engine/ticks?scene_id=&after=` | 命中率更高、带宽更省 |
| `frontend/src/api/engine.ts` | **新建**：`startEngine / stopEngine / getStatus / getTicks` | |
| 类型 `frontend/src/types/engine.ts` | **新建**：`EngineStatus / TickEvent / SimulationMetaV1` | |

> **不改** `SceneForm / NpcForm / SceneList / NpcList`。

---

## 9. 配置与运行

### 9.1 新增环境变量（`backend/.env`）

```
ENGINE_ENABLED=true
ENGINE_DEFAULT_INTERVAL_MS=30000
ENGINE_MAX_CONCURRENCY=8
ENGINE_DRY_RUN=false
ENGINE_LOG_RETENTION=2000
```

### 9.2 本地联调

```bash
cd backend
npm run db:migrate-engine
npm run dev

curl -X POST localhost:3000/api/engine/start \
  -H 'Content-Type: application/json' \
  -d '{"scene_id":1,"interval_ms":5000,"max_ticks":3,"dry_run":true}'
```

---

## 10. 测试矩阵

### 10.1 单测（Vitest，**不打真 LLM**）

| 层 | 文件（建议） | 用例重点 |
|----|--------------|----------|
| scheduler | `scheduler.test.ts` | start/stop 幂等；背压跳过；max_ticks 自停；单 NPC 失败不扩散 |
| graph | `build.test.ts` | 节点连边正确；dry_run 走通全图；zod 解析失败重试后降级 |
| api | `engine.controller.test.ts` | 400/409/422/503 错误码；分页游标；status shape |
| meta | `meta.size.test.ts` | 软 / 硬阈值行为；version 缺失补默认 |

### 10.2 集成 smoke（**打 LLM**，CI 外，需 `.env.local`）

- 场景 `S1` 含 2 个 NPC，`interval_ms=5000`，`max_ticks=3`；
- 断言：3 次 tick 后 `simulation_meta.latest_say` 均有值，`npc_tick_log` 行数 = 6，`ai_call_log` 行数 ≥ 6。

### 10.3 不做

- 压测 / 负载 / 跨进程一致性。

---

## 11. 可观测性

- **复用** `ai_call_log`：`source='engine'`、`context={scene_id, tick, npc_id, node}`；无需新表。
- 新表 `npc_tick_log` 作为面向**用户视角**的事件流（前端「时间线」可直接读它）。
- 前端可选加一个**极简时间线抽屉**（不在 M4.1 默认范围，仅预留 UI 钩子）。

---

## 12. 风险 / 取舍

| 风险 | 说明 | 缓解 |
|------|------|------|
| LLM 费用失控 | 5 NPC × 2 min × 8h ≈ $1-3/天（gpt-4o-mini） | 默认 `interval_ms=30000`；`max_ticks` 必填建议；`status.cost_usd_total` 前端高亮 |
| Node 事件循环阻塞 | LangGraph 节点阻塞导致整进程卡顿 | 每 NPC 推理**独立 await**；`AbortController` 硬停；禁用同步 DB 连接 |
| 同场景并发写 `simulation_meta` | 多 NPC 同时写入 | `persist` 节点每 NPC 独立事务，按 `npc_id` 单行更新无冲突 |
| 气泡闪动 | tick 间隔 > 轮询间隔时可能出现空值 | 前端维持上一个非空值 N 秒 |
| 冷启丢失运行态 | 进程崩溃后不恢复 | M4.1 不处理；文档明确告知；M4.2 再考虑 `engine_session` 表 |

---

## 13. 里程碑拆分（M4.1 内部）

| 代码 | 任务 | 预估 |
|------|------|------|
| **M4.1.a** | 数据迁移 + `engine/` 骨架 + `/start /stop /status` + `dry_run` 全流程 | 2 天 |
| **M4.1.b** | LangGraph 子图（plan/speak/persist）+ `npc_tick_log` + `/ticks` | 3 天 |
| **M4.1.c** | 前端沙盒运行控制条 + 气泡数据源切换 | 2 天 |
| **M4.1.d** | 单测 / smoke / 文档 / 阈值微调 | 2 天 |

> 总计约 **9 人·日**（不含评审 & buffer）。

---

## 14. 验收清单（Definition of Done）

- [ ] `npm run db:migrate-engine` 幂等通过；
- [ ] `POST /engine/start` 在 `dry_run=true` 下写入 3 行 `npc_tick_log` 而**不触发任何** `ai_call_log`；
- [ ] 真 LLM 跑通一个 2 NPC × 3 tick 场景，`simulation_meta.latest_say` 非空；
- [ ] 软阈值 64KB 的 `simulation_meta` 可写入且带 `X-Meta-Warn`，硬阈值 256KB 被 413 拒绝；
- [ ] 前端沙盒「▶」按钮能启动 / 气泡实时更新 / 「⏸」能软停；
- [ ] 所有新接口覆盖错误码单测，CI 绿；
- [ ] 文档同步更新 README 与 `requirements-character-scene.md` §13 状态。

---

## 15. 评审投票模板

| 反馈人 | 形态（A 同进程 / B 独立 Python） | API 表（§5） | 字段规范（§4） | 测试矩阵（§10） | 其它意见 |
|--------|----------------------------------|---------------|-----------------|------------------|-----------|
|        |                                  |               |                 |                  |           |

---

## 附：与选型报告的字段对齐

| 本文档 | `engine-selection.md` |
|--------|------------------------|
| §4 字段规范 | §5.3 simulation_meta 建议 |
| §5 REST API | §5.2 API 草案 |
| §6 调度器 | §5.4 Tick 调度器 |
| §7 LangGraph 图 | §3.2 C2 / §5 推荐方案 |
| §13 里程碑 | §6 与已有里程碑衔接 |
