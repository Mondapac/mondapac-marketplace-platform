// Violation: the Redis client is imported only by platform/rate-limit/rate-limit-redis.ts (ADR-0054).
export { Redis } from 'ioredis';
