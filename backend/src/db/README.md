# 数据库迁移说明

## 初始化

首次部署时执行：

```bash
npm run db:init   # 执行 schema.sql 创建基础表结构
```

## 迁移脚本执行顺序

按以下顺序执行迁移（已执行过的可跳过）：

1. `npm run db:migrate-npc` - NPC 表及字段
2. `npm run db:migrate-conversation` - 对话与会话消息
3. `npm run db:migrate-npc-fields` - NPC 扩展字段
4. `npm run db:migrate-memory` - 记忆表
5. `npm run db:migrate-memory-embedding` - 记忆 embedding 支持
6. `npm run db:migrate-map` - 地图与 NPC 地图绑定
7. `npm run db:migrate-ai-log` - AI 调用日志
8. `npm run db:migrate-item` - 物品及地图物品绑定

## 职责划分

- **schema.sql**：基础表结构，供 init 使用
- **migrate-*.ts**：增量迁移，补充字段或新表，需幂等
