# M4.1.d 真 LLM Smoke Test —— 运行手册

> 目的：在本地跑一次"真 LLM × 多 NPC × 多 tick"的端到端验证，确认
> M4.1.a（骨架）/ M4.1.b（推理图）/ M4.1.c（前端控制条）三件套在生产路径下
> 成功闭环。验收通过后 M4.1 完成。

---

## 1. 前置条件（只做一次）

### 1.1 数据库已建表

```bash
# backend/
npm run db:migrate-scene     # scene / scene_npc
npm run db:migrate-engine    # npc_tick_log
```

已跑过可跳过（脚本幂等）。

### 1.2 至少 1 份可用的 ai_config

前往前端「AI 配置」页，保存一份 OpenAI 兼容配置：

- `provider` / `base_url` / `api_key` / `model` 均已填
- 点击"测试连接"成功 → 拿到 `ai_config_id`

### 1.3 至少 2 个 NPC 已绑定 ai_config

前往前端「NPC 列表」：

- 新建 2 个 NPC，填 `personality`、`system_prompt`
- 每个 NPC 的 `ai_config_id` 选中 1.2 里那份配置

### 1.4 至少 1 个场景，且关联这 2 个 NPC

前往前端「场景 · 沙盒」：

- 新建场景 → 设置 `width/height`
- 在关联 NPC 列表里把刚才的 2 个 NPC 加进去
- 记下场景 ID（URL 或列表里可见）

---

## 2. 启动后端

```bash
# backend/
npm run dev
```

新开一个终端跑 smoke；或前端（另开 `frontend && npm run dev`）与 smoke 并行观察。

---

## 3. 一键 Smoke（推荐）

```bash
# backend/
npm run smoke:engine -- --scene=<场景ID> --ticks=3 --interval=5000 --concurrency=2
```

常用参数：

| 参数              | 默认值                    | 说明                          |
| ----------------- | ------------------------- | ----------------------------- |
| `--scene=<id>`    | 必填                      | 场景 ID                       |
| `--ticks=<N>`     | 3                         | 最大 tick 数（用 `max_ticks`）|
| `--interval=<ms>` | 5000                      | tick 间隔                     |
| `--concurrency=N` | 2                         | 同 tick 内并发 NPC 数         |
| `--base=<url>`    | `http://localhost:3000`   | 后端 Base URL                 |
| `--dry-run`       | 关闭                      | 只跑 dry_run（不打 LLM）      |
| `--timeout=<s>`   | 300                       | 全局超时                      |

### 3.1 脚本做了什么

1. 健康检查 + 场景/NPC/ai_config 合法性核验
2. 记录基线 `tick_log.max(tick)`
3. `POST /api/engine/start`（live / dry_run 可切）
4. 每 2s 轮询 `/api/engine/status` 直到 `running=false` 或超时
5. 拉取本轮新增的 `npc_tick_log` 与 `ai_call_log`
6. 打印表格 + 汇总，并给出 `PASS / WARN / FAIL` 结论

### 3.2 看到什么算通过

示例（2 NPC × 3 tick）：

```
  Tick  │ NPC │ Status  │ Duration │ latest_say / error
  ──────┼─────┼─────────┼──────────┼─────────────────────
  1     │ 10  │ success │ 3.42s    │ 你好，老李，今天去西市吗？
  1     │ 11  │ success │ 3.18s    │ 去啊去啊，顺便买点酒
  ...
───────── 汇总 ─────────
  tick_log 新增:       6 行（3 个 tick，预期 6）
  success / error:     6 / 0
  latest_say 非空:     6 / 6
  ai_call_log 命中:    18（success=18, error=0, 平均 3.20s）
  ai_call_log 分节点:  engine.plan=6 / engine.speak=6 / engine.memory=6
🟢 Smoke 结论：PASS   (完成率 100%)
```

核心阈值：

- `success / 预期` ≥ **80 %** → PASS；≥ 1 条成功且有失败 → WARN；全错 → FAIL
- `latest_say` 非空率 ≥ 1（至少有一条真 LLM 产文）
- `ai_call_log` 分节点都应 ≥ 1（plan / speak / memory 都被触发）

---

## 4. 手动 curl 最小化验证（备选）

如果脚本不方便，可以手工调 REST：

```bash
# 启动
curl -sS -X POST http://localhost:3000/api/engine/start \
  -H "Content-Type: application/json" \
  -d '{"scene_id":1,"max_ticks":3,"interval_ms":5000,"concurrency":2,"dry_run":false}'

# 轮询
curl -sS "http://localhost:3000/api/engine/status?scene_id=1"

# 查看最近 tick
curl -sS "http://localhost:3000/api/engine/ticks?scene_id=1&limit=20&order=desc"

# 查看 plan / speak / memory LLM 调用
curl -sS "http://localhost:3000/api/ai-logs?source=engine.plan&pageSize=50"
curl -sS "http://localhost:3000/api/ai-logs?source=engine.speak&pageSize=50"
curl -sS "http://localhost:3000/api/ai-logs?source=engine.memory&pageSize=50"

# 停
curl -sS -X POST http://localhost:3000/api/engine/stop \
  -H "Content-Type: application/json" -d '{"scene_id":1}'
```

---

## 5. 常见失败与排查

| 症状                                               | 原因                                           | 处置                                                                  |
| -------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| `400 NO_NPC_IN_SCENE`                              | 场景下无关联 NPC                               | 前端场景详情绑定至少 1 个 NPC                                         |
| `status=error` + `该配置未设置 API Key`            | ai_config 的 api_key 未填                      | AI 配置页补 key 后"测试连接"                                          |
| `status=error` + `HTTP 401/403`                    | api_key 错 / 额度耗尽                          | 换 key 或另选模型                                                     |
| `latest_say` 经常为空                              | 模型返回非 JSON，retry 后仍失败（已降级写入）  | 查看 ai_log 的 response_content；或把 speak/plan 的 temperature 调低 |
| `status=error` + `plan 字段类型错`                 | Zod 校验未过：模型输出偏离 schema              | 看 prompts.ts 的 JSON 示例，或切换到更听话的 model                    |
| `simulation_meta 超过硬阈值`                       | 单次产出过长                                   | 下调 memory_summary 长度 / 或在 prompts 强调 "≤ 400 字"               |
| smoke 轮询超时                                     | LLM 慢 / 网络慢                                | 加 `--timeout=600` 或 `--interval=10000`                              |
| `pool did not resolve within N seconds`（后端日志）| DB 连接池耗尽（并发 × tick 数过高）            | 降 `--concurrency`，或升 `DB connectionLimit`                        |

---

## 6. 验收 Checklist

- [ ] `npm run smoke:engine` 输出 `🟢 PASS`
- [ ] `ai_call_log` 中能看到 `engine.plan / engine.speak / engine.memory` 三类条目
- [ ] `npc_tick_log` 中 `output_meta.latest_say` 为真实中文对白（非占位）
- [ ] `npc.simulation_meta` 被更新为最后一 tick 的产出（前端气泡自动刷新）
- [ ] 前端「沙盒 · 引擎」控制条：`dry_run=off + 5s + 启动` 后气泡自动更新
- [ ] 后端 log 无未捕获异常栈；`pool` 无连接泄漏警告

全部勾上即 M4.1.d 通过，M4.1 整体完结，进入 M4.2（记忆向量化 / 循环 / 反思 / 事件）规划。
