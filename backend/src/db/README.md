# 数据库迁移说明

## 初始化

```bash
npm run db:init
```

执行 `schema.sql`：创建 `ai_config`、`npc`、`ai_call_log`（若不存在）。

## 增量迁移（按需）

| 命令 | 说明 |
|------|------|
| `npm run db:migrate-npc-fields` | 为旧版 `npc` 表补充 gender、age、occupation、voice_tone |
| `npm run db:migrate-ai-log` | 创建 `ai_call_log`（若尚未由 init 创建） |
