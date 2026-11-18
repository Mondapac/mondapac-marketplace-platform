import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ConsentSource } from '../domain/marketing-consent';
import { CustomerConsentFacadeImplementation } from '../presentation/customer-consent.facade';
import type { LegalDependencies } from './legal-dependencies';
import { RecordingLegalOutbox } from './testing/recording-legal-outbox';
import { InMemoryMarketingConsents } from './testing/in-memory-marketing-consents';
import { AdminCustomerConsentHistory } from './use-cases/admin-customer-consent-history.use-case';
import { AdminCustomerConsent } from './use-cases/admin-customer-consent.use-case';

// The admin's reads of one customer's marketing consent (customers management phase 2b) on both
// Market fixtures: the current state of every channel (express opt-in: no row is not granted),
// the history with its source in both paging modes, the customer's own rows of this Market only,
// and a platform admin only.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER = id<'Account'>(0xc2);

describe.each([['AU'], ['ZZ']] as const)(
  'the admin’s read of a customer’s consent in %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const elsewhere = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const admin = (): CallContext =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: id<'Account'>(0xa1),
          sessionId: id<'Session'>(0xa2),
          sellerId: null,
        }),
      );

    function setUp() {
      const consents = new InMemoryMarketingConsents();
      const clock = new FixedClock(T0);
      const deps: LegalDependencies = {
        unitOfWork: new FakeUnitOfWork(),
        consents,
        ids: new SequenceIdGenerator(clock),
        clock,
        outbox: new RecordingLegalOutbox(),
      };
      const facade = new CustomerConsentFacadeImplementation(
        new AdminCustomerConsent(gate, deps),
        new AdminCustomerConsentHistory(gate, deps),
      );
      let n = 0;
      const change = (
        m: MarketContext,
        accountId: Id<'Account'>,
        granted: boolean,
        source: ConsentSource,
        hours: number,
      ) => {
        n += 1;
        const at = T0.add({ hours });
        return consents.record(
          m,
          {
            id: id<'MarketingConsent'>(0x100 + n),
            accountId,
            channel: 'email',
            granted,
            source,
            changedAt: at,
            createdAt: at,
          },
          {
            id: id<'MarketingConsentChange'>(0x200 + n),
            accountId,
            channel: 'email',
            granted,
            source,
            occurredAt: at,
          },
        );
      };
      return { facade, change };
    }

    it('reads the current consent of every channel, not granted when never set', async () => {
      const { facade, change } = setUp();
      await change(market, CUSTOMER, true, 'sign-up', 1);
      await change(market, CUSTOMER, false, 'unsubscribe-link', 2);
      await change(elsewhere, OTHER, true, 'account', 3);
      expect(await facade.adminCustomerConsent(admin(), CUSTOMER)).toEqual({
        ok: true,
        value: {
          channels: [
            {
              channel: 'email',
              granted: false,
              source: 'unsubscribe-link',
              changedAt: T0.add({ hours: 2 }).toString(),
            },
          ],
        },
      });
      expect(await facade.adminCustomerConsent(admin(), OTHER)).toEqual({
        ok: true,
        value: { channels: [{ channel: 'email', granted: false, source: null, changedAt: null }] },
      });
    });

    it('pages the history with its source, newest first or oldest first', async () => {
      const { facade, change } = setUp();
      await change(market, CUSTOMER, true, 'sign-up', 1);
      await change(market, CUSTOMER, false, 'unsubscribe-link', 2);
      await change(market, CUSTOMER, true, 'account', 3);
      await change(elsewhere, CUSTOMER, true, 'account', 4);
      await change(market, OTHER, true, 'account', 5);
      const first = await facade.adminCustomerConsentHistory(admin(), {
        accountId: CUSTOMER,
        channels: null,
        direction: 'desc',
        window: { offset: 0, limit: 2 },
        withTotal: true,
      });
      expect(first).toEqual({
        ok: true,
        value: {
          total: 3,
          rows: [
            {
              channel: 'email',
              granted: true,
              source: 'account',
              occurredAt: T0.add({ hours: 3 }).toString(),
            },
            {
              channel: 'email',
              granted: false,
              source: 'unsubscribe-link',
              occurredAt: T0.add({ hours: 2 }).toString(),
            },
          ],
        },
      });
      const oldest = await facade.adminCustomerConsentHistory(admin(), {
        accountId: CUSTOMER,
        channels: ['email'],
        direction: 'asc',
        window: { offset: 0, limit: 1 },
        withTotal: false,
      });
      expect(oldest).toMatchObject({
        ok: true,
        value: { total: null, rows: [{ source: 'sign-up' }] },
      });
      const unknown = await facade.adminCustomerConsentHistory(admin(), {
        accountId: CUSTOMER,
        channels: ['sms'],
        direction: 'asc',
        window: { offset: 0, limit: 10 },
        withTotal: true,
      });
      expect(unknown).toEqual({ ok: true, value: { total: 0, rows: [] } });
    });

    it('refuses everyone but a platform admin, and an acting-as session', async () => {
      const { facade } = setUp();
      const customer = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'customer',
          accountId: CUSTOMER,
          sessionId: id<'Session'>(0xa3),
          sellerId: null,
        }),
      );
      const acting = admin();
      for (const context of [
        testCallContext(market, 'system'),
        customer,
        { ...acting, actor: { ...acting.actor, actingAs: { sellerId: 'x' } } as never },
      ]) {
        expect(await facade.adminCustomerConsent(context, CUSTOMER)).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });

    it('declares the legal key only', () => {
      for (const type of [AdminCustomerConsent, AdminCustomerConsentHistory]) {
        expect(type.access.rule).toEqual({
          kind: 'permissions',
          allOf: ['legal.customer-consent.view'],
        });
      }
    });
  },
);
