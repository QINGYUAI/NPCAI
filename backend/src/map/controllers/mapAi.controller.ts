/**
 * 地图 AI 生成控制器（文本生成、图片转地图）
 */
import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pool } from '../../db/connection.js';
import { chatCompletion } from '../../utils/llmClient.js';
import {
  buildMapGeneratePrompt,
  buildMapRefinePrompt,
  LAYOUT_TO_MAP_PROMPT,
  VISION_MODEL_OVERRIDES,
  parseMapGenerateJson,
} from '../map.service.js';
import { asyncHandler, apiError } from '../map.middleware.js';

/** AI 文本生成地图 */
export const generateMapContent = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as {
    ai_config_id: number;
    hint?: string;
    current_map?: { name: string; width: number; height: number; items?: unknown[]; tile_types?: Record<string, { name: string; color: string }> };
  };
  const { ai_config_id, hint, current_map } = body;

  if (!ai_config_id) return apiError(res, -1, '请选择 AI 配置', 400);
  const inputText = (hint?.trim() || '').replace(/\s+/g, ' ');
  if (!inputText) return apiError(res, -1, '请填写地图描述或修改要求', 400);

  const [rows] = await pool.execute(
    'SELECT id, provider, api_key, base_url, model, max_tokens FROM ai_config WHERE id = ? AND status = 1',
    [ai_config_id]
  );
  const list = rows as unknown[];
  if (list.length === 0) return apiError(res, -1, 'AI 配置不存在或已禁用', 404);
  const cfg = list[0] as { api_key: string | null; base_url: string | null; provider: string; model: string; max_tokens: number };

  let messages: { role: 'user' | 'assistant'; content: string }[];
  if (current_map && current_map.name != null && current_map.width != null && current_map.height != null) {
    const currentJson = JSON.stringify({
      name: current_map.name,
      width: current_map.width,
      height: current_map.height,
      tile_types: current_map.tile_types ?? {},
      items: current_map.items ?? [],
    });
    messages = [{ role: 'user', content: buildMapRefinePrompt(inputText, currentJson) }];
  } else {
    messages = [{ role: 'user', content: buildMapGeneratePrompt(inputText) }];
  }

  const content = await chatCompletion(
    {
      api_key: cfg.api_key!,
      base_url: cfg.base_url,
      provider: cfg.provider,
      model: cfg.model,
      max_tokens: Math.max(cfg.max_tokens, 3000),
    },
    messages,
    { timeout: 90000, max_tokens: 3000, logContext: { source: 'map_generate', ai_config_id } }
  );

  const parsed = parseMapGenerateJson(content);
  res.json({ code: 0, data: parsed });
});

/** 室内布局图上传并转换为地图 */
export const convertLayoutImageToMap = asyncHandler(async (req: Request, res: Response) => {
  const file = req.file;
  if (!file) return apiError(res, -1, '请上传室内布局图', 400);

  try {
    const ai_config_id = Number(req.body?.ai_config_id);
    if (!ai_config_id) return apiError(res, -1, '请选择 AI 配置（需支持视觉的模型，如 gpt-4o）', 400);

    const [rows] = await pool.execute(
      'SELECT id, provider, api_key, base_url, model, max_tokens FROM ai_config WHERE id = ? AND status = 1',
      [ai_config_id]
    );
    const list = rows as unknown[];
    if (list.length === 0) return apiError(res, -1, 'AI 配置不存在或已禁用', 404);
    const cfg = list[0] as { api_key: string | null; base_url: string | null; provider: string; model: string; max_tokens: number };

    const fileBuffer = fs.readFileSync(file.path);
    const ext = path.extname(file.originalname || file.path).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };
    const mime = mimeMap[ext] || file.mimetype || 'image/png';
    const base64 = fileBuffer.toString('base64');
    const dataUrl = `data:${mime};base64,${base64}`;

    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: LAYOUT_TO_MAP_PROMPT },
          { type: 'image_url' as const, image_url: { url: dataUrl } },
        ],
      },
    ];

    const visionModel = VISION_MODEL_OVERRIDES[cfg.provider];
    const modelForVision = visionModel ?? cfg.model;

    const content = await chatCompletion(
      {
        api_key: cfg.api_key!,
        base_url: cfg.base_url,
        provider: cfg.provider,
        model: modelForVision,
        max_tokens: Math.max(cfg.max_tokens, 3000),
      },
      messages,
      { timeout: 120000, max_tokens: 3000, logContext: { source: 'map_convert_layout', ai_config_id } }
    );

    const parsed = parseMapGenerateJson(content);
    res.json({ code: 0, data: parsed });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
});
