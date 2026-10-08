import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { AccountAuthorisationCheck } from '../src/modules/identity/application/access/account-authorisation-check';
import type { AccountState } from '../src/modules/identity/domain/account';
import type { RoleKind } from '../src/modules/identity/domain/role';
import type { SellerAccessStateCode } from '../src/modules/identity/domain/seller-access';
import {
  SetRegularPrice,
  type SetRegularPriceInput,
} from '../src/modules/pricing/application/use-cases/set-regular-price.use-case';
import { ConfigPricingPolicyProvider } from '../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { createUseCaseGate } from '../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../src/platform/market-config/market-config';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { realEffectiveKeys } from './support/permission-registry';
import {
  FakeOfferSellUnits,
  FakeUnitOfWork,
  InMemoryPriceSeries,
  InMemoryRefusalThrottles,
  RecordingAuditWriter,
  RecordingOutbox,
} from './support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from './support/test-config';

// `pricing.set-regular-price` behind the real gate and identity's real AuthorisationCheck
// (identity's database ports as in-memory fakes), for both Market fixtures (Sajad M4). The
// use-case spec runs with a gate that admits everyone; this one proves the declaration takes
// effect: `pricing.price.edit` is required, and a seller that is not approved is answered
// `access.seller-not-approved` before catalog is asked. That the Seller Owner's system role
// holds every seller key of the registry, `pricing.price.edit` included, is also covered by
// test/seller-account.e2e.spec.ts (the session's `permissionKeys`).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policies = new ConfigPricingPolicyProvider(markets);
const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const CURRENCY: Record<string, string> = { AU: 'AUD', ZZ: 'JPY' };

describe.each(TEST_MARKETS)(
  'pricing.set-regular-price behind the real gate in market %s',
  (code) => {
    const market: MarketContext = testMarketContext(code, PLATFORM_TENANT_ID);
    const marketId = code as AccountState['marketId'];
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());

    function setup(state: SellerAccessStateCode, role: { kind: RoleKind; keys?: string[] }) {
      const clock = new FixedClock(START);
      const ids = new SequenceIdGenerator(clock);
      const fakes = new IdentityFakes();
      const accountId = ids.next<'Account'>();
      const sellerId = ids.next<'Seller'>();
      const roleId = ids.next<'Role'>();
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'seller',
        email: { typed: 'a@example.com', normalized: 'a@example.com' },
        displayName: 'Amina',
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedSellerAccess({
        sellerId,
        marketId,
        origin: 'self',
        state,
        stateChangedAt: START,
        reapplyCount: 0,
        registeredAt: START,
        version: 1,
        createdAt: START,
      });
      fakes.seedMembership({
        id: ids.next<'SellerMembership'>(),
        marketId,
        accountId,
        sellerId,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'seller',
        kind: role.kind,
        seedCode: role.kind === 'custom' ? null : 'fixture-role',
        seedVersion: role.kind === 'custom' ? null : 1,
        sellerId: role.kind === 'custom' ? sellerId : null,
        permissionKeys: role.keys ?? [],
        version: 1,
        createdAt: START,
      });
      fakes.seedAssignment({
        id: ids.next<'RoleAssignment'>(),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      const gate = createUseCaseGate(
        markets,
        new AccountAuthorisationCheck({
          unitOfWork: fakes.unitOfWork,
          accounts: fakes.accountRepository,
          memberships: fakes.membershipRepository,
          sellerAccess: fakes.sellerAccessRepository,
          grants: fakes.grantReader,
          effectiveKeys: realEffectiveKeys(),
        }),
      );
      const offers = new FakeOfferSellUnits();
      const series = new InMemoryPriceSeries();
      const useCase = new SetRegularPrice(gate, {
        unitOfWork: new FakeUnitOfWork(),
        series,
        throttles: new InMemoryRefusalThrottles(),
        offers,
        policies,
        audit: new RecordingAuditWriter(),
        outbox: new RecordingOutbox(),
        clock,
        ids,
      });
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      offers.put(market, offerId, {
        sellerId,
        productId: ids.next<'Product'>(),
        deleted: false,
        priceableVariantIds: [variantId],
      });
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
      );
      const input: SetRegularPriceInput = {
        offerId,
        variantId,
        price: { amount: '1000', currency: CURRENCY[code]! },
        expectedVersion: null,
      };
      return { useCase, context, input, offers, series };
    }

    it('lets an approved Seller Owner (system role) write: the role holds pricing.price.edit', async () => {
      const t = setup('approved', { kind: 'system' });
      const result = await t.useCase.execute(t.context, t.input);
      expect(result).toMatchObject({ ok: true, value: { status: 'accepted' } });
    });

    it('denies an approved seller whose role lacks pricing.price.edit, before catalog is asked', async () => {
      const t = setup('approved', { kind: 'default', keys: ['pricing.price.view'] });
      expect(await t.useCase.execute(t.context, t.input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(t.offers.calls).toEqual([]);
      expect(t.series.rows.size).toBe(0);
    });

    it('grants the write to a custom role of the seller that holds pricing.price.edit', async () => {
      const t = setup('approved', { kind: 'custom', keys: ['pricing.price.edit'] });
      expect(await t.useCase.execute(t.context, t.input)).toMatchObject({ ok: true });
    });

    it.each<'pending' | 'rejected'>(['pending', 'rejected'])(
      'answers access.seller-not-approved to a %s seller, even as Seller Owner (whenSellerNotApproved: deny)',
      async (state) => {
        const t = setup(state, { kind: 'system' });
        expect(await t.useCase.execute(t.context, t.input)).toEqual({
          ok: false,
          error: { code: 'access.seller-not-approved', details: { state } },
        });
        expect(t.offers.calls).toEqual([]);
      },
    );

    it('denies a suspended seller', async () => {
      const t = setup('suspended', { kind: 'system' });
      expect(await t.useCase.execute(t.context, t.input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(t.offers.calls).toEqual([]);
    });
  },
);
