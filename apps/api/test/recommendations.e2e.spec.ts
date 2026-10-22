import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CERTIFIED_CATEGORIES_READER } from '../src/modules/certification/application/ports/tokens';
import { BEHAVIOUR_EVENT_REPOSITORY } from '../src/modules/engagement/application/ports/behaviour-event.repository';
import { PERSONALIZATION_SETTING_REPOSITORY } from '../src/modules/engagement/application/ports/personalization-setting.repository';
import {
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
} from '../src/modules/engagement/application/testing/in-memory-engagement';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import type { OfferHit } from '../src/modules/search/domain/offer-document';
import { PUBLIC_VISIBILITY } from '../src/modules/search/application/ports/public-visibility';
import { SHELF_DOCUMENTS_READER } from '../src/modules/search/application/ports/shelf-documents.reader';
import { SHELF_SOURCES } from '../src/modules/search/application/ports/shelf-sources';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The personal shelves over HTTP (personalization 1d-1): GET /engagement/recommendations/
// recently-viewed and GET /search/for-you, for a guest and a signed-in customer, with the real
// guards, controllers, use cases and engagement facade; the stores are in memory and the search
// sources are stubs. Proves that the shopper comes from the session or the guest cookie (never the
// query), the privacy rules (Sec-GPC, the customer's switch, guest consent), `no-store` on every
// answer, that no cookie is ever set, extended or cleared, the closed query string and the bounds
// of `limit`, that certified categories are no signal, and `search.unavailable`.

const START = Temporal.Instant.from('2026-10-21T09:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xa301);
const SELLER = id<'Seller'>(0x51);
const MEAT = id<'Category'>(0xc2);
const HALAL = id<'Category'>(0xc3);
const GROCERY = id<'Category'>(0xc1);
const offer = (n: number) => id<'Offer'>(0x1000 + n);
const product = (n: number) => id<'Product'>(0x900 + n);
const hit = (n: number, categoryIds: Id<'Category'>[]): OfferHit => ({
  offerId: offer(n),
  productId: product(n),
  sellerId: SELLER,
  name: `Product ${n}`,
  shortText: null,
  categoryIds,
  rank: 0,
});
const CONSENT = { 'engagement-consent': 'granted' };
const fakes = new IdentityFakes();
const sessionTokens = new RandomSessionTokens();

describe('personal shelves over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let events: InMemoryBehaviourEvents;
  let settings: InMemoryPersonalizationSettings;
  let clock: FixedClock;
  let documents: OfferHit[];
  let ranked: Id<'Offer'>[] | null;
  let hidden: Set<Id<'Offer'>>;
  let certified: Id<'Category'>[];
  const http = () => request(app!.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(BEHAVIOUR_EVENT_REPOSITORY)
          .useValue(events)
          .overrideProvider(PERSONALIZATION_SETTING_REPOSITORY)
          .useValue(settings)
          .overrideProvider(CERTIFIED_CATEGORIES_READER)
          .useValue({ categoryIds: () => Promise.resolve(certified) })
          .overrideProvider(SHELF_SOURCES)
          .useValue({
            bestSellingOfferIds: () => Promise.resolve(ranked),
            specials: () => Promise.resolve([]),
          })
          .overrideProvider(PUBLIC_VISIBILITY)
          .useValue({
            visible: (_context: CallContext, offers: readonly { offerId: Id<'Offer'> }[]) =>
              Promise.resolve(
                new Set(offers.filter((o) => !hidden.has(o.offerId)).map((o) => o.offerId)),
              ),
          })
          .overrideProvider(SHELF_DOCUMENTS_READER)
          .useValue({
            byOfferIds: (_m: MarketContext, offerIds: readonly Id<'Offer'>[]) =>
              Promise.resolve(documents.filter((d) => offerIds.includes(d.offerId))),
            byProductId: () => Promise.resolve([]),
            byProductIds: (
              _m: MarketContext,
              productIds: readonly Id<'Product'>[],
              perProduct: number,
            ) =>
              Promise.resolve(
                productIds.flatMap((p) =>
                  documents.filter((d) => d.productId === p).slice(0, perProduct),
                ),
              ),
            browseAll: (_m: MarketContext, limit: number) =>
              Promise.resolve(
                [...documents].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit),
              ),
          }),
    }));
  }

  function customerSession(code: string) {
    const marketId = code as AccountState['marketId'];
    fakes.seedAccount({
      id: ACCOUNT,
      marketId,
      population: 'customer',
      email: { typed: 'Shopper@Example.com', normalized: 'shopper@example.com' },
      displayName: null,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    const issued = sessionTokens.issue();
    void fakes.sessionRepository.add(
      { marketId, tenantId: 'default' } as never,
      openSession({
        id: id<'Session'>(0xf301),
        marketId,
        accountId: ACCOUNT,
        population: 'customer',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      cookie: `__Host-session-customer-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  /** A guest who accepted the cookie and viewed these products and categories; the cookie. */
  async function guestWithViews(
    code: string,
    views: readonly Record<string, unknown>[],
  ): Promise<string> {
    let cookie = '';
    for (const view of views) {
      clock.set(clock.now().add({ seconds: 1 }));
      const response = await http()
        .post('/engagement/events')
        .set({ 'x-market-id': code, ...CONSENT, ...(cookie === '' ? {} : { cookie }) })
        .send(view);
      const setCookie = ([] as string[]).concat(response.headers['set-cookie'] ?? [])[0];
      if (setCookie !== undefined) cookie = setCookie.split(';')[0]!;
    }
    return cookie;
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    events = new InMemoryBehaviourEvents();
    settings = new InMemoryPersonalizationSettings();
    certified = [];
    hidden = new Set();
    // Best sellers in rank order: 1 grocery, 2 meat, 3 grocery, 4 halal meat.
    documents = [hit(1, [GROCERY]), hit(2, [MEAT]), hit(3, [GROCERY]), hit(4, [MEAT, HALAL])];
    ranked = [1, 2, 3, 4].map(offer);
  });
  afterEach(async () => {
    await app?.close();
  });

  const view = (n: number) => ({ kind: 'product-viewed', productId: product(n) });
  const viewCategory = (categoryId: Id<'Category'>) => ({ kind: 'category-viewed', categoryId });
  const offersOf = (body: unknown) =>
    (body as { items: { offerId: string }[] }).items.map((i) => i.offerId);
  const codeOf = (body: unknown) => (body as { code?: string }).code;

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const base = { 'x-market-id': code };

    describe('GET /engagement/recommendations/recently-viewed', () => {
      const PATH = '/engagement/recommendations/recently-viewed';

      it('lists what a consenting guest viewed, newest first, with no-store and no cookie', async () => {
        await boot();
        const cookie = await guestWithViews(code, [view(3), view(1), view(3)]);

        const response = await http()
          .get(PATH)
          .set({ ...base, ...CONSENT, cookie });

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(offersOf(response.body)).toEqual([offer(3), offer(1)]);
        expect(Object.keys((response.body as { items: object[] }).items[0]!).sort()).toEqual(
          [
            'categoryIds',
            'name',
            'offerId',
            'primaryImage',
            'productId',
            'sellerId',
            'shortText',
          ].sort(),
        );
        expect(events.rows).toHaveLength(3);
      });

      it('is empty under Sec-GPC, without consent and without a cookie, and sets no cookie', async () => {
        await boot();
        const cookie = await guestWithViews(code, [view(1)]);
        const empty = { items: [] };

        for (const headers of [
          { ...CONSENT, cookie, 'sec-gpc': '1' },
          { cookie },
          { ...CONSENT, cookie: `__Host-engagement-guest-${code}=${'g'.repeat(43)}` },
          { ...CONSENT },
          { 'engagement-consent': 'denied', cookie },
        ]) {
          const response = await http()
            .get(PATH)
            .set({ ...base, ...headers });
          expect(response.status).toBe(200);
          expect(response.body).toEqual(empty);
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.headers['set-cookie']).toBeUndefined();
        }
      });

      it('never takes the subject from the query string or another Market', async () => {
        await boot();
        const cookie = await guestWithViews(code, [view(1)]);
        const other = code === 'AU' ? 'ZZ' : 'AU';

        const query = await http()
          .get(`${PATH}?accountId=${ACCOUNT}&guestToken=x&account=${ACCOUNT}`)
          .set({ ...base, ...CONSENT, cookie });
        expect(query.status).toBe(400);
        expect(query.body).toEqual({
          statusCode: 400,
          code: 'validation.failed',
          details: {
            fields: [
              { path: 'account', code: 'unknown-field' },
              { path: 'accountId', code: 'unknown-field' },
              { path: 'guestToken', code: 'unknown-field' },
            ],
          },
        });
        expect(query.headers['cache-control']).toBe('no-store');
        expect(query.headers['set-cookie']).toBeUndefined();

        // The other Market's cookie name differs, so this guest is nobody there.
        const elsewhere = await http()
          .get(PATH)
          .set({ 'x-market-id': other, ...CONSENT, cookie });
        expect(elsewhere.body).toEqual({ items: [] });
      });

      it('bounds limit to 1 to 24 and defaults it to 12', async () => {
        await boot();
        documents = [...Array(20).keys()].map((n) => hit(10 + n, [GROCERY]));
        const cookie = await guestWithViews(
          code,
          [...Array(20).keys()].map((n) => view(10 + n)),
        );
        const call = (query: string) =>
          http()
            .get(`${PATH}${query}`)
            .set({ ...base, ...CONSENT, cookie });

        expect(offersOf((await call('')).body)).toHaveLength(12);
        expect(offersOf((await call('?limit=1')).body)).toHaveLength(1);
        expect(offersOf((await call('?limit=24')).body)).toHaveLength(20);
        for (const bad of ['0', '25', '-1', '1.5', 'abc', '', '1e1', '%20']) {
          const response = await call(`?limit=${bad}`);
          expect(response.status).toBe(400);
          expect(codeOf(response.body)).toBe('validation.failed');
          expect(response.headers['cache-control']).toBe('no-store');
        }
        const twice = await call('?limit=2&limit=3');
        expect(twice.status).toBe(400);
      });

      it('drops a product that is not sellable now', async () => {
        await boot();
        const cookie = await guestWithViews(code, [view(1), view(2)]);
        hidden = new Set([offer(2)]);

        const response = await http()
          .get(PATH)
          .set({ ...base, ...CONSENT, cookie });

        expect(offersOf(response.body)).toEqual([offer(1)]);
      });

      it('answers search.unavailable, still no-store, when the check cannot be made', async () => {
        await boot();
        const cookie = await guestWithViews(code, [view(1)]);
        // A visibility that throws is a failed check.
        await app!.close();
        ({ app } = await createTestApp({
          override: (builder) =>
            fakes
              .override(builder)
              .overrideProvider(CLOCK)
              .useValue(clock)
              .overrideProvider(BEHAVIOUR_EVENT_REPOSITORY)
              .useValue(events)
              .overrideProvider(PERSONALIZATION_SETTING_REPOSITORY)
              .useValue(settings)
              .overrideProvider(PUBLIC_VISIBILITY)
              .useValue({ visible: () => Promise.resolve(null) })
              .overrideProvider(SHELF_DOCUMENTS_READER)
              .useValue({
                byProductIds: () => Promise.resolve(documents),
                byOfferIds: () => Promise.resolve([]),
                byProductId: () => Promise.resolve([]),
                browseAll: () => Promise.resolve([]),
              }),
        }));

        const response = await http()
          .get(PATH)
          .set({ ...base, ...CONSENT, cookie });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'search.unavailable' });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(response.body)).not.toContain(cookie.split('=')[1]);
      });

      it("lists a signed-in customer's views from the session, and nothing when the switch is off or under Sec-GPC", async () => {
        await boot();
        const headers = customerSession(code);
        for (const n of [2, 4]) {
          clock.set(clock.now().add({ seconds: 1 }));
          const recorded = await http().post('/engagement/events').set(headers).send(view(n));
          expect(recorded.body).toEqual({ recorded: true });
        }

        const mine = await http().get(PATH).set(headers);
        expect(mine.status).toBe(200);
        expect(mine.headers['cache-control']).toBe('no-store');
        expect(mine.headers['set-cookie']).toBeUndefined();
        expect(offersOf(mine.body)).toEqual([offer(4), offer(2)]);

        // Sec-GPC wins for a customer too.
        const stray = await http()
          .get(PATH)
          .set({ ...headers, 'sec-gpc': '1' });
        expect(stray.body).toEqual({ items: [] });

        const off = await http()
          .put('/customers/me/personalization')
          .set(headers)
          .send({ enabled: false });
        expect(off.status).toBe(200);
        expect((await http().get(PATH).set(headers)).body).toEqual({ items: [] });
      });

      it("ignores a consenting guest cookie on a customer request: only the customer's views come back", async () => {
        await boot();
        // A guest who consented and has views of product 1; the customer has viewed product 2.
        const guestCookie = await guestWithViews(code, [view(1)]);
        const headers = customerSession(code);
        await http().post('/engagement/events').set(headers).send(view(2));

        const response = await http()
          .get(PATH)
          .set({ ...headers, ...CONSENT, cookie: `${headers.cookie}; ${guestCookie}` });

        expect(response.status).toBe(200);
        expect(offersOf(response.body)).toEqual([offer(2)]);
        expect(response.headers['set-cookie']).toBeUndefined();
      });

      it('shows nothing of one customer to another or to a guest', async () => {
        await boot();
        const headers = customerSession(code);
        await http().post('/engagement/events').set(headers).send(view(1));

        const guest = await http()
          .get(PATH)
          .set({ ...base, ...CONSENT });
        expect(guest.body).toEqual({ items: [] });
        const stolen = await http()
          .get(`${PATH}?account=${ACCOUNT}`)
          .set({ ...base, ...CONSENT });
        expect(stolen.status).toBe(400);
      });
    });

    describe('GET /search/for-you', () => {
      const PATH = '/search/for-you';

      it('puts the best sellers in the viewed categories first for a consenting guest', async () => {
        await boot();
        const cookie = await guestWithViews(code, [viewCategory(MEAT)]);

        const response = await http()
          .get(PATH)
          .set({ ...base, ...CONSENT, cookie });

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.headers['set-cookie']).toBeUndefined();
        expect(offersOf(response.body)).toEqual([2, 4, 1, 3].map(offer));
      });

      it('never uses a certified category as a signal', async () => {
        await boot();
        certified = [HALAL, MEAT];
        const cookie = await guestWithViews(code, [viewCategory(HALAL), viewCategory(MEAT)]);

        const response = await http()
          .get(PATH)
          .set({ ...base, ...CONSENT, cookie });

        expect(offersOf(response.body)).toEqual([1, 2, 3, 4].map(offer));
      });

      it('is the Market best sellers under Sec-GPC, without consent, without a cookie, or for a bad cookie', async () => {
        await boot();
        const cookie = await guestWithViews(code, [viewCategory(MEAT)]);
        const plain = [1, 2, 3, 4].map(offer);

        for (const headers of [
          { ...CONSENT, cookie, 'sec-gpc': '1' },
          { cookie },
          { ...CONSENT },
          { ...CONSENT, cookie: `__Host-engagement-guest-${code}=${'g'.repeat(43)}` },
          { ...CONSENT, cookie: `__Host-engagement-guest-${code}=short` },
        ]) {
          const response = await http()
            .get(PATH)
            .set({ ...base, ...headers });
          expect(response.status).toBe(200);
          expect(offersOf(response.body)).toEqual(plain);
          expect(response.headers['cache-control']).toBe('no-store');
          expect(response.headers['set-cookie']).toBeUndefined();
        }
      });

      it("uses a signed-in customer's views from the session until the switch is off", async () => {
        await boot();
        const headers = customerSession(code);
        await http().post('/engagement/events').set(headers).send(viewCategory(MEAT));

        const personal = await http().get(PATH).set(headers);
        expect(offersOf(personal.body)).toEqual([2, 4, 1, 3].map(offer));
        expect(personal.headers['set-cookie']).toBeUndefined();

        const gpc = await http()
          .get(PATH)
          .set({ ...headers, 'sec-gpc': '1' });
        expect(offersOf(gpc.body)).toEqual([1, 2, 3, 4].map(offer));

        await http().put('/customers/me/personalization').set(headers).send({ enabled: false });
        const off = await http().get(PATH).set(headers);
        expect(offersOf(off.body)).toEqual([1, 2, 3, 4].map(offer));
      });

      it('ignores a consenting guest cookie on a customer request', async () => {
        await boot();
        const guestCookie = await guestWithViews(code, [viewCategory(MEAT)]);
        const headers = customerSession(code);
        await http().post('/engagement/events').set(headers).send(viewCategory(GROCERY));

        const response = await http()
          .get(PATH)
          .set({ ...headers, ...CONSENT, cookie: `${headers.cookie}; ${guestCookie}` });

        // The customer's grocery view leads, not the guest's meat view.
        expect(offersOf(response.body)).toEqual([1, 3, 2, 4].map(offer));
      });

      it('takes the subject from nowhere but the session or the cookie, and bounds limit', async () => {
        await boot();
        const cookie = await guestWithViews(code, [viewCategory(MEAT)]);
        const call = (query: string) =>
          http()
            .get(`${PATH}${query}`)
            .set({ ...base, ...CONSENT, cookie });

        for (const query of [
          `?account=${ACCOUNT}`,
          '?category=x',
          '?guest=1',
          '?limit=0',
          '?limit=25',
          '?limit=abc',
        ]) {
          const response = await call(query);
          expect(response.status).toBe(400);
          expect(codeOf(response.body)).toBe('validation.failed');
          expect(response.headers['cache-control']).toBe('no-store');
        }
        expect(offersOf((await call('?limit=2')).body)).toEqual([2, 4].map(offer));
        expect(offersOf((await call('?limit=24')).body)).toHaveLength(4);
      });

      it('drops an Offer that is not sellable now and answers search.unavailable when ordering fails', async () => {
        await boot();
        hidden = new Set([offer(1)]);
        const dropped = await http()
          .get(PATH)
          .set({ ...base });
        expect(offersOf(dropped.body)).toEqual([2, 3, 4].map(offer));

        ranked = null;
        const failed = await http()
          .get(PATH)
          .set({ ...base });
        expect(failed.status).toBe(503);
        expect(failed.body).toMatchObject({ code: 'search.unavailable' });
        expect(failed.headers['cache-control']).toBe('no-store');
      });
    });
  });
});
