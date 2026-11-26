import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { RoutePopulation } from '../src/platform/call-context/route-population.decorator';
import { RateLimit } from '../src/platform/rate-limit/rate-limit.decorator';
import { STORE_DEGRADED } from '../src/platform/rate-limit/redis-rate-limit-counters';
import { createTestApp, type LogLine } from './support/test-app';

// ADR-0054 decision 3: with Redis unreachable, the Redis classes are counted in the instance's
// memory and the change is logged once; anonymous-identity stays in PostgreSQL and fails closed.
// Its own file: only the first application of a spec file captures log lines (test-app.ts).

@RoutePopulation('customer')
@Controller('test/outage')
class OutageController {
  @Get('plain')
  plain(): { ok: true } {
    return { ok: true };
  }

  @Post('anonymous')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  anonymous(): { ok: true } {
    return { ok: true };
  }
}

describe('rate limiting while Redis is down (ADR-0054)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];

  beforeAll(async () => {
    // Nothing listens on port 1; the database URL of test applications is unused too.
    ({ app, logLines } = await createTestApp({
      controllers: [OutageController],
      rateLimitStore: 'redis',
      env: { REDIS_URL: 'redis://127.0.0.1:1' },
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  it('still answers and limits the default class from memory, and logs the degraded store once without a key', async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 302; index += 1) {
      statuses.push(
        (await request(app.getHttpServer()).get('/test/outage/plain').set('x-market-id', 'AU'))
          .status,
      );
    }

    expect(statuses.slice(0, 300)).toEqual(Array<number>(300).fill(200));
    expect(statuses.slice(300)).toEqual([429, 429]);
    const degraded = logLines.filter((line) => line.msg === STORE_DEGRADED);
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({
      store: 'redis',
      fallback: 'memory',
      limitClass: 'default',
      errorCode: expect.stringMatching(/^[a-z-]+$|^[A-Z][A-Z0-9_]+$/) as unknown,
    });
    expect(JSON.stringify(degraded[0])).not.toMatch(/[0-9a-f]{64}|127\.0\.0\.1/);
  });

  it('keeps anonymous-identity in PostgreSQL, failing closed when it cannot count', async () => {
    const refused = await request(app.getHttpServer())
      .post('/test/outage/anonymous')
      .set('x-market-id', 'AU')
      .send({});

    // The test application's database is unreachable: the sensitive class answers 503, as before.
    expect(refused.status).toBe(503);
    expect(refused.body).toEqual({ statusCode: 503, code: 'access.unavailable' });
  });
});
