/**
 * AI 调用日志 API - 查询 AI 接口调用记录
 */
import { Request, Response } from 'express';
import { pool } from '../db/connection.js';

/** 获取 AI 调用日志列表（分页） */
export async function getAiLogs(req: Request, res: Response) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;
    const apiType = req.query.api_type as string | undefined;
    const status = req.query.status as string | undefined;
    const source = req.query.source as string | undefined;

    let where = '1=1';
    const params: (string | number)[] = [];
    if (apiType && ['chat', 'chat_stream', 'embed'].includes(apiType)) {
      where += ' AND api_type = ?';
      params.push(apiType);
    }
    if (status && ['success', 'error'].includes(status)) {
      where += ' AND status = ?';
      params.push(status);
    }
    if (source?.trim()) {
      where += ' AND source = ?';
      params.push(source.trim());
    }

    /**
     * mysql2 prepared statement 对 LIMIT/OFFSET placeholder 的支持在部分版本下不稳定
     * (报 "Incorrect arguments to mysqld_stmt_execute")，这里把已 sanitize 的整数内联到 SQL，
     * 不走占位符。pageSize/offset 均在上方走过 Math.min / Math.max + Number，无 SQL 注入风险
     */
    const safePageSize = Math.max(1, Math.min(100, Math.trunc(Number(pageSize) || 1)));
    const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
    const [rows] = await pool.execute(
      `SELECT id, ai_config_id, api_type, provider, model, request_info, response_info, request_content, response_content, duration_ms, status, error_message, source, context, created_at
       FROM ai_call_log
       WHERE ${where}
       ORDER BY id DESC
       LIMIT ${safePageSize} OFFSET ${safeOffset}`,
      params
    );

    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM ai_call_log WHERE ${where}`,
      params
    );
    const total = (countRows as { total: number }[])[0]?.total ?? 0;

    res.json({
      code: 0,
      data: {
        list: rows,
        total,
        page,
        pageSize,
      },
    });
  } catch (err) {
    console.error('getAiLogs:', err);
    res.status(500).json({ code: -1, message: '获取日志失败' });
  }
}
