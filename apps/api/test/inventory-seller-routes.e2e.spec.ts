import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal, ok, err } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { CreateSource } from '../src/modules/inventory/application/use-cases/create-source.use-case';
import { EditSource } from '../src/modules/inventory/application/use-cases/edit-source.use-case';
import { ListSources } from '../src/modules/inventory/application/use-cases/list-sources.use-case';
import { ReorderSources } from '../src/modules/inventory/application/use-cases/reorder-sources.use-case';
import { ViewOfferStock } from '../src/modules/inventory/application/use-cases/view-offer-stock.use-case';
import { SetStockLevel } from '../src/modules/inventory/application/use-cases/set-stock-level.use-case';
import { SELLER_INVENTORY_STATUS } from '../src/modules/inventory/presentation/seller-inventory.controller';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller inventory routes over HTTP: the real guards and controller; the five use cases are
// stubs, so this proves the session, CSRF token, closed bodies, the status of each refusal, the
// answer shape and `no-store`. The use cases have their own specs.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const SELLER = id<'Seller'>(0xb020);
const SOURCE = id<'InventorySource'>(0xc010);
const OFFER = id<'Offer'>(0xc001);
const VARIANT = id<'Variant'>(0xc002);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const VIEW = {
  version: 2,
  max: 4,
  sources: [
    {
      id: SOURCE,
      name: 'Default',
      isDefault: true,
      position: 1,
      address: null,
      timeZone: null,
      createdAt: START,
    },
  ],
};

describe('seller inventory routes over HTTP', () => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; input: unknown }[];
  const http = () => request(app!.getHttpServer());
  const stub = (name: string) => ({
    execute: (_c: unknown, input: unknown) => {
      calls.push({ name, input });
      return Promise.resolve(next);
    },
  });

  async function boot() {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ListSources)
          .useValue(stub('list'))
          .overrideProvider(CreateSource)
          .useValue(stub('create'))
          .overrideProvider(EditSource)
          .useValue(stub('edit'))
          .overrideProvider(ReorderSources)
          .useValue(stub('reorder'))
          .overrideProvider(SetStockLevel)
          .useValue(stub('stock'))
          .overrideProvider(ViewOfferStock)
          .useValue(stub('view-stock')),
    }));
  }
  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app!.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'price-0001'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    fakes.seedAccount({
      id: OWNER,
      marketId,
      population: 'seller',
      email: { typed: 'Owner@Example.com', normalized: 'owner@example.com' },
      displayName: 'Owner',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe001),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xf001),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  }

  function sessionOf(code: string) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf101),
        marketId: code as AccountState['marketId'],
        accountId: OWNER,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const form = { expectedVersion: 1, name: 'Shed', address: null, timeZone: null };
  const call = (
    method: 'get' | 'post' | 'put',
    code: string,
    path: string,
    headers: Record<string, string>,
    payload?: unknown,
  ) => {
    const req = http()
      [method](path)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });
    return payload === undefined ? req : req.send(payload as object);
  };
  const STOCK = `/inventory/seller/offers/${OFFER}/variants/${VARIANT}/sources/${SOURCE}/stock`;

  const STOCK_READ = `/inventory/seller/offers/${OFFER}/stock`;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = ok(VIEW);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps every refusal code of the use cases to its exact status', () => {
    expect(SELLER_INVENTORY_STATUS).toEqual({
      'validation.failed': 400,
      'inventory.not-found': 404,
      'inventory.source.not-found': 404,
      'inventory.not-ready': 409,
      'conflict.stale': 409,
      'inventory.sources.limit-reached': 422,
      'inventory.sources.order-mismatch': 422,
      'inventory.stock.below-held': 422,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the sources with no-store and serialises the creation instant', async () => {
      await boot();
      await seeded(code);

      const listed = await call('get', code, '/inventory/seller/sources', sessionOf(code));

      expect(listed.status).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({ version: 2, max: 4 });
      expect((listed.body as { sources: { createdAt: string }[] }).sources[0]?.createdAt).toBe(
        START.toString(),
      );
    });

    it('creates, edits and reorders, passing the closed body to the use case', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      expect((await call('post', code, '/inventory/seller/sources', session, form)).status).toBe(
        201,
      );
      expect(
        (await call('put', code, `/inventory/seller/sources/${SOURCE}`, session, form)).status,
      ).toBe(200);
      const order = { expectedVersion: 1, orderedSourceIds: [SOURCE] };
      expect(
        (await call('put', code, '/inventory/seller/sources-order', session, order)).status,
      ).toBe(200);

      expect(calls.map((c) => c.name)).toEqual(['create', 'edit', 'reorder']);
      expect(calls[1]?.input).toMatchObject({ sourceId: SOURCE, name: 'Shed' });
    });

    it('sets a stock level and answers only the item, level, version and change flag', async () => {
      await boot();
      await seeded(code);
      next = ok({
        stockItemId: id<'StockItem'>(0xd001),
        onHand: 7,
        version: 2,
        changed: true,
        extra: 1,
      });

      const set = await call('put', code, STOCK, sessionOf(code), {
        onHand: 7,
        expectedVersion: null,
      });

      expect(set.status).toBe(200);
      expect(set.body).toEqual({
        stockItemId: id<'StockItem'>(0xd001),
        onHand: 7,
        version: 2,
        changed: true,
      });
      expect(calls[0]?.input).toEqual({
        offerId: OFFER,
        variantId: VARIANT,
        sourceId: SOURCE,
        onHand: 7,
        expectedVersion: null,
      });
    });

    it('reads the stock of an Offer, shaped per Variant and location, with no-store', async () => {
      await boot();
      await seeded(code);
      const cell = {
        variantId: VARIANT,
        sourceId: SOURCE,
        onHand: 5,
        held: 2,
        version: null,
        retired: false,
      };
      next = ok({
        offerId: OFFER,
        variants: [{ variantId: VARIANT, sources: [{ ...cell, extra: 1 }] }],
      });

      const read = await call('get', code, STOCK_READ, sessionOf(code));

      expect(read.status).toBe(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(read.body).toEqual({
        offerId: OFFER,
        variants: [{ variantId: VARIANT, sources: [cell] }],
      });
      expect(calls).toEqual([{ name: 'view-stock', input: { offerId: OFFER } }]);
    });

    it('refuses the stock read without a session, and maps not found, not ready, denied and invalid', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      // The gate (stubbed here) answers an anonymous caller `access.unauthenticated`.
      next = err({ code: 'access.unauthenticated' });
      expect((await call('get', code, STOCK_READ, {})).status).toBe(401);
      next = err({ code: 'access.seller-not-approved' });
      expect((await call('get', code, STOCK_READ, session)).status).toBe(403);

      next = err({ code: 'inventory.not-found' });
      const foreign = await call('get', code, STOCK_READ, session);
      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual({ statusCode: 404, code: 'inventory.not-found' });
      next = err({ code: 'inventory.not-ready' });
      expect((await call('get', code, STOCK_READ, session)).status).toBe(409);
      next = err({ code: 'access.denied' });
      expect((await call('get', code, STOCK_READ, session)).status).toBe(403);
      next = err({ code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] });
      const invalid = await call('get', code, '/inventory/seller/offers/not-a-uuid/stock', session);
      expect(invalid.status).toBe(400);
    });

    it('refuses without CSRF or a session, and for unknown or missing body fields', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      const noCsrf = await call(
        'post',
        code,
        '/inventory/seller/sources',
        { cookie: session.cookie },
        form,
      );
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const extra = await call('put', code, STOCK, session, {
        onHand: 1,
        expectedVersion: null,
        sellerId: 'x',
      });
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({
        details: { fields: [{ path: 'sellerId', code: 'unknown-field' }] },
      });
      const missing = await call('put', code, STOCK, session, { onHand: 1 });
      expect(missing.body).toMatchObject({
        details: { fields: [{ path: 'expectedVersion', code: 'required' }] },
      });
      expect(calls).toHaveLength(0);
    });

    it('maps refusals to statuses with their details', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code);

      next = err({ code: 'inventory.sources.limit-reached', details: { max: 4 } });
      const limit = await call('post', code, '/inventory/seller/sources', session, form);
      expect(limit.status).toBe(422);
      expect(limit.body).toEqual({
        statusCode: 422,
        code: 'inventory.sources.limit-reached',
        details: { max: 4 },
      });

      next = err({ code: 'validation.failed', fields: [{ path: 'name', code: 'length' }] });
      const invalid = await call('post', code, '/inventory/seller/sources', session, form);
      expect(invalid.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'name', code: 'length' }] },
      });

      next = err({ code: 'inventory.not-found' });
      expect(
        (await call('put', code, STOCK, session, { onHand: 1, expectedVersion: null })).status,
      ).toBe(404);
      next = err({ code: 'inventory.stock.below-held', details: { min: 3 } });
      expect(
        (await call('put', code, STOCK, session, { onHand: 1, expectedVersion: null })).status,
      ).toBe(422);
      next = err({ code: 'conflict.stale' });
      expect(
        (await call('put', code, STOCK, session, { onHand: 1, expectedVersion: 1 })).status,
      ).toBe(409);
      next = err({ code: 'access.denied' });
      expect((await call('get', code, '/inventory/seller/sources', session)).status).toBe(403);
    });
  });
});
