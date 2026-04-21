-- AI 配置表（已存在则跳过，不删除数据）
CREATE TABLE IF NOT EXISTS ai_config (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  name VARCHAR(128) NOT NULL COMMENT '配置名称',
  provider VARCHAR(64) NOT NULL COMMENT '提供商: OpenAI, Claude, 通义千问, 文心一言 等',
  api_key VARCHAR(512) DEFAULT NULL COMMENT 'API Key（建议加密存储）',
  base_url VARCHAR(512) DEFAULT NULL COMMENT 'API 基础地址，为空则使用官方默认',
  model VARCHAR(128) DEFAULT 'gpt-3.5-turbo' COMMENT '模型名称',
  temperature DECIMAL(3,2) DEFAULT 0.7 COMMENT '温度参数 0-2',
  max_tokens INT DEFAULT 2000 COMMENT '最大生成 token 数',
  budget_tokens_per_tick INT DEFAULT 2000 COMMENT '[M4.2.0] 每 NPC 每 tick 的 token 预算上限；超支下一 tick 自动 skip',
  is_default TINYINT(1) DEFAULT 0 COMMENT '是否默认配置 0否 1是',
  status TINYINT(1) DEFAULT 1 COMMENT '状态 0禁用 1启用',
  remark VARCHAR(512) DEFAULT NULL COMMENT '备注说明',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_provider (provider),
  INDEX idx_status (status),
  INDEX idx_is_default (is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI配置表';

-- 角色 NPC 表（已存在则跳过，不删除数据）
CREATE TABLE IF NOT EXISTS npc (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  name VARCHAR(128) NOT NULL COMMENT '角色名称',
  description VARCHAR(512) DEFAULT NULL COMMENT '角色简介',
  background TEXT DEFAULT NULL COMMENT '角色背景（详细背景故事、出身、经历等）',
  personality VARCHAR(512) DEFAULT NULL COMMENT '角色性格（性格特质、待人方式等）',
  gender VARCHAR(16) DEFAULT NULL COMMENT '性别: male/female/other/unknown',
  age VARCHAR(32) DEFAULT NULL COMMENT '年龄: 数字或描述如青年',
  occupation VARCHAR(128) DEFAULT NULL COMMENT '职业',
  voice_tone VARCHAR(128) DEFAULT NULL COMMENT '说话风格/语气',
  avatar VARCHAR(512) DEFAULT NULL COMMENT '头像 URL',
  ai_config_id BIGINT NOT NULL COMMENT '关联 ai_config，指定使用的 AI 模型',
  system_prompt TEXT DEFAULT NULL COMMENT '系统提示词（角色人设、口吻、行为约束）',
  category VARCHAR(32) DEFAULT 'custom' COMMENT '分类：task/plot/custom',
  prompt_type VARCHAR(16) DEFAULT 'high' COMMENT '约束类型：high/low',
  status TINYINT(1) DEFAULT 1 COMMENT '状态 0禁用 1启用',
  sort INT DEFAULT 0 COMMENT '排序',
  simulation_meta JSON DEFAULT NULL COMMENT '外部仿真回写：记忆/反思等摘要（自由 JSON）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_config_id (ai_config_id),
  INDEX idx_category (category),
  INDEX idx_status (status),
  FOREIGN KEY (ai_config_id) REFERENCES ai_config(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色NPC表';

-- 场景表（剧情/空间/情境）
CREATE TABLE IF NOT EXISTS scene (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  name VARCHAR(128) NOT NULL COMMENT '场景名称',
  description TEXT DEFAULT NULL COMMENT '简介',
  category VARCHAR(32) DEFAULT 'custom' COMMENT '分类 task/plot/custom',
  tags JSON DEFAULT NULL COMMENT '标签 JSON 数组',
  background_image VARCHAR(512) DEFAULT NULL COMMENT '2D 沙盒底图 URL（可空）',
  width INT DEFAULT 800 COMMENT '2D 沙盒逻辑宽度（像素），默认 800',
  height INT DEFAULT 600 COMMENT '2D 沙盒逻辑高度（像素），默认 600',
  status TINYINT(1) DEFAULT 1 COMMENT '0禁用 1启用',
  sort INT DEFAULT 0 COMMENT '排序',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_scene_category (category),
  INDEX idx_scene_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='场景表';

-- 场景与 NPC 多对多
CREATE TABLE IF NOT EXISTS scene_npc (
  scene_id BIGINT NOT NULL COMMENT '场景ID',
  npc_id BIGINT NOT NULL COMMENT 'NPC ID',
  role_note VARCHAR(256) DEFAULT NULL COMMENT '本场景中身份/备注',
  pos_x DOUBLE DEFAULT NULL COMMENT '2D 沙盒 X 坐标（相对底图像素，画布 800x600）',
  pos_y DOUBLE DEFAULT NULL COMMENT '2D 沙盒 Y 坐标（相对底图像素，画布 800x600）',
  PRIMARY KEY (scene_id, npc_id),
  INDEX idx_scene_npc_npc (npc_id),
  CONSTRAINT fk_scene_npc_scene FOREIGN KEY (scene_id) REFERENCES scene(id) ON DELETE CASCADE,
  CONSTRAINT fk_scene_npc_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='场景与角色关联';

-- AI 接口调用日志表
CREATE TABLE IF NOT EXISTS ai_call_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  ai_config_id BIGINT DEFAULT NULL COMMENT '关联 ai_config（可选）',
  api_type VARCHAR(32) NOT NULL COMMENT 'chat/chat_stream/embed',
  provider VARCHAR(64) NOT NULL COMMENT '提供商',
  model VARCHAR(128) DEFAULT NULL COMMENT '模型名',
  request_info JSON DEFAULT NULL COMMENT '请求信息',
  response_info JSON DEFAULT NULL COMMENT '响应信息',
  request_content TEXT DEFAULT NULL COMMENT '请求内容（输入）',
  response_content TEXT DEFAULT NULL COMMENT '响应内容（输出）',
  duration_ms INT DEFAULT NULL COMMENT '耗时(毫秒)',
  status VARCHAR(16) NOT NULL DEFAULT 'success' COMMENT 'success/error',
  error_message TEXT DEFAULT NULL COMMENT '错误信息',
  source VARCHAR(64) DEFAULT NULL COMMENT '调用来源',
  context JSON DEFAULT NULL COMMENT '扩展上下文',
  -- [M4.2.1.a] 真实 tokens / cost 观测字段；与 scheduler.lastTickTokensByNpc 和前端时间线对接
  prompt_tokens INT DEFAULT NULL COMMENT '[M4.2.1.a] 输入 tokens（provider usage 或 tiktoken 估算）',
  completion_tokens INT DEFAULT NULL COMMENT '[M4.2.1.a] 输出 tokens',
  total_tokens INT DEFAULT NULL COMMENT '[M4.2.1.a] 总 tokens',
  cost_usd DECIMAL(10,6) DEFAULT NULL COMMENT '[M4.2.1.a] 本次调用费用（美元；未匹配模型为 NULL）',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_api_type (api_type),
  INDEX idx_status (status),
  INDEX idx_ai_config (ai_config_id),
  INDEX idx_source_created (source, created_at),
  FOREIGN KEY (ai_config_id) REFERENCES ai_config(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI接口调用日志表';

-- M4.1 引擎：NPC 单步决策归档
CREATE TABLE IF NOT EXISTS npc_tick_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  scene_id BIGINT NOT NULL COMMENT '场景ID',
  npc_id BIGINT NOT NULL COMMENT 'NPC ID',
  tick BIGINT NOT NULL COMMENT '场景内单调递增的 tick 序号',
  started_at DATETIME(3) NOT NULL COMMENT 'tick 开始时间',
  finished_at DATETIME(3) DEFAULT NULL COMMENT 'tick 完成时间',
  status VARCHAR(16) NOT NULL COMMENT 'success / error / skipped',
  input_summary TEXT DEFAULT NULL COMMENT '本 tick 输入摘要',
  output_meta JSON DEFAULT NULL COMMENT '本 tick 产出 simulation_meta 快照',
  error_message TEXT DEFAULT NULL COMMENT '错误信息',
  duration_ms INT DEFAULT NULL COMMENT '耗时毫秒',
  INDEX idx_scene_tick (scene_id, tick),
  INDEX idx_npc (npc_id),
  CONSTRAINT fk_tick_scene FOREIGN KEY (scene_id) REFERENCES scene(id) ON DELETE CASCADE,
  CONSTRAINT fk_tick_npc FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC 单步决策归档';
