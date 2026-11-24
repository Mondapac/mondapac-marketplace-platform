import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { LEDGER_KPI_READER } from '../src/modules/reporting/application/ports/ledger-kpi-reader';
import { EMPTY_LEDGER_SUMS } from '../src/modules/reporting/domain/ledger';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// GET reporting/seller/net-earnings over HTTP with the REAL guards, gate, role seed and use case;
// only the ledger reader (a fixed answer) and the clock are fakes. Proved in both Market
// fixtures: the seller owner reads it; a member whose role lacks `commission-payouts.earnings.view`
// is 403 access.denied; an unknown period and a repeated `period` are 400 with `no-store`; an
// admin cookie and no cookie are 401.

const START = Temporal.Instant.from('2026-11-22T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0x5e22);
const OWNER = id<'Account'>(0xa211);
const MEMBER = id<'Account'>(0xa212);
const ADMIN = id<'Account'>(0xa011);
const NO_KEY_ROLE = id<'Role'>(0xb811);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)(
  'the seller net earnings over HTTP, real gate, in market %s',
  (code) => {
    let app: NestExpressApplication | undefined;
    const http = () => request(app!.getHttpServer());
    const marketId = code as AccountState['marketId'];
    const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
    const reads: unknown[] = [];

    const reader = {
      rangeSums: (_market: unknown, _currency: string, range: unknown, sellerId: unknown) => {
        reads.push({ range, sellerId });
        return Promise.resolve({
          sums: {
            ...EMPTY_LEDGER_SUMS,
            commission: { amount: 1500n, baseAmount: 10_000n },
          },
          refreshedAt: null,
        });
      },
      // A week with a matched seller order each day: the readiness is met.
      matchFacts: (_market: unknown, _currency: string, window: { from: string; to: string }) => {
        const rows = Array.from({ length: 7 }, (_, n) => ({
          sellerOrderId: `so-${n}`,
          day: Temporal.PlainDate.from(window.to).subtract({ days: n }).toString(),
        }));
        return Promise.resolve({ paid: rows, commission: rows, knownUnpaid: new Set<string>() });
      },
      backfillState: () => Promise.resolve({ finished: true, failedFacts: 0 }),
    };

    async function boot() {
      ({ app } = await createTestApp({
        panelOrigins: true,
        override: (builder) =>
          fakes
            .override(builder)
            .overrideProvider(CLOCK)
            .useValue(new FixedClock(START))
            .overrideProvider(LEDGER_KPI_READER)
            .useValue(reader),
      }));
      await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'net-0001'), {});
      const ownerRole = [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
      )!.id;
      fakes.seedRole({
        id: NO_KEY_ROLE,
        marketId,
        scope: 'seller',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: SELLER,
        name: 'Team only',
        permissionKeys: ['identity.team-member.view'],
        version: 1,
        createdAt: START,
      });
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
      let n = 0;
      for (const [accountId, population, label, roleId] of [
        [OWNER, 'seller', 'owner', ownerRole],
        [MEMBER, 'seller', 'member', NO_KEY_ROLE],
        [ADMIN, 'admin', 'admin', null],
      ] as const) {
        n += 1;
        fakes.seedAccount({
          id: accountId,
          marketId,
          population,
          email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
          displayName: label,
          status: 'active',
          emailVerifiedAt: START,
          existingAccountNoticeAt: null,
          signedUpAt: START,
          createdAt: START,
          version: 1,
          credential: { passwordHash: fakeHashOf('x'), changedAt: START },
        });
        if (roleId !== null) {
          fakes.seedAssignment({
            id: id<'RoleAssignment'>(0xea10 + n),
            marketId,
            accountId,
            roleId,
            assignedByAccountId: null,
            assignedAt: START,
            version: 1,
          });
          fakes.seedMembership({
            id: id<'SellerMembership'>(0xeb10 + n),
            marketId,
            accountId,
            sellerId: SELLER,
            state: 'active',
            removedAt: null,
            version: 1,
            createdAt: START,
          });
        }
      }
    }

    function cookieOf(account: Id<'Account'>, population: 'seller' | 'admin', n: number) {
      const issued = tokens.issue();
      void fakes.sessionRepository.add(
        marketOf(),
        openSession({
          id: id<'Session'>(0xf300 + n),
          marketId,
          accountId: account,
          population,
          sellerId: population === 'seller' ? SELLER : null,
          transport: 'cookie',
          lifetime: LIFETIME,
          now: START,
        }),
        issued.tokenHash,
      );
      return { cookie: `__Host-session-${population}-${code}=${issued.token}` };
    }

    const get = (query: string, headers: Record<string, string> = {}) =>
      http()
        .get(`/reporting/seller/net-earnings${query}`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller'), ...headers });

    beforeEach(() => {
      fakes.reset();
      reads.length = 0;
    });
    afterEach(async () => {
      await app?.close();
    });

    it('answers the owner with the figure, as a string, for the session seller only', async () => {
      await boot();
      const reply = await get('?period=7d&sellerId=other', cookieOf(OWNER, 'seller', 1));
      expect(reply.status).toBe(200);
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.body).toMatchObject({ ready: true, netEarnings: '8500' });
      expect(reads).toMatchObject([{ sellerId: SELLER }]);
    });

    it('refuses a seller member without the earnings key with 403 access.denied', async () => {
      await boot();
      const reply = await get('?period=7d', cookieOf(MEMBER, 'seller', 2));
      expect(reply.status).toBe(403);
      expect(reply.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(reads).toEqual([]);
    });

    it.each(['?period=year', '?period=7d&period=30d'])(
      'refuses %s with 400 validation.failed and no-store',
      async (query) => {
        await boot();
        const reply = await get(query, cookieOf(OWNER, 'seller', 3));
        expect(reply.status).toBe(400);
        expect(reply.headers['cache-control']).toBe('no-store');
        expect(reply.body).toEqual({ statusCode: 400, code: 'validation.failed' });
        expect(reads).toEqual([]);
      },
    );

    it('reads no seller session from an admin cookie, and refuses no cookie at all', async () => {
      await boot();
      expect((await get('?period=7d', cookieOf(ADMIN, 'admin', 4))).status).toBe(401);
      expect((await get('?period=7d')).status).toBe(401);
      expect(reads).toEqual([]);
    });
  },
);
