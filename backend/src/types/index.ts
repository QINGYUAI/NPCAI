/**
 * AI 配置相关类型定义
 */
export interface AiConfig {
  id: number;
  name: string;
  provider: string;
  api_key: string | null;
  base_url: string | null;
  model: string;
  temperature: number;
  max_tokens: number;
  is_default: number;
  status: number;
  remark: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateConfigDto {
  name: string;
  provider: string;
  api_key?: string;
  base_url?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  is_default?: number;
  status?: number;
  remark?: string;
}

export interface UpdateConfigDto extends Partial<CreateConfigDto> {}
