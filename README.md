# AI 配置模块

管理多平台 AI 模型配置的前后端应用，支持 OpenAI、Claude、通义千问、文心一言、智谱等。

## 技术栈

- **前端**: Vue 3 + Vite + TypeScript + Element Plus
- **后端**: Node.js + Express
- **数据库**: MySQL（`ai_config`、`npc`、`scene`、`scene_npc`；可选 `ai_call_log`）

## 快速开始

### 1. 环境与数据库

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# 编辑 backend/.env 填写 MySQL 等
npm run install-all
npm run db:init
```

若已有旧库但缺少 NPC 扩展字段：`npm run db:migrate-npc-fields`  
需要 AI 调用日志表时：`npm run db:migrate-ai-log`  
**场景与 `npc.simulation_meta`（人物-场景编排）**：`npm run db:migrate-scene`  
> `db:migrate-scene` 已幂等；v0.8 追加 `scene.background_image` 与 `scene_npc.pos_x/pos_y`；v0.9 追加 `scene.width`、`scene.height`（2D 沙盒任意尺寸）。

### 2. 依赖（根目录一键安装前后端）

```bash
npm run install-all
```

### 3. 开发（根目录同时启动后端 + 前端）

```bash
# 在仓库根目录 AINPC/
npm install   # 首次需安装根目录的 concurrently
npm run dev
# 后端 http://localhost:3000  前端 http://localhost:5173
```

也可分别启动：`npm run dev:backend`、`npm run dev:frontend`。

### 测试

```bash
cd backend && npm test     # 后端：Vitest + Supertest 路由契约测试
cd frontend && npm test    # 前端：Vitest 纯函数测试（沙盒工具）
```

### 4. 仅启动某一端（可选）

```bash
cd backend && npm run dev    # http://localhost:3000
cd frontend && npm run dev   # http://localhost:5173
```

## API 接口

| 方法 | 路径 | 说明 |
|-----|------|-----|
| GET/POST/PUT/DELETE/PATCH | /api/config | AI 配置 |
| GET/POST/PUT/DELETE | /api/npc | NPC；列表支持 `?scene_id=`；`GET /api/npc/:id/scenes` 查所属场景 |
| GET/POST/PUT/DELETE、`PUT /api/scene/:id/npcs`、`PUT /api/scene/:id/layout`、`GET /api/scene/:id/export?format=json\|csv` | /api/scene | 场景、关联、2D 沙盒布局与导出 |
| POST | /api/upload/avatar | 上传头像（2MB） |
| POST | /api/upload/image | 上传通用图片（8MB，沙盒底图等） |
| GET | /api/ai-logs | AI 调用日志 |

## 文档

- [`docs/requirements-character-scene.md`](./docs/requirements-character-scene.md)：人物·场景需求与实现记录（含里程碑 M1~M3.3）
- [`docs/engine-selection.md`](./docs/engine-selection.md)：**M4 主仿真引擎选型报告**（待评审）
- [`docs/engine-integration-m4.1.md`](./docs/engine-integration-m4.1.md)：**M4.1 引擎集成细设**（初稿，待评审）

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
