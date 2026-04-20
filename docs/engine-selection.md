# M4 主仿真 / 运行时引擎选型文档

| 文档版本 | 日期 | 说明 |
|---------|------|------|
| 0.1 | 2026-04-20 | 初稿：承接《需求文档：人物与场景》§1.4 与附录 A，给出候选清单、评估矩阵、推荐方案与集成设计；**待评审** |

> 关联：本文档是 `docs/requirements-character-scene.md` §1.4「主引擎未选定」的**落地评估**。阅读本文前建议先通读该需求文档的 §0（范式对齐）、§1.4、§6（数据模型）、附录 A。

---

## 0. 摘要（TL;DR）

- **目标**：在 AINPC 已有「人物 / 场景 / 多对多关联 / 2D 沙盒布局 / `simulation_meta` 预留字段」的基础上，选定一个**驱动多智能体运行时**（推进时间、调用 LLM、写回记忆与状态）的「**主引擎**」，把 AINPC 从**配置 / 编辑态**带入**演绎 / 运行态**。
- **推荐**（本稿）：**阶段 1** 采用 **「AINPC 内置轻量 Tick 引擎 + LangGraph 作为智能体推理工作流」** 的**组合形态**，**无空间引擎**，全部复用现有 REST + `simulation_meta`；**阶段 2** 在需要真 2D / 路径寻路 / 事件物理时再引入 **Phaser 3 前端 tick**（复用现沙盒）或外置 **Godot / Unity**。
- **原因**：在 v0.x 范围内，**空间仿真**的诉求（路径寻路、碰撞、动画）**并不强**；**可信行为**的瓶颈在**记忆 / 反思 / 计划**链路与**提示工程**上，优先由后端工作流驱动；保持**与 AINPC 解耦**、**进程边界清晰**、**JSON 回写**这三原则（见 §1.4）。
- **不推荐当前引入**：游戏引擎（Unity/Unreal/Godot）、论文原仓完整复现（`joonspk-research/generative_agents`，重依赖、演示向）、工作流工具（n8n/Dify，长时运行与复杂状态难）。

---

## 1. 范围与非目标

### 1.1 范围

- **引擎形态**的候选清单与评估；
- 与 AINPC 的**进程边界、同步方式、`simulation_meta` 字段约定**；
- 为 **M4** 启动提供充分的决策依据（可直接作为立项输入）。

### 1.2 非目标

- **不承诺**具体版本号 / 商业授权 / 云成本的终稿；以社区当时状态为准。
- **不包含**具体小镇地图、像素素材、行为树等**内容**设计；那是引擎启动后的工作。
- **不替代**需求文档 §4～§7 的数据 / API 规范；本文档**不**修改已有字段 / 接口。

---

## 2. 评估维度（决策矩阵）

> **权重仅供参考**，请在评审会上按团队现状重新定权。

| # | 维度 | 权重建议 | 说明 |
|---|------|-----------|------|
| D1 | **与 AINPC 解耦难度** | 15% | 能否不修改 AINPC 核心表就对接？`simulation_meta` 回写是否足够？ |
| D2 | **LLM / 多智能体推理质量** | 15% | 记忆流、反思、计划链路是否原生支持或易于接入 |
| D3 | **空间语义（可选）** | 10% | 是否支持路径寻路 / 碰撞 / 动画；v0.x **暂不强要求** |
| D4 | **前端可视化复用** | 10% | 是否能复用当前 Phaser 沙盒，避免从 0 造 UI |
| D5 | **开发门槛与团队栈** | 15% | 现有 Node/Vue/TS 栈延续性，学习成本 |
| D6 | **长时运行 / 状态持久** | 10% | 支持小时 / 天级连续运行，状态可持久化与回滚 |
| D7 | **可观测性（日志 / 回放）** | 5% | trace、回放、审计；调试链路友好度 |
| D8 | **运维 / 部署** | 10% | 单机 Docker → 集群复杂度；是否需要额外中间件 |
| D9 | **授权 / 依赖 / 成本** | 5% | 开源 / 商业；外部 API 与硬件成本 |
| D10 | **演进可替换性** | 5% | 若未来更换引擎，沉没成本 |

**评分说明**：每项 1–5 分（5 为最适合）。**总分 ≥ 3.6** 视为可立项；主备梯队看 §4.5。

---

## 3. 候选项详评

### 3.1 **C1 - AINPC 内置轻量 Tick 引擎**（Node/TS，后端态）

**形态**：在 AINPC 后端新增 `engine/` 模块，以**固定节拍**（默认 30s / tick）遍历启用场景下的 NPC；每 tick 为每个 NPC 调用 LLM 产生 `{latest_say, latest_action, memory_delta}`，再写回 `npc.simulation_meta`。

- **优点**：**零部署增量**（已有 Node 进程）、**最小改动**、完全掌握链路；沙盒气泡即可直接可视化。
- **缺点**：多智能体推理质量需**手写**记忆流 / 反思 / 计划 / 冲突解决；**无空间**；单进程扩展性有限。
- **适合**：验证范式、对接 UI 气泡、做演示；**不适合**大规模或严苛研究。
- **与 AINPC 关系**：同进程，零接口边界（内部模块）。

> 评分建议（团队 Node 栈）：D1=5 / D2=3 / D3=1 / D4=4 / D5=5 / D6=3 / D7=3 / D8=5 / D9=5 / D10=4 → **~3.9**

### 3.2 **C2 - LangGraph（推理工作流）+ C1 Tick**

**形态**：推理**子链**由 LangGraph 编排（记忆检索 → 反思 → 计划 → 发言）；C1 只负责节拍与 DB 读写。

- **优点**：**开箱即有**的状态图 / checkpoint / human-in-the-loop；Python 或 JS 双栈可选（LangGraph.js）；**替换 LLM 供应商**方便。
- **缺点**：多 NPC 并发时需自行做并发控制；Python 栈需新增服务（JS 栈仍可 Node 内）。
- **适合**：希望**工作流可视可调试**、**后续替换推理厂商**。
- **与 AINPC 关系**：若选 **LangGraph.js** 则可同进程；若 **Python** 则独立服务，通过 **HTTP 轮询 + Webhook** 回写 `simulation_meta`。

> 评分建议：D1=4 / D2=5 / D3=1 / D4=4 / D5=4 / D6=4 / D7=5 / D8=4 / D9=4 / D10=5 → **~4.0**

### 3.3 **C3 - AutoGen / CrewAI / Semantic Kernel Agents**

**形态**：以「**多智能体协作 / 角色分工**」为核心的框架；适合**任务型**对话（多代理打配合、工具调用）。

- **优点**：角色分工、工具调用、辩论 / 投票原语**成熟**。
- **缺点**：**长期在线 / 同场次生活**不是核心目标；需自行搭时间轴与场景驱动。
- **适合**：**任务剧本**类场景（C2 也能做但这里更顺手）；不适合**长期生活式**仿真。

### 3.4 **C4 - 论文原仓 `joonspk-research/generative_agents`**

**形态**：**Stanford 原论文**提供的 Unity + Python 演示仓库（像素小镇），需较多二次开发才能工程化。

- **优点**：与范式**完全贴合**；自带记忆流 / 反思 / 计划实现可参考。
- **缺点**：**演示向**，工程化需求（多租户、鉴权、审计）缺；Unity 项目维护成本；资源与素材独占。
- **适合**：**研究 / 复现实验**；不适合**生产内嵌**。
- **与 AINPC 关系**：作为**独立进程**运行，通过适配层 pull `npc`/`scene` 数据、push `simulation_meta` 回写。

### 3.5 **C5 - Phaser 3 前端 Tick（浏览器态）**

**形态**：**复用当前沙盒**，把每 tick 的决策在浏览器里触发（直接调 LLM 或让后端代理），显示实时气泡与位移动画。

- **优点**：**复用**现有 800×600 沙盒与节点拖拽；**无需新部署**；对接容易。
- **缺点**：浏览器关窗 / 离线即停；**敏感 Key** 不宜前端持有（需 BFF）；多客户端一致性问题。
- **适合**：**展示 / 内部 Demo**；不适合**长时在线**或多人同观察。
- **与 AINPC 关系**：前端直接用 REST + 新增 `/api/chat` 代理；状态仍回 `simulation_meta`。

### 3.6 **C6 - 游戏引擎：Unity / Godot / Unreal**

**形态**：独立游戏客户端，内嵌 NPC 行为与可视化；通过 HTTP/WebSocket 与 AINPC 同步。

- **优点**：**空间仿真**完备（寻路、动画、碰撞），美术表现力最强。
- **缺点**：**门槛最高**（C#/GDScript/C++）；迭代周期 5×～10× 于 Node；对当前团队栈外扩大。
- **适合**：**3D/强交互**长期产品；**不适合** v0.x / 当前目标。

### 3.7 **C7 - 工作流 / 低代码（Dify / n8n / Make）**

**形态**：可视化拖拽工作流，串联 LLM、HTTP、定时器。

- **优点**：**上手快**、非程序员可参与；Dify 自带对话状态管理。
- **缺点**：**长时记忆 / 复杂决策 / 调试** 不如代码；**与 AINPC 表结构**的读写需编写自定义节点；版本管理较弱。
- **适合**：**PoC / 原型**；**不适合**稳定在线引擎。

---

## 4. 对比矩阵（权重 §2；分数基于团队当前 Node/Vue/TS 栈）

| 候选 | D1 | D2 | D3 | D4 | D5 | D6 | D7 | D8 | D9 | D10 | **总分** | 梯队 |
|------|----|----|----|----|----|----|----|----|----|----|---------|------|
| **C1 内置 Tick** | 5 | 3 | 1 | 4 | 5 | 3 | 3 | 5 | 5 | 4 | **3.9** | **主推阶段 1** |
| **C2 LangGraph + C1** | 4 | 5 | 1 | 4 | 4 | 4 | 5 | 4 | 4 | 5 | **4.0** | **主推阶段 1** |
| C3 AutoGen/CrewAI | 4 | 4 | 1 | 3 | 4 | 3 | 4 | 4 | 4 | 4 | ~3.5 | 备选（任务型） |
| C4 论文原仓 | 2 | 5 | 4 | 2 | 2 | 2 | 3 | 2 | 3 | 2 | ~2.8 | 研究向，不生产 |
| C5 Phaser 前端 Tick | 5 | 3 | 2 | 5 | 5 | 2 | 3 | 5 | 5 | 4 | ~3.7 | **Demo 辅助** |
| C6 Unity/Godot/Unreal | 2 | 3 | 5 | 2 | 1 | 4 | 3 | 2 | 3 | 1 | ~2.6 | 远期（3D） |
| C7 Dify/n8n | 4 | 3 | 1 | 3 | 4 | 2 | 2 | 3 | 4 | 3 | ~2.9 | PoC 可用 |

### 4.5 梯队结论

- **阶段 1（M4.1，现在可立项）**：**C1 + C2**（LangGraph.js 内置 **或** Python 独立服务）为主，**C5** 作为前端 Demo 补位。
- **阶段 2（M4.2，视需求）**：空间诉求明确后引入 **C6-Godot** 或升级到 **C4 派生仓**。
- **长期不建议**：C4 完整搬迁、Unity 新项目。

---

## 5. 推荐方案：C1 + C2 组合（阶段 1）

### 5.1 架构总图

```
┌──────────────────┐   HTTP(REST)     ┌───────────────────────────┐
│  前端（Vue 3）   │ ───────────────► │    AINPC 后端（Node/TS）  │
│  沙盒 Tab (Phaser)│ ◄──────────────  │  ─────────────────────    │
│  气泡 / 位移     │     ②            │  routers: scene / npc /   │
└──────────────────┘                  │           engine(新)      │
         ▲                            │  ─────────────────────    │
         │ ③ WebSocket / 轮询         │  engine/                   │
         │                            │    ├─ scheduler (tick)     │
         │                            │    ├─ graph (LangGraph.js) │
         │                            │    └─ memory / prompt      │
         │                            │  ─────────────────────    │
         │                            │        ┌───────┐           │
         │                            │        │ MySQL │←━━━━━━━┓  │
         │                            │        └───────┘   ①    ┃  │
         │                            └───────────────────────── ┃  │
         │                                                       ┃  │
         └── 外部 LLM 供应商（可切换） ◄────────── chat / embed ━━┛  │
                                                                 ┗━━┘
```

- ① **数据层不变**：仅新增 `engine` 模块读写 `simulation_meta`，与 §6.3 字段约定一致。
- ② **REST 不变**：前端只需增加一个 `/api/engine/...` 系列用于**开/停/查看状态**（见 §5.3）。
- ③ **实时推送**（可选）：`WebSocket /ws/engine` 或短轮询 `GET /api/engine/ticks`，避免沙盒气泡依赖 5 秒轮询。

### 5.2 进程边界（两种部署形态）

| 形态 | 描述 | 何时选 |
|------|------|--------|
| **形态 A：同进程（推荐）** | `engine/` 即 AINPC 后端的一个模块；与路由共用 `pool`；启停通过 `/api/engine/start?scene_id=` | **Node/TS 团队**，使用 **LangGraph.js**；最低运维 |
| 形态 B：独立服务（Python） | 单独 `ainpc-engine/`（Python + LangGraph）；通过 HTTP 拉 `npc/scene`，Webhook 回写 | 已有 Python 栈 / 需 GPU 本地模型 / 多租户隔离 |

> **默认选 A**。若未来引入向量库 / GPU 推理，再拆 B。

### 5.3 新增 API 草案（工程师接入清单）

> **不替代**需求文档 §7；是 §7 的**新增子集**。响应仍遵循 `code/message/data`。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/engine/start` | 入参 `{scene_id, interval_ms?, max_ticks?}`；启动该场景的 tick 循环 |
| POST | `/api/engine/stop` | 入参 `{scene_id}`；停止 |
| GET | `/api/engine/status?scene_id=` | 返回 `{running, tick, last_tick_at, cost?}` |
| GET | `/api/engine/ticks?scene_id=&after=` | 拉取最近 tick 事件（可替代 WebSocket） |
| WS | `/ws/engine?scene_id=` | （可选）实时推送 tick 事件与 `simulation_meta` 变更 |

### 5.4 `simulation_meta` 字段**建议规范**（非强制）

> 与《需求文档》§12 ⑶ 一致：**自由 JSON**，不强制 Schema。下列**仅推荐**，便于沙盒气泡与未来引擎互认。

```json
{
  "version": "1.0",
  "last_tick_at": "2026-04-20T16:00:00Z",
  "latest_say": "嗨，今天要做什么？",
  "latest_action": "走向市集",
  "emotion": "curious",
  "plan": [
    { "time": "10:00", "action": "开摊" },
    { "time": "12:00", "action": "与邻居闲聊" }
  ],
  "memory_summary": "昨天见到主人公，留下好印象。",
  "debug": {
    "prompt_hash": "sha256-...",
    "model": "gpt-4o",
    "tokens_in": 1234,
    "tokens_out": 210
  }
}
```

**约定**：
- **气泡读取优先级**：`latest_say` → `latest_action`（已实现，见 v0.9 沙盒）。
- `last_tick_at` 为 ISO8601，便于前端显示"更新于 X 前"。
- `debug.*` 仅后台查看，前端默认不展示。
- **大小建议上限 64KB**（后端软校验即可，见 §8.3）。

### 5.5 Tick 调度器（关键算法草案）

```pseudo
on start(scene_id, interval, maxTicks):
  stop_previous(scene_id)
  tick = 0
  timer = setInterval(async () => {
    tick++
    scene = await load_scene(scene_id)
    npcs = scene.npcs
    for npc in npcs  (concurrency = min(5, npcs.length)):
      ctx = build_context(scene, npc)          // 场景描述 + 角色人设 + 最近记忆
      out = await langgraph.run(ctx)           // 返回 {say, action, memory_delta, plan?}
      meta = merge(npc.simulation_meta, out, { last_tick_at: now })
      await update_npc_simulation_meta(npc.id, meta)
      publish_ws('tick', { scene_id, npc_id, meta })
    if maxTicks && tick >= maxTicks: stop(scene_id)
  }, interval)
```

- **并发**：单场景内 NPC 并发；跨场景可各自独立 timer。
- **失败处理**：单 NPC 失败不影响同 tick 其他 NPC；连续失败 3 次跳过该 NPC 直到下次 start。
- **冷热**：停止引擎不擦除 `simulation_meta`，便于回顾。

### 5.6 记忆流实现选择（影响 §5.5 的 `build_context`）

| 形态 | 说明 | 适合阶段 |
|------|------|----------|
| **M-0 仅摘要** | 每 tick 让 LLM 自行摘要并保留最新 N 条，存到 `memory_summary` | **阶段 1 默认** |
| M-1 JSON 记忆数组 | `simulation_meta.memories: [{t, event, weight}]`，最近 K 条入 prompt | 过渡 |
| M-2 向量库 | 额外 Pinecone / Qdrant 等；按相似度召回 | 阶段 2 |

---

## 6. 与已有里程碑的衔接

| 里程碑 | 关系 |
|--------|------|
| M1 / M2 | 完全复用，无需改动 |
| M3.1 / M3.2 / M3.3 | 沙盒继续使用现有 `/api/scene/:id` + `simulation_meta.latest_say/action`；**气泡开关即可直接展示引擎输出** |
| **M4.1** | **本文档的立项范围**：C1 Tick + C2 LangGraph.js 同进程，新增 `/api/engine/*` |
| M4.2（可选） | 空间语义需求明确后：前端 Phaser 动画节点 / 独立 Godot 客户端；M4.1 的 API 保持兼容 |

---

## 7. 非功能与风险

### 7.1 成本

- **LLM 调用**：按 5 NPC × 每 30s 1 次 tick × 8 小时 ≈ 4800 次/天。若 `gpt-4o-mini`（~1k token）级别，折日约 $1～$3；`gpt-4o` 则显著增加。**需要 per-scene 预算**（§8.2 建议）。
- **开发投入**：形态 A 预估 2 人周（后端 Tick + LangGraph 接入 + WS + 最小 UI）。

### 7.2 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| LLM 漂移 / 幻觉 | 气泡不合逻辑 | prompt 固化 + 自测样本 + human-in-the-loop |
| Token 失控 | 成本飙升 | per-scene 预算 / tick 上限 / 降级到小模型 |
| 进程内长任务阻塞 | Node 事件循环变慢 | 并发控制 + 拆 worker 线程 |
| 多端并发改 `simulation_meta` | 丢失写入 | 单写者（引擎）+ 读者（前端 / 管理端）模式 |
| 引擎换型 | 已落地数据绑定 | `simulation_meta` 自由 JSON + 推荐规范；引擎实现可替换 |

### 7.3 安全

- `/api/engine/*` 应与未来鉴权一体化（§3 用户角色目前为初稿）。
- **外部 LLM Key** 保存在后端 `.env` / secrets，**前端永不持有**；沿用现有 AI 配置表约定。

---

## 8. 规格微调建议（可选，短小）

> 为让 M4 引擎接入更顺畅，可在启动 M4 前后做以下**小补丁**（与本文档解耦，未决策也可）。

### 8.1 索引与查询

- `simulation_meta` JSON 虽自由，若要**按 `last_tick_at` 排序找僵尸 NPC**，可考虑在 MySQL 对 `JSON_EXTRACT(simulation_meta, '$.last_tick_at')` 建**生成列 + 索引**。

### 8.2 预算字段

- `scene` 表扩展可选字段（非必要）：
  - `engine_interval_ms INT DEFAULT 30000`
  - `engine_token_budget INT DEFAULT NULL`
  - `engine_enabled TINYINT(1) DEFAULT 0`

### 8.3 大小软校验

- 后端 `updateNpc` 时增加 `simulation_meta` 序列化后 **> 64KB** 告警（不阻断）；**超 256KB** 拒收。

### 8.4 前端开关入口

- 沙盒 Tab 工具栏追加「**运行引擎**」按钮（开 / 停）；状态气泡无需改动；进入 M4.1 后生效。

---

## 9. 决策流程与时间线

| 节点 | 内容 | 产出 |
|------|------|------|
| T+0 | 本稿评审 | 《选型会议纪要》+ 决策人签字 |
| T+3 | 立项 M4.1 | `docs/engine-integration-m4.1.md`（实现细设） |
| T+2w | M4.1 Alpha | `/api/engine/*` + 单场景 Demo + `simulation_meta` 规范字段落库 |
| T+4w | M4.1 Beta | WS 推送 + 多场景调度 + 预算上限 + 监控 |
| T+6w | M4.1 GA | 文档更新、单测 / 集成测、压测 |
| T+8w | M4.2 预研 | 视需求决定是否引入空间引擎（C6/C4 派生） |

---

## 10. 评审投票模板（贴到会议纪要即可）

> 请各位评审人在下表填分（1–5）与一句话理由。**总分加权按 §2** 自动计算，最终决策由产品负责人在会上收口。

| 评审人 | 角色 | 推荐主方案 | 推荐备选 | 拒绝候选 | 关键关切 |
|--------|------|------------|---------|---------|---------|
|   |   | □ C1+C2（A） □ C1+C2（B） □ C5 □ 其它 | | | |

---

## 11. 参考

- 《需求文档：人物与场景（AINPC）》§1.4、附录 A（`docs/requirements-character-scene.md`）
- Generative Agents: *Interactive Simulacra of Human Behavior*（Park et al., 2023）
- LangGraph 官方文档（JS / Python）
- AutoGen / CrewAI / Semantic Kernel Agents 社区资料
- `joonspk-research/generative_agents`（原论文演示仓）

---

*本文档**评审通过**后，将在 `README.md` 的里程碑小节追加 M4.1 条目，并拆分《引擎集成细设》作为下一份输入。*
