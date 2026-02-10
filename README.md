# AI 配置模块

管理多平台 AI 模型配置的前后端应用，支持 OpenAI、Claude、通义千问、文心一言、智谱等。

## 技术栈

- **前端**: Vue 3 + Vite + TypeScript
- **后端**: Node.js + Express
- **数据库**: MySQL

## 快速开始

### 1. 数据库初始化

```bash
cd backend
cp .env.example .env
# 编辑 .env 填写 MySQL 连接信息
npm install
npm run db:init
npm run db:migrate-npc          # 创建 npc 表
npm run db:migrate-conversation # 创建对话相关表
npm run db:migrate-memory       # 创建记忆表 npc_memory
npm run db:migrate-memory-embedding  # 添加 embedding 列（语义检索）
```

### 2. 启动后端

```bash
cd backend
npm run dev
# 服务运行在 http://localhost:3000
```

### 3. 启动前端

```bash
cd frontend
cp .env.example .env
# 如需修改 API 地址，编辑 VITE_API_BASE
npm install
npm run dev
# 访问 http://localhost:5173
```

## 项目结构

```
AINPC/
├── frontend/          # Vue3 + Vite + TS
│   ├── src/
│   │   ├── api/       # API 接口
│   │   ├── components/ # 配置列表、表单组件
│   │   └── types/     # 类型定义
│   └── ...
├── backend/           # Node.js + Express
│   ├── src/
│   │   ├── controllers/
│   │   ├── db/        # 数据库连接、初始化、表结构
│   │   ├── routes/
│   │   └── types/
│   └── ...
└── 需求.md
```

## API 接口

| 方法 | 路径 | 说明 |
|-----|------|-----|
| GET | /api/config | 获取配置列表（支持 provider、status 筛选） |
| GET | /api/config/:id | 获取单个配置 |
| POST | /api/config | 新增配置 |
| PUT | /api/config/:id | 更新配置 |
| DELETE | /api/config/:id | 删除配置 |
| PATCH | /api/config/:id/default | 设为默认配置 |
| POST | /api/conversation/chat | 用户与 NPC 对话（Body: npc_id, session_id?, user_input） |
| POST | /api/conversation/chat/stream | 流式对话（SSE 逐字返回） |
| GET | /api/conversation/conversations | 会话列表（Query: npc_id） |
| POST | /api/conversation/conversations | 创建会话（Body: npc_id） |
| DELETE | /api/conversation/conversations/:id | 删除会话 |
| GET | /api/conversation/messages | 获取会话历史（Query: session_id） |
| GET | /api/memory | 记忆列表（Query: npc_id） |
| DELETE | /api/memory/:id | 删除记忆 |
| PATCH | /api/memory/:id | 更新记忆 |
| POST | /api/memory/reflect | 手动触发反思（Query: npc_id） |
| POST | /api/upload/avatar | 上传头像（multipart/form-data, field: file） |

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
