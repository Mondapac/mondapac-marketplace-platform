import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { OfferHit } from '../src/modules/search/domain/offer-document';
import { PUBLIC_VISIBILITY } from '../src/modules/search/application/ports/public-visibility';
import { SHELF_DOCUMENTS_READER } from '../src/modules/search/application/ports/shelf-documents.reader';
import { SHELF_SOURCES } from '../src/modules/search/application/ports/shelf-sources';
import { CLOCK } from '../src/platform/clock/clock.module';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// GET /search/bought-together over HTTP (personalization 1d-2), with the real guards, controller
// and use case; ordering's pairs, the read model and the visibility check are stubs. Proves: no
// session is read (an anonymous call works and sets no cookie), `no-store` on every answer, the
// closed query string, a bad or missing Offer id and the bounds of `limit` are 400, the asked
// Offer is never in the answer, Offers catalog or sellers no longer show are dropped, the item
// shape is the shelves', a failed check is `search.unavailable`, and the route is in the
// checked-in list of anonymous routes.

const START = Temporal.Instant.from('2026-10-25T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const offer = (n: number) => id<'Offer'>(0x1000 + n);
const hit = (n: number): OfferHit => ({
  offerId: offer(n),
  productId: id<'Product'>(0x900 + n),
  sellerId: id<'Seller'>(0x51),
  name: `Product ${n}`,
  shortText: null,
  categoryIds: [id<'Category'>(0xc1)],
  rank: 0,
});
const fakes = new IdentityFakes();
const offersOf = (body: unknown) =>
  (body as { items: { offerId: string }[] }).items.map((i) => i.offerId);

describe('bought together over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let documents: OfferHit[];
  let partners: Id<'Offer'>[] | null;
  let hidden: Set<Id<'Offer'>>;
  let checkFails: boolean;
  const asked: { actor: string; offerId: string; limit: number }[] = [];
  const http = () => request(app!.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(SHELF_SOURCES)
          .useValue({
            bestSellingOfferIds: () => Promise.resolve([]),
            specials: () => Promise.resolve([]),
            boughtTogetherOfferIds: (context: CallContext, offerId: Id<'Offer'>, limit: number) => {
              asked.push({ actor: context.actor.kind, offerId, limit });
              return Promise.resolve(partners);
            },
          })
          .overrideProvider(PUBLIC_VISIBILITY)
          .useValue({
            visible: (_context: CallContext, offers: readonly { offerId: Id<'Offer'> }[]) =>
              checkFails
                ? Promise.resolve(null)
                : Promise.resolve(
                    new Set(offers.filter((o) => !hidden.has(o.offerId)).map((o) => o.offerId)),
                  ),
          })
          .overrideProvider(SHELF_DOCUMENTS_READER)
          .useValue({
            byOfferIds: (_m: MarketContext, offerIds: readonly Id<'Offer'>[]) =>
              Promise.resolve(documents.filter((d) => offerIds.includes(d.offerId))),
            byProductId: () => Promise.resolve([]),
            byProductIds: () => Promise.resolve([]),
            browseAll: () => Promise.resolve([]),
          }),
    }));
  }

  beforeEach(() => {
    fakes.reset();
    asked.length = 0;
    documents = [1, 2, 3, 4, 5].map(hit);
    partners = [offer(3), offer(1), offer(2), offer(5)];
    hidden = new Set();
    checkFails = false;
  });
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const base = { 'x-market-id': code };
    const path = (query: string) => `/search/bought-together?${query}`;

    it('answers the partners in rank order without the asked Offer, no-store, no cookie', async () => {
      await boot();

      const response = await http()
        .get(path(`offer=${offer(1)}`))
        .set(base);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(offersOf(response.body)).toEqual([offer(3), offer(2), offer(5)]);
      expect(Object.keys((response.body as { items: object[] }).items[0]!).sort()).toEqual([
        'categoryIds',
        'name',
        'offerId',
        'primaryImage',
        'productId',
        'sellerId',
        'shortText',
      ]);
      expect(asked).toEqual([{ actor: 'anonymous', offerId: offer(1), limit: 24 }]);
    });

    it('ignores any session, cookie or header about the shopper', async () => {
      await boot();

      const response = await http()
        .get(path(`offer=${offer(1)}`))
        .set({ ...base, cookie: `__Host-session-customer-${code}=junk`, 'sec-gpc': '1' });

      expect(response.status).toBe(200);
      expect(offersOf(response.body)).toEqual([offer(3), offer(2), offer(5)]);
      expect(asked.map((a) => a.actor)).toEqual(['anonymous']);
    });

    it('drops an Offer that catalog or sellers no longer show, and caps at the limit', async () => {
      await boot();
      hidden.add(offer(3));

      const all = await http()
        .get(path(`offer=${offer(1)}`))
        .set(base);
      const one = await http()
        .get(path(`offer=${offer(1)}&limit=1`))
        .set(base);

      expect(offersOf(all.body)).toEqual([offer(2), offer(5)]);
      expect(offersOf(one.body)).toEqual([offer(2)]);
    });

    it('answers an empty list, not an error, when the asked Offer itself is no longer shown', async () => {
      await boot();
      hidden.add(offer(1));

      const response = await http()
        .get(path(`offer=${offer(1)}`))
        .set(base);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [] });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('answers an empty list when nothing is paired', async () => {
      await boot();
      partners = [];

      const response = await http()
        .get(path(`offer=${offer(1)}`))
        .set(base);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ items: [] });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('answers search.unavailable, no-store, when the source or the check cannot be made', async () => {
      await boot();
      partners = null;
      const source = await http()
        .get(path(`offer=${offer(1)}`))
        .set(base);
      partners = [offer(2)];
      checkFails = true;
      const check = await http()
        .get(path(`offer=${offer(1)}`))
        .set(base);

      for (const response of [source, check]) {
        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'search.unavailable' });
        expect(response.headers['cache-control']).toBe('no-store');
      }
    });

    it.each([
      ['', [{ path: 'offer', code: 'required' }]],
      ['offer=not-a-uuid', [{ path: 'offer', code: 'format' }]],
      [`offer=${offer(1)}&limit=0`, [{ path: 'limit', code: 'range' }]],
      [`offer=${offer(1)}&limit=25`, [{ path: 'limit', code: 'range' }]],
      [`offer=${offer(1)}&limit=abc`, [{ path: 'limit', code: 'range' }]],
      [`offer=${offer(1)}&limit=1.5`, [{ path: 'limit', code: 'range' }]],
      [`offer=${offer(1)}&category=${offer(2)}`, [{ path: 'category', code: 'unknown-field' }]],
      [`offer=${offer(1)}&accountId=${offer(2)}`, [{ path: 'accountId', code: 'unknown-field' }]],
      [`offer=${offer(1)}&offer=${offer(2)}`, [{ path: 'offer', code: 'type' }]],
      [`offer=${offer(1)}&limit=1&limit=2`, [{ path: 'limit', code: 'type' }]],
      ['offer=', [{ path: 'offer', code: 'format' }]],
    ])('refuses ?%s with 400, no-store, before any read', async (query, fields) => {
      await boot();

      const response = await http().get(path(query)).set(base);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields },
      });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(asked).toEqual([]);
    });

    it('bounds limit to 1 to 24 and defaults it to 12', async () => {
      await boot();
      documents = [hit(1), ...[...Array(30).keys()].map((n) => hit(10 + n))];
      partners = [...Array(24).keys()].map((n) => offer(10 + n));

      const dflt = await http()
        .get(path(`offer=${offer(1)}`))
        .set(base);
      const max = await http()
        .get(path(`offer=${offer(1)}&limit=24`))
        .set(base);
      const min = await http()
        .get(path(`offer=${offer(1)}&limit=1`))
        .set(base);

      expect(offersOf(dflt.body)).toHaveLength(12);
      expect(offersOf(max.body)).toHaveLength(24);
      expect(offersOf(min.body)).toEqual([offer(10)]);
    });
  });

  it('is on the checked-in list of routes an anonymous caller may reach', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const list = require('./contracts/http-reachable-anonymous-system.json') as {
      name: string;
      rule: string;
      reason: string;
    }[];
    const entry = list.find((e) => e.name === 'search.list-bought-together');
    expect(entry).toMatchObject({ rule: 'anonymous' });
    expect(entry!.reason.length).toBeGreaterThan(40);
  });
});
