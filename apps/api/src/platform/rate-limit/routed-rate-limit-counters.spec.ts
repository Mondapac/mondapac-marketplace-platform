import { RATE_LIMIT_CLASSES } from './rate-limit.decorator';
import { SUBJECT_LIMIT_WINDOWS, type CountedClass } from './rate-limit-counters';
import {
  RATE_LIMIT_STORE_OF,
  REDIS_COUNTED_CLASSES,
  RoutedRateLimitCounters,
} from './routed-rate-limit-counters';

const ALL_CLASSES: readonly CountedClass[] = [
  ...RATE_LIMIT_CLASSES,
  ...(Object.keys(SUBJECT_LIMIT_WINDOWS) as CountedClass[]),
];

function recordingStore(name: string) {
  const calls: string[] = [];
  return {
    calls,
    consume: (limitClass: CountedClass, key: string) => {
      calls.push(`${limitClass}:${key}`);
      return Promise.resolve({ count: name === 'redis' ? 1 : 2, msBeforeNext: 1000 });
    },
  };
}

describe('RoutedRateLimitCounters (ADR-0054 decision 1)', () => {
  it('names a store for every counted class, and Redis for exactly the three high-traffic per-origin classes', () => {
    expect(Object.keys(RATE_LIMIT_STORE_OF).sort()).toEqual([...ALL_CLASSES].sort());
    expect([...REDIS_COUNTED_CLASSES].sort()).toEqual(['default', 'public-media', 'public-search']);
  });

  it('keeps anonymous-identity and every per-subject class in PostgreSQL (fail closed, Hassan)', () => {
    expect(RATE_LIMIT_STORE_OF['anonymous-identity']).toBe('postgres');
    for (const subject of Object.keys(SUBJECT_LIMIT_WINDOWS) as CountedClass[]) {
      expect(RATE_LIMIT_STORE_OF[subject]).toBe('postgres');
    }
  });

  it('sends each class to its store', async () => {
    const redis = recordingStore('redis');
    const postgres = recordingStore('postgres');
    const counters = new RoutedRateLimitCounters(redis, postgres);

    for (const counted of ALL_CLASSES) await counters.consume(counted, 'k');

    expect(redis.calls).toEqual(['public-media:k', 'public-search:k', 'default:k']);
    expect(postgres.calls).toEqual([
      'anonymous-identity:k',
      'assistant-message:k',
      'checkout-payment:k',
      'admin-customer-password-reset:k',
      'admin-customer-pii-reveal:k',
    ]);
  });

  it('counts every class in PostgreSQL without Redis (RATE_LIMIT_STORE=postgres, the rollback switch)', async () => {
    const postgres = recordingStore('postgres');
    const counters = new RoutedRateLimitCounters(null, postgres);

    for (const counted of ALL_CLASSES) {
      await expect(counters.consume(counted, 'k')).resolves.toEqual({
        count: 2,
        msBeforeNext: 1000,
      });
    }
    expect(postgres.calls).toHaveLength(ALL_CLASSES.length);
  });

  it('lets a PostgreSQL failure reach the caller, which fails closed', async () => {
    const failing = {
      consume: () => Promise.reject(new Error('lock timeout')),
    };
    const counters = new RoutedRateLimitCounters(recordingStore('redis'), failing);

    await expect(counters.consume('anonymous-identity', 'k')).rejects.toThrow('lock timeout');
  });
});
