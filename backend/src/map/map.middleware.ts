/**
 * 地图模块中间件：Zod 校验、统一错误处理
 */
import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

/** 将 Redis 相关错误转为友好提示 */
function toRedisHint(msg: string): string {
  if (msg.includes('ECONNREFUSED')) return 'Redis 未启动，请先运行 redis-server';
  if (msg.includes('auth') || msg.includes('NOAUTH')) return 'Redis 密码错误，请检查 REDIS_URL';
  return msg;
}

/** 统一 API 错误响应 */
export function apiError(res: Response, code: number, message: string, status = 500) {
  res.status(status).json({ code, message });
}

/** 异步 controller 包装：统一 catch 错误 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch((err) => {
      console.error('[map]', err);
      const msg = err instanceof Error ? err.message : '服务器错误';
      apiError(res, -1, msg);
    });
  };
}

/** Zod 校验中间件工厂 */
export function validateBody<T>(schema: { parse: (v: unknown) => T }) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (e) {
      if (e instanceof ZodError) {
        const first = e.issues[0];
        const msg = first ? `${first.path.join('.')}: ${first.message}` : '参数校验失败';
        return apiError(res, -1, msg, 400);
      }
      next(e);
    }
  };
}

/** 场景相关接口的 Redis 错误友好提示 */
export function withRedisHint(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '操作失败';
      apiError(res, -1, toRedisHint(msg));
    }
  };
}
