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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_ai_config_id (ai_config_id),
  INDEX idx_category (category),
  INDEX idx_status (status),
  FOREIGN KEY (ai_config_id) REFERENCES ai_config(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色NPC表';

-- NPC 对话会话表（用户与 NPC 的对话会话）
CREATE TABLE IF NOT EXISTS npc_conversation (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  npc_id BIGINT NOT NULL COMMENT '关联 npc',
  user_id VARCHAR(64) DEFAULT NULL COMMENT '可选：用户标识',
  session_id VARCHAR(64) NOT NULL COMMENT '会话唯一标识',
  status TINYINT(1) DEFAULT 1 COMMENT '状态',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_npc_id (npc_id),
  INDEX idx_session_id (session_id),
  FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC对话会话表';

-- 对话消息表（每轮对话的消息）
CREATE TABLE IF NOT EXISTS npc_message (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  conversation_id BIGINT NOT NULL COMMENT '关联 npc_conversation',
  role ENUM('user','assistant') NOT NULL COMMENT 'user=用户 assistant=NPC',
  content TEXT NOT NULL COMMENT '消息内容',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversation_id (conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES npc_conversation(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对话消息表';

-- NPC 记忆表（对话总结、反思、关系等，用于注入下一轮对话）
CREATE TABLE IF NOT EXISTS npc_memory (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  npc_id BIGINT NOT NULL COMMENT '关联 npc',
  conversation_id BIGINT DEFAULT NULL COMMENT '关联 npc_conversation（可选）',
  type VARCHAR(32) NOT NULL COMMENT 'conversation/reflection/relationship',
  description TEXT NOT NULL COMMENT '记忆内容',
  importance DECIMAL(3,2) DEFAULT 0.5 COMMENT '重要度 0-1，用于筛选',
  related_ids JSON DEFAULT NULL COMMENT '关联记忆 id 列表；type=relationship 时可为 {"target_npc_id":2}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_npc_type (npc_id, type),
  INDEX idx_npc_importance (npc_id, importance DESC),
  FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES npc_conversation(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC记忆表';

-- ========== 地图与交互模块（详见 交互.md） ==========

-- 游戏地图表
CREATE TABLE IF NOT EXISTS game_map (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  name VARCHAR(128) NOT NULL COMMENT '地图名称',
  width INT NOT NULL COMMENT '地图宽度（格子数）',
  height INT NOT NULL COMMENT '地图高度（格子数）',
  tile_data JSON NOT NULL COMMENT '2D 数组，0=可行走 1=障碍',
  metadata JSON DEFAULT NULL COMMENT '扩展：图块类型、图层等',
  status TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='游戏地图表';

-- NPC 与地图绑定及初始位置（Redis 冷启动时从此加载）
CREATE TABLE IF NOT EXISTS npc_map_binding (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  npc_id BIGINT NOT NULL COMMENT '关联 npc',
  map_id BIGINT NOT NULL COMMENT '关联 game_map',
  init_x INT NOT NULL DEFAULT 0 COMMENT '初始 X 坐标',
  init_y INT NOT NULL DEFAULT 0 COMMENT '初始 Y 坐标',
  UNIQUE KEY uk_npc_map (npc_id, map_id),
  FOREIGN KEY (npc_id) REFERENCES npc(id) ON DELETE CASCADE,
  FOREIGN KEY (map_id) REFERENCES game_map(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC与地图绑定及初始位置';

-- NPC 之间对话会话表（持久化，进行中在 Redis）
CREATE TABLE IF NOT EXISTS npc_npc_conversation (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  map_id BIGINT DEFAULT NULL COMMENT '发生在地图上的对话',
  participant_ids JSON NOT NULL COMMENT '参与 NPC id 列表，如 [1,2,3]',
  status ENUM('active','ended') DEFAULT 'ended',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME DEFAULT NULL,
  INDEX idx_status (status),
  INDEX idx_map (map_id),
  FOREIGN KEY (map_id) REFERENCES game_map(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC之间对话会话表（持久化）';

-- NPC 之间对话消息表（持久化）
CREATE TABLE IF NOT EXISTS npc_npc_message (
  id BIGINT AUTO_INCREMENT PRIMARY KEY COMMENT '主键ID',
  conversation_id BIGINT NOT NULL COMMENT '关联 npc_npc_conversation',
  speaker_npc_id BIGINT NOT NULL COMMENT '发言的 NPC',
  content TEXT NOT NULL COMMENT '消息内容',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversation_id (conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES npc_npc_conversation(id) ON DELETE CASCADE,
  FOREIGN KEY (speaker_npc_id) REFERENCES npc(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='NPC之间对话消息表（持久化）';

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
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  INDEX idx_api_type (api_type),
  INDEX idx_status (status),       
  INDEX idx_ai_config (ai_config_id),
  FOREIGN KEY (ai_config_id) REFERENCES ai_config(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AI接口调用日志表';
