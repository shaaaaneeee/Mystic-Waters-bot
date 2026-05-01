// config/redis.js
import Redis from 'ioredis';
import 'dotenv/config';

const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
});

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));

export default redis;
