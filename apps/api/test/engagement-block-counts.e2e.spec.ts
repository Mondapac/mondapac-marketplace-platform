import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { BLOCK_COUNT_REPOSITORY } from '../src/modules/engagement/application/ports/block-count.repository';
import { SERVED_PLACEMENTS } from '../src/modules/engagement/application/ports/served-placements';
import {
  FakeServedPlacements,
  InMemoryBlockCounts,
} from '../src/modules/engagement/application/testing/in-memory-engagement';
import { CLOCK } from '../src/platform/clock/clock.module';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// POST /engagement/blocks over HTTP (personalization 1d-3, part B), with the real guards,
// controller and use case; the count store and storefront's served placements are in memory.
// Proves: 204 with `no-store`, no session or cookie is read and none is set, a placement not
// served is skipped with the same answer, `Sec-GPC: 1` counts nothing, closed bodies and the
// bounds of the event list are 400, the per-origin rate limit applies, nothing of the body is
// logged, and the route is on the checked-in list of anonymous routes.

const START = Temporal.Instant.from('2026-10-25T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const PAGE = id<'StorefrontPage'>(0xa1);
const HERO = id<'StorefrontPlacement'>(0xb1);
const SHELF = id<'StorefrontPlacement'>(0xb2);
const UNSERVED = id<'StorefrontPlacement'>(0xb3);
const PATH = '/engagement/blocks';
const fakes = new IdentityFakes();
const event = (overrides: Record<string, unknown> = {}) => ({
  pageId: PAGE,
  placementId: HERO,
  type: 'impression',
  ...overrides,
});

describe('block counts over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let logLines: LogLine[];
  let counts: InMemoryBlockCounts;
  let served: FakeServedPlacements;
  const http = () => request(app!.getHttpServer());

  async function boot(code: string) {
    ({ app, logLines } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(BLOCK_COUNT_REPOSITORY)
          .useValue(counts)
          .overrideProvider(SERVED_PLACEMENTS)
          .useValue(served),
    }));
    served.serve(code, PAGE, [HERO, SHELF]);
  }

  beforeEach(() => {
    fakes.reset();
    counts = new InMemoryBlockCounts();
    served = new FakeServedPlacements();
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const base = { 'x-market-id': code };
    const rows = () => [...counts.rows.values()];

    it('counts the events and answers 204, no-store, with no cookie set or read', async () => {
      await boot(code);

      const response = await http()
        .post(PATH)
        .set(base)
        .send({ events: [event(), event({ type: 'click' }), event({ placementId: SHELF })] });

      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(rows().map((row) => [row.placementId, row.impressions, row.clicks, row.day])).toEqual([
        [HERO, 1, 1, '2026-10-25'],
        [SHELF, 1, 0, '2026-10-25'],
      ]);
    });

    it('ignores a session, a cookie and an account sent with the request', async () => {
      await boot(code);

      const response = await http()
        .post(PATH)
        .set({
          ...base,
          cookie: `__Host-session-customer-${code}=abc; __Host-engagement-guest-${code}=${'a'.repeat(43)}`,
          'x-csrf-token': 'not-checked',
          'user-agent': 'Probe/1.0',
          'x-forwarded-for': '203.0.113.9',
        })
        .send({ events: [event()] });

      expect(response.status).toBe(204);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(rows()).toHaveLength(1);
      // The row holds the counts and the block, nothing else.
      expect(JSON.stringify(rows())).not.toMatch(/Probe|203\.0\.113|session|guest|abc/);
    });

    it('answers the same 204 for a placement that is not served, and counts nothing for it', async () => {
      await boot(code);

      const unserved = await http()
        .post(PATH)
        .set(base)
        .send({ events: [event({ placementId: UNSERVED }), event({ pageId: id(0xdead) })] });
      const served204 = await http()
        .post(PATH)
        .set(base)
        .send({ events: [event()] });

      expect(unserved.status).toBe(204);
      expect(unserved.headers['cache-control']).toBe('no-store');
      expect(unserved.text).toBe(served204.text);
      expect(Object.keys(unserved.headers).sort()).toEqual(Object.keys(served204.headers).sort());
      expect(rows().map((row) => row.placementId)).toEqual([HERO]);
    });

    it('counts nothing with Sec-GPC: 1, and still answers 204 no-store', async () => {
      await boot(code);

      const response = await http()
        .post(PATH)
        .set({ ...base, 'sec-gpc': '1' })
        .send({ events: [event()] });

      expect(response.status).toBe(204);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(rows()).toHaveLength(0);
      expect(served.asked).toEqual([]);
    });

    it('counts identical events of one request once', async () => {
      await boot(code);

      await http()
        .post(PATH)
        .set(base)
        .send({ events: [event(), event(), event({ type: 'click' }), event({ type: 'click' })] })
        .expect(204);

      expect(rows()[0]).toMatchObject({ impressions: 1, clicks: 1 });
    });

    it.each([
      // A key of the body is named (like the other engagement routes); a value never is.
      ['an unknown field in the body', { events: [event()], extra: 1 }, null],
      ['an unknown field in an event', { events: [event({ accountId: 'x' })] }, 'accountId'],
      ['a malformed page id', { events: [event({ pageId: 'nope' })] }, 'nope'],
      ['a malformed placement id', { events: [event({ placementId: 42 })] }, '42'],
      ['an unknown type', { events: [event({ type: 'hover' })] }, 'hover'],
      ['no events', {}, 'events'],
      ['an empty list', { events: [] }, 'events'],
      ['a list that is not a list', { events: 'x' }, 'events'],
      ['more than 20 events', { events: Array.from({ length: 21 }, () => event()) }, 'events'],
    ])('answers 400 for %s, counts nothing and echoes no value', async (_name, body, secret) => {
      await boot(code);

      const response = await http().post(PATH).set(base).send(body);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ statusCode: 400, code: 'validation.failed' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      if (secret !== null && secret !== 'events') {
        expect(JSON.stringify(response.body)).not.toContain(`"${secret}"`);
      }
      expect(rows()).toHaveLength(0);
    });

    it('accepts exactly 20 events', async () => {
      await boot(code);
      const placements = Array.from({ length: 20 }, (_, n) => id<'StorefrontPlacement'>(0x500 + n));
      served.serve(code, PAGE, placements);

      await http()
        .post(PATH)
        .set(base)
        .send({ events: placements.map((placementId) => event({ placementId })) })
        .expect(204);

      expect(rows()).toHaveLength(20);
    });

    it('answers 415 for a body that is not JSON and 400 for one that is not an object', async () => {
      await boot(code);

      const text = await http().post(PATH).set(base).type('text/plain').send('events');
      const list = await http().post(PATH).set(base).send([event()]);

      expect(text.status).toBe(415);
      expect(list.status).toBe(400);
      expect(rows()).toHaveLength(0);
    });

    it('does not log the body, a page id or a placement id', async () => {
      await boot(code);

      await http()
        .post(PATH)
        .set({ ...base, 'x-correlation-id': 'blocks-log-abcd' })
        .send({ events: [event()] })
        .expect(204);

      const text = JSON.stringify(logLines);
      expect(text).not.toContain(PAGE);
      expect(text).not.toContain(HERO);
      expect(logLines.some((line) => line.msg === 'engagement.record-block-events-route')).toBe(
        true,
      );
    });

    it('is rate limited per origin like the other public routes', async () => {
      await boot(code);
      // The Market's default limit: 300 a minute for AU, 200 for the synthetic Market.
      const limit = code === 'AU' ? 300 : 200;
      for (let n = 0; n < limit; n += 1) {
        const ok = await http()
          .post(PATH)
          .set(base)
          .send({ events: [event()] });
        if (ok.status !== 204) throw new Error(`request ${n} answered ${ok.status}`);
      }

      const refused = await http()
        .post(PATH)
        .set(base)
        .send({ events: [event()] });

      expect(refused.status).toBe(429);
      expect(refused.body).toMatchObject({ statusCode: 429, code: 'request.throttled' });
      expect(refused.headers['set-cookie']).toBeUndefined();
      expect(rows()[0]).toMatchObject({ impressions: limit });
    });
  });

  it('refuses a request without a Market before the use case runs', async () => {
    await boot('AU');

    const response = await http()
      .post(PATH)
      .send({ events: [event()] });

    expect(response.status).toBe(400);
    expect(counts.rows.size).toBe(0);
  });

  it('is on the checked-in list of routes an anonymous caller may reach', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const list = require('./contracts/http-reachable-anonymous-system.json') as {
      name: string;
      rule: string;
      reason: string;
    }[];
    const entry = list.find((e) => e.name === 'engagement.record-block-events');
    expect(entry).toMatchObject({ rule: 'anonymous' });
    expect(entry!.reason.length).toBeGreaterThan(40);
  });
});
