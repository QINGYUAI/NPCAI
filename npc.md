# AI NPC 设计实践总结

> 参考：行业 AI NPC 设计实践（大模型角色扮演、Prompt 支架、上下文管理等）  
> 来源：知乎及相关技术文档

---

## 一、核心技术架构

游戏/AI NPC 对话系统采用**分层架构设计**：

| 层级 | 职责 | 主要能力 |
|------|------|----------|
| 集成层 | 对话触发、环境同步、动画语音控制 | 触发条件、多模态融合 |
| 对话管理层 | 上下文管理、记忆系统、对话流控制 | 会话窗口、主题追踪、记忆提取 |
| LLM 处理层 | 提示工程、模型推理、输出解析 | System Prompt、约束、输出格式 |
| 数据持久层 | 对话历史、NPC 配置、知识图谱 | 存储与检索 |

---

## 二、大模型角色扮演

### 2.1 两种角色扮演模式

| 模式 | 技术选型 | 适用场景 |
|------|----------|----------|
| **全能演员** | 大模型 + 灵活 System 提示 | 支持自定义角色、快速迭代 |
| **特型演员** | 小模型 + 定制化 SFT 训练 | 专门扮演特定角色、成本敏感 |

**本项目采用**：全能演员模式，通过 System Prompt 约束人设、口吻、行为边界。

### 2.2 角色人格一致性三要素

- **Persona（角色设定）**：背景故事、性格特质、待人方式
- **Context（上下文）**：所处世界、当前情境、与玩家/其它角色的关系
- **Constraints（约束条件）**：禁止事项、输出边界、情绪倾向

---

## 三、Prompt 工程与支架（五个关键要素）

| 要素 | 说明 | 本项目对应字段 |
|------|------|----------------|
| **Persona（角色设定）** | 人设、身份、背景 | `name`、`description`、`background`、`personality` |
| **Context（上下文）** | 所处情境、世界状态 | 可注入 `background`、后续扩展对话上下文 |
| **Task（任务目标）** | 对话/交互目标 | 由 `category`、`prompt_type` 隐式影响 |
| **Format（输出格式）** | 回复结构、长度、风格 | 可在 `system_prompt` 中约定 |
| **Constraints（约束）** | 禁止事项、边界、口吻 | `system_prompt` 中显式定义 |

### 3.1 System Prompt 组装示例

```
你是{name}，{description}。
背景：{background}。
性格特点：{personality}。
说话风格：{tone}。
禁止事项：{forbidden}。
```

### 3.2 约束类型（prompt_type）

| 类型 | 含义 | 适用 |
|------|------|------|
| **high（高约束 HCP）** | 严格遵循设定，偏任务发布型 | 任务型 NPC、客服型 |
| **low（低约束 LCP）** | 允许即兴发挥、创造性回复 | 剧情型、闲聊型 |

---

## 四、上下文管理

### 4.1 核心挑战

- **实时响应**：需在 100–300ms 内做出反应
- **上下文持续性**：长时间会话中保持连贯
- **角色一致性**：维持性格、背景、情绪状态

### 4.2 关键机制（后期迭代）

| 机制 | 作用 |
|------|------|
| 会话窗口管理 | 限制历史长度，避免超长上下文 |
| 重要性加权 | 优先保留关键信息 |
| 主题追踪 | 识别对话主题变化 |
| 记忆提取与摘要 | 将长对话压缩为摘要注入 |

### 4.3 三级记忆系统（规划）

| 层级 | 类型 | 用途 |
|------|------|------|
| 短期 | 工作记忆 | 当前轮次、最近几轮对话 |
| 中期 | 情节记忆 | 本次会话关键事件、情绪变化 |
| 长期 | 语义记忆 | 人物关系、世界观、持久设定 |

---

## 五、模型选型建议

| 模型 | 适用场景 |
|------|----------|
| GPT-4 / GPT-4o | 高质量剧情、复杂对话 |
| Claude 3 | 长文本、大上下文窗口（200K） |
| 通义千问 | 中文游戏、本地化部署 |
| Llama 3 | 本地运行、成本敏感 |

**建议**：初期用 GPT-4 / Claude 3 做原型，后期可微调开源模型降本。

---

## 六、本项目已实现对照

| 行业实践 | 本项目实现 |
|----------|------------|
| 角色人格一致性 | ✅ `background`、`personality`、`system_prompt` |
| Prompt 五要素支架 | ✅ 通过 `system_prompt` 或“AI 自动生成”组装 |
| 绑定 AI 配置 | ✅ `ai_config_id` 关联模型 |
| 约束类型 high/low | ✅ `prompt_type` 字段 |
| 角色分类 | ✅ `category`（task / plot / custom） |
| 全能演员模式 | ✅ 使用大模型 + System Prompt |
| AI 辅助生成设定 | ✅ `generateNpcContent` 接口 |
| 上下文 / 记忆系统 | ✅ 对话记录、npc_memory 表、对话总结注入 |

---

## 七、后期迭代方向

1. **对话管理 API**：用户-NPC 对话接口、对话记录存储 ✅
2. **上下文注入**：将 `background`、历史摘要注入对话 ✅
3. **记忆系统**：三级记忆表结构与检索逻辑 ✅（含向量语义检索）
4. **性能优化**：流式响应、预计算缓存、异步处理 ✅（流式 SSE）
5. **多模态**：语音、肢体动作、表情（如有需要）

---

## 八、AI-Town 源码解读参考

> 来源：a16z 主导的斯坦福小镇升级版 AI-Town，知乎 Smilence 解读

### 8.1 技术栈

| 组件 | 选型 |
|------|------|
| 引擎 + 数据库 | Convex（Serverless，自动生成 API） |
| 向量库 | Pinecone |
| 认证 | Clerk |
| 文本模型 | OpenAI |
| 渲染 | PixiJS、PixiViewport |
| 部署 | Fly.io |

### 8.2 核心数据结构

| 表 | 字段要点 | 用途 |
|----|----------|------|
| **memories** | `description`、`data`(type/relatedMemoryIds)、`playerId`、`importance` | 记忆存储，type 含 conversation/reflection/relationship |
| **agents** | 思考中、激活状态等标志位 | Agent 实时状态 |
| **journal** | 行为路径 | 行为追踪 |

### 8.3 对话与记忆流程

```
tick 循环 → divideIntoGroups（按距离分组）
         ├── 对话组：handleAgentInteraction
         │   ├── 查 relationship 记忆
         │   ├── decideWhoSpeaksNext（LLM 决定下一个发言者）
         │   ├── walkAway（LLM 决定是否离开）
         │   ├── startConversation（greeting + 相关记忆）
         │   ├── converse（identity + 关系 + 仅 2 条 reflection + 2 条 conversation）
         │   └── rememberConversation（LLM 总结对话并入库）
         └── 个人组：reflectOnMemories
             └── importanceScore 总和 > 500 时，LLM 从近期 100 条记忆提炼 3 条 insight 入库
```

### 8.4 可借鉴点（面向 AINPC）

| AI-Town 做法 | AINPC 启示 |
|--------------|------------|
| memories 表（conversation / reflection / relationship） | 可设计 `npc_memory` 表，区分对话、反思、关系 |
| importance 评分 | 筛选重要记忆，控制注入量 |
| 对话时仅取 2 条相关记忆 | 避免上下文爆炸，降低成本 |
| rememberConversation 总结 | 每轮对话结束做摘要入库 |
| reflectOnMemories 反思 | 从近期记忆提炼高层级 insight，形成角色认知 |
| 按距离分组 | 多 NPC 场景可做空间/社交分组 |

### 8.5 成本与问题

- 8 个 Agent 满速对话，约 5 美元/小时（gpt-3.5-turbo-16k）
- **主要问题**：prompt 中 memory 未过滤/摘要，token 消耗大
- **优化方向**：对 memory 做重要性筛选与摘要压缩后再注入

### 8.6 与斯坦福 AI 小镇对比

| 项目 | 特点 |
|------|------|
| 斯坦福 AI 小镇 | 论文导向，策略创新，工程化较弱 |
| AI-Town | 工程导向，可扩展性好，Agent 策略较简单 |
| **综合建议** | 将斯坦福的策略迁移到 AI-Town 的工程框架中 |

---

## 九、记忆系统设计参考（综合梳理）

结合行业实践与 AI-Town，建议记忆表设计：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | BIGINT | 主键 |
| npc_id | BIGINT | 关联 npc |
| conversation_id | BIGINT | 关联会话（可选） |
| type | VARCHAR | conversation / reflection / relationship |
| description | TEXT | 记忆内容 |
| importance | DECIMAL | 重要度 0-1，用于筛选 |
| related_ids | JSON | 关联记忆 id 列表 |
| created_at | DATETIME | 创建时间 |

**注入策略**：对话时按 importance 排序，取 top-N（如 2–5 条）注入 prompt，避免超长上下文。

---

## 十、当前项目实现指南

将文档理论落地到 AINPC 项目的分阶段实现方案。

### 10.1 现状与目标对照

| 已实现 | 待实现 |
|--------|--------|
| AI 配置、NPC CRUD、AI 自动生成 | 用户-NPC 对话 API |
| system_prompt、背景、性格 | 对话记录存储、上下文注入 |
| - | 记忆系统（npc_memory 表） |
| - | 对话总结、反思机制 |

### 10.2 阶段一：对话 API + 对话记录（P0）✅ 已实现

**目标**：实现用户与 NPC 的一对一对话，并存储对话历史。

#### 1）数据库

在 `schema.sql` 中新增：

```sql
-- 会话表：每次用户与 NPC 的对话会话
CREATE TABLE IF NOT EXISTS npc_conversation (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  npc_id BIGINT NOT NULL,
  user_id VARCHAR(64) DEFAULT NULL COMMENT '可选：用户标识',
  session_id VARCHAR(64) NOT NULL COMMENT '会话唯一标识',
  status TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_npc_id (npc_id),
  INDEX idx_session_id (session_id),
  FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC对话会话表';

-- 消息表：每轮对话的消息
CREATE TABLE IF NOT EXISTS npc_message (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  conversation_id BIGINT NOT NULL,
  role ENUM('user','assistant') NOT NULL,
  content TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversation_id (conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES npc_conversation(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对话消息表';
```

#### 2）后端实现

| 文件 | 职责 |
|------|------|
| `backend/src/routes/conversation.ts` | `POST /chat` 对话接口 |
| `backend/src/controllers/conversation.ts` | 组装 System Prompt、查最近 N 条消息、调用 `chatCompletion`、写入 `npc_message` |
| `backend/src/db/migrate-conversation.ts` | 执行建表迁移 |

**Prompt 组装逻辑**（利用现有 npc 字段）：

```typescript
// 从 npc 表取 system_prompt，若无则用 background + personality 拼
const systemMsg = npc.system_prompt || 
  `你是${npc.name}，${npc.description}。背景：${npc.background}。性格：${npc.personality}。`;
// 最近 10 条对话作为上下文
const history = recentMessages.map(m => ({ role: m.role, content: m.content }));
const messages = [
  { role: 'system', content: systemMsg },
  ...history,
  { role: 'user', content: userInput }
];
```

#### 3）接口设计

```
POST /api/conversation/chat
Body: { npc_id, session_id?, user_input }
Response: { content: "NPC 回复", message_id }
```

### 10.3 阶段二：记忆系统（P1）✅ 已实现

**目标**：引入 npc_memory 表，对话后做总结入库，下一轮对话时注入相关记忆。

#### 1）数据库

```sql
CREATE TABLE IF NOT EXISTS npc_memory (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  npc_id BIGINT NOT NULL,
  conversation_id BIGINT DEFAULT NULL,
  type VARCHAR(32) NOT NULL COMMENT 'conversation/reflection/relationship',
  description TEXT NOT NULL,
  importance DECIMAL(3,2) DEFAULT 0.5 COMMENT '0-1',
  related_ids JSON DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_npc_type (npc_id, type),
  FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES npc_conversation(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC记忆表';
```

#### 2）流程

1. **对话时**：按 `importance DESC` 取 top 2–5 条 memory，拼入 system prompt 的【相关记忆】块
2. **对话后**：调用 LLM 总结本轮对话（含感受：喜欢/一般/不喜欢）→ 写入 `npc_memory`（type=conversation），设 `importance`（异步不阻塞响应）
3. **可选**：定时任务对近期记忆做 `reflectOnMemories` 式反思，生成 reflection 入库

#### 3）Prompt 示例（rememberConversation）

```
你是{npc_name}。请用 1–2 句话总结刚才的对话，并说明你对这次交流的感受（喜欢/一般/不喜欢）。
```

### 10.4 阶段三：前端对话界面（P1）

| 文件 | 职责 |
|------|------|
| `frontend/src/views/ChatView.vue` | 对话页：选择 NPC、会话列表、消息流 |
| `frontend/src/api/conversation.ts` | `chat(npcId, sessionId, userInput)` |
| `frontend/src/components/ChatPanel.vue` | 消息气泡、输入框、发送 |
| `frontend/src/App.vue` | 增加路由 `/chat` 或 `/chat/:npcId` |

### 10.5 实现顺序建议

```
阶段一：建表 → conversation 控制器 → 路由 → 联调
阶段二：npc_memory 建表 → 注入逻辑 → rememberConversation
阶段三：ChatView → ChatPanel → API 对接
```

### 10.6 关键文件清单

| 层级 | 新增/修改文件 |
|------|---------------|
| DB | `schema.sql` 补充三表、`migrate-conversation.ts` |
| Backend | `controllers/conversation.ts`、`routes/conversation.ts`、`index.ts` 挂载 |
| Frontend | `api/conversation.ts`、`views/ChatView.vue`、`components/ChatPanel.vue`、路由配置 |

### 10.7 复用现有能力

- `chatCompletion`（`llmClient.ts`）：直接用于对话、总结、反思
- `ai_config` + `npc.ai_config_id`：对话时按 NPC 使用对应模型
- `npc.system_prompt`、`background`、`personality`：作为 System 消息基础

---

*最后更新：行业 AI NPC 设计实践 + AI-Town 源码解读 + 项目实现指南*
