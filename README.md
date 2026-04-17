# AI 配置模块

管理多平台 AI 模型配置的前后端应用，支持 OpenAI、Claude、通义千问、文心一言、智谱等。

## 技术栈

- **前端**: Vue 3 + Vite + TypeScript + Element Plus
- **后端**: Node.js + Express
- **数据库**: MySQL（`ai_config`、`npc`；可选 `ai_call_log`）

## 快速开始

### 1. 数据库

```bash
cd backend
cp .env.example .env
# 编辑 .env 填写 MySQL 连接信息
npm install
npm run db:init
```

若已有旧库但缺少 NPC 扩展字段，可执行：

```bash
npm run db:migrate-npc-fields
```

需要 AI 调用日志表时：

```bash
npm run db:migrate-ai-log
```

### 2. 启动后端

```bash
cd backend
npm run dev
# http://localhost:3000
```

### 3. 启动前端

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
# http://localhost:5173
```

## API 接口

| 方法 | 路径 | 说明 |
|-----|------|-----|
| GET/POST/PUT/DELETE/PATCH | /api/config | AI 配置 |
| GET/POST/PUT/DELETE | /api/npc | NPC |
| POST | /api/upload/avatar | 上传头像 |
| GET | /api/ai-logs | AI 调用日志 |

## 配置字段说明

- **name**: 配置名称
- **provider**: 提供商（OpenAI、Claude 等）
- **api_key**: API Key（新增必填，列表/详情不返回）
- **base_url**: 自定义 API 地址（可选）
- **model**: 模型名称
- **temperature**: 温度 0-2
- **max_tokens**: 最大生成 token 数
- **is_default**: 是否默认
- **status**: 0 禁用 / 1 启用
- **remark**: 备注
