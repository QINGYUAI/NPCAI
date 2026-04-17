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
