/**
 * 统一错误处理：包装异步路由处理器，自动捕获异常并返回 JSON 错误响应
 * 支持 HttpError 的 status 属性（如 400、404）
 */
import type { Request, Response, NextFunction } from 'express';

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** 包装异步路由，捕获错误并统一返回 { code: -1, message } */
export function asyncHandler(fn: AsyncRequestHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : '请求失败';
      const status = err && typeof err === 'object' && 'status' in err && typeof (err as { status: number }).status === 'number'
        ? (err as { status: number }).status
        : 500;
      console.error('[asyncHandler]', req.method, req.path, err);
      res.status(status).json({ code: -1, message: msg });
    });
  };
}
