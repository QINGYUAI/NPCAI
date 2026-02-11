/**
 * Redis 连接
 * 用于：NPC 实时位置、状态、对话组
 */
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    return delay;
  },
});

redis.on('error', (err) => console.error('[Redis]', err));
redis.on('connect', () => console.log('[Redis] 已连接'));
