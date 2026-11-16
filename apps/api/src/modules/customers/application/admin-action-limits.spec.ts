import { ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { RecordingSecurityEvents } from '../../../../test/support/recording-security-events';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AuthorisationCheck, StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SecurityEvents } from '../../../platform/security-events/security-events';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { CustomerListRow } from '../domain/customer-list';
import type { CustomerManagementDependencies } from './customer-management-dependencies';
import type { CustomerSectionDependencies } from './customer-section-lists';
import type { CustomerSectionPeers } from './ports/customer-section-peers';
import { InMemoryAddresses, ReversibleAddressCipher } from './testing/in-memory-address-book';
import { InMemoryCustomerList } from './testing/in-memory-customer-list';
import { InMemoryCustomerTimeline } from './testing/in-memory-customer-management';
import { MemoryAdminActionLimits } from './testing/memory-admin-action-limits';
import { AdminCustomerAddressReveal } from './use-cases/admin-customer-address-reveal.use-case';
import { AdminCustomerPasswordReset } from './use-cases/admin-customer-password-reset.use-case';
import { AdminCustomerSignInReveal } from './use-cases/admin-customer-sign-in-reveal.use-case';

// The per-admin limits on the customer page's actions on personal data (security review of #969,
// L2/L3), in both Market fixtures (AU: 20 resets, 60 reveals, alert at 40; ZZ: 5, 10, 6): past the
// limit `request.throttled` with the seconds left; another admin is not affected; the fixed hour
// resets; the sign-in address and the delivery address share one count; the bulk-reveal security
// event is recorded exactly once per admin and window; only calls the gate allowed are counted;
// a counter that cannot be read, or an alert that cannot be recorded, refuses (fail closed).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const NOW = Temporal.Instant.from('2026-11-16T12:00:00Z');
const VIEW = 'customers.customers.view';
const SIGN_IN_VIEW = 'identity.customer-sign-in.view';
const SIGN_IN_REVEAL = 'identity.customer-sign-in.reveal';
const RESET_SEND = 'identity.customer-password-reset.send';
const ADDRESS_REVEAL = 'customers.customer-address.reveal';
const ALL = [VIEW, SIGN_IN_VIEW, SIGN_IN_REVEAL, RESET_SEND, ADDRESS_REVEAL];
const SIGN_IN_ID = '01990000-0000-7000-8000-000000005001';

describe.each(['AU', 'ZZ'] as const)('per-admin limits on customer PII actions in %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const limits = markets.get(market.marketId).customers!.adminActionLimits;

  function setup() {
    const clock = new FixedClock(NOW);
    const ids = new SequenceIdGenerator(clock);
    const held = new Map<string, readonly string[]>();
    const check: AuthorisationCheck = {
      check: (context, declaration) => {
        const actor = context.actor;
        const keys = actor.kind === 'authenticated' ? (held.get(actor.accountId) ?? []) : [];
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    const gate = createUseCaseGate(markets, check);
    const audits: AuditEntry[] = [];
    const audit: AuditWriter = {
      record: (_context, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const listReader = new InMemoryCustomerList();
    const timeline = new InMemoryCustomerTimeline(listReader);
    const adminLimits = new MemoryAdminActionLimits(markets, clock);
    const recorder = new RecordingSecurityEvents();
    const failingEvents = { on: false };
    const securityEvents: SecurityEvents = {
      record: (context, event) =>
        failingEvents.on ? Promise.reject(new Error('down')) : recorder.record(context, event),
    };
    const identity = {
      calls: 0,
      adminRevealCustomerSignIn: () => {
        identity.calls += 1;
        return Promise.resolve(ok({ address: '203.0.113.7', occurredAt: NOW.toString() }));
      },
      adminSendCustomerPasswordReset: () => {
        identity.calls += 1;
        return Promise.resolve(ok({ sent: true as const }));
      },
    };
    const stepUp: StepUpProofConsumer = {
      consume: () => Promise.reject(new Error('not used')),
    };
    const sectionDeps: CustomerSectionDependencies = {
      unitOfWork,
      listReader,
      timeline,
      audit,
      stepUp,
      sheetWriter: { xlsx: () => Promise.reject(new Error('not used')) as never },
      clock,
      ids,
      adminLimits,
      securityEvents,
      peers: { identity } as unknown as CustomerSectionPeers,
    };
    const addresses = new InMemoryAddresses();
    const addressCipher = new ReversibleAddressCipher();
    // The address reveal reads only these ports; the others are not reached.
    const managementDeps = {
      unitOfWork,
      listReader,
      timeline,
      audit,
      clock,
      ids,
      addresses,
      addressCipher,
      adminLimits,
      securityEvents,
    } as unknown as CustomerManagementDependencies;

    const admin = (keys: readonly string[] = ALL): CallContext => {
      const accountId = ids.next<'Account'>();
      held.set(accountId, keys);
      return testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
      );
    };
    const customer: CustomerListRow = {
      accountId: ids.next<'Account'>(),
      email: 'buyer@example.test',
      groups: [],
      displayName: null,
      status: 'active',
      emailVerified: true,
      signedUpAt: NOW.subtract({ hours: 24 * 30 }),
      firstOrderAt: null,
      lastOrderAt: null,
      orderCount: 0,
      spentMinor: 0n,
      currency: null,
      refundCount: 0,
      refundedMinor: 0n,
    };
    listReader.add(market, customer);

    async function address(): Promise<Id<'CustomerAddress'>> {
      const sealed = await addressCipher.seal(market, customer.accountId, {
        recipientFirstName: 'Aisha',
        recipientLastName: 'Rahman',
        phone: '+61412345678',
        line1: '1 Hidden Street',
        line2: null,
        suburb: 'Sunnybank',
        region: null,
        postcode: code === 'AU' ? '4109' : '1000001',
        deliveryNotes: null,
      });
      if (!sealed.ok) throw new Error('seal failed');
      const addressId = ids.next<'CustomerAddress'>();
      await addresses.insert(market, {
        id: addressId,
        accountId: customer.accountId,
        sealed: sealed.value,
        countryCode: code === 'AU' ? 'AU' : 'ZZ',
        isDefault: true,
        createdAt: NOW,
        updatedAt: NOW,
      });
      return addressId;
    }

    const signInReveal = new AdminCustomerSignInReveal(gate, sectionDeps);
    const passwordReset = new AdminCustomerPasswordReset(gate, sectionDeps);
    const addressReveal = new AdminCustomerAddressReveal(gate, managementDeps);
    const accountId = customer.accountId;
    return {
      clock,
      admin,
      address,
      identity,
      adminLimits,
      recorder,
      failingEvents,
      audits,
      revealSignIn: (context: CallContext) =>
        signInReveal.execute(context, { accountId, signInId: SIGN_IN_ID }),
      resetPassword: (context: CallContext) => passwordReset.execute(context, { accountId }),
      revealAddress: (context: CallContext, addressId: string) =>
        addressReveal.execute(context, { accountId, addressId }),
    };
  }

  async function times(n: number, run: () => Promise<Result<unknown, unknown>>) {
    for (let index = 0; index < n; index += 1) {
      const result = await run();
      if (!result.ok) throw new Error(`attempt ${index + 1} refused: ${JSON.stringify(result)}`);
    }
  }

  it('reads the limits from the Market configuration', () => {
    expect(limits).toEqual(
      code === 'AU'
        ? { passwordResetsPerHour: 20, piiRevealsPerHour: 60, piiRevealAlertAt: 40 }
        : { passwordResetsPerHour: 5, piiRevealsPerHour: 10, piiRevealAlertAt: 6 },
    );
  });

  it('refuses the password reset past the limit, with the seconds left, and asks identity no more', async () => {
    const t = setup();
    const admin = t.admin();
    await times(limits.passwordResetsPerHour, () => t.resetPassword(admin));
    expect(t.identity.calls).toBe(limits.passwordResetsPerHour);

    t.clock.advance(Temporal.Duration.from({ minutes: 10 }));
    await expect(t.resetPassword(admin)).resolves.toEqual({
      ok: false,
      error: { code: 'request.throttled', retryAfterSeconds: 50 * 60 },
    });
    expect(t.identity.calls).toBe(limits.passwordResetsPerHour);
    // The password reset never raises the bulk-reveal alert.
    expect(t.recorder.events).toEqual([]);
  });

  it('leaves another admin unaffected', async () => {
    const t = setup();
    const first = t.admin();
    await times(limits.passwordResetsPerHour, () => t.resetPassword(first));
    await times(limits.piiRevealsPerHour, () => t.revealSignIn(first));
    expect((await t.resetPassword(first)).ok).toBe(false);
    expect((await t.revealSignIn(first)).ok).toBe(false);

    const second = t.admin();
    await expect(t.resetPassword(second)).resolves.toEqual({ ok: true, value: { sent: true } });
    expect((await t.revealSignIn(second)).ok).toBe(true);
  });

  it('opens a fresh window when the hour is over', async () => {
    const t = setup();
    const admin = t.admin();
    await times(limits.piiRevealsPerHour, () => t.revealSignIn(admin));
    t.clock.advance(Temporal.Duration.from({ minutes: 59 }));
    await expect(t.revealSignIn(admin)).resolves.toMatchObject({
      ok: false,
      error: { code: 'request.throttled', retryAfterSeconds: 60 },
    });

    t.clock.advance(Temporal.Duration.from({ minutes: 1 }));
    expect((await t.revealSignIn(admin)).ok).toBe(true);
    await times(limits.piiRevealsPerHour - 1, () => t.revealSignIn(admin));
    expect((await t.revealSignIn(admin)).ok).toBe(false);
  });

  it('counts the sign-in address and the delivery address reveals together', async () => {
    const t = setup();
    const admin = t.admin();
    const addressId = await t.address();
    const half = Math.floor(limits.piiRevealsPerHour / 2);
    await times(half, () => t.revealSignIn(admin));
    await times(limits.piiRevealsPerHour - half, () => t.revealAddress(admin, addressId));

    await expect(t.revealAddress(admin, addressId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'request.throttled' },
    });
    await expect(t.revealSignIn(admin)).resolves.toMatchObject({
      ok: false,
      error: { code: 'request.throttled' },
    });
    // A refused reveal writes no audit row: only the admitted ones did.
    expect(
      t.audits.filter((entry) => entry.action === 'customers.customer-address.revealed'),
    ).toHaveLength(limits.piiRevealsPerHour - half);
    // The reveals and the password reset are separate counts.
    expect((await t.resetPassword(admin)).ok).toBe(true);
  });

  it('raises the bulk-reveal alert once, when the count reaches the Market’s alert count', async () => {
    const t = setup();
    const admin = t.admin();
    const addressId = await t.address();
    await times(limits.piiRevealAlertAt - 1, () => t.revealAddress(admin, addressId));
    expect(t.recorder.events).toEqual([]);

    expect((await t.revealSignIn(admin)).ok).toBe(true);
    const adminId = admin.actor.kind === 'authenticated' ? admin.actor.accountId : null;
    expect(t.recorder.events).toEqual([
      {
        type: 'customers.pii-reveal.bulk',
        targetId: adminId,
        ip: null,
        payload: { reveals: limits.piiRevealAlertAt },
        actor: 'authenticated',
        marketId: market.marketId,
      },
    ]);

    // The rest of the window, and the refused attempts past the limit, raise nothing more.
    await times(limits.piiRevealsPerHour - limits.piiRevealAlertAt, () => t.revealSignIn(admin));
    expect((await t.revealSignIn(admin)).ok).toBe(false);
    expect(t.recorder.events).toHaveLength(1);

    // Another admin reaching it raises their own; a new window raises it again.
    const other = t.admin();
    await times(limits.piiRevealAlertAt, () => t.revealSignIn(other));
    t.clock.advance(Temporal.Duration.from({ hours: 1 }));
    await times(limits.piiRevealAlertAt, () => t.revealSignIn(admin));
    expect(t.recorder.events.map((event) => event.targetId)).toEqual([
      adminId,
      other.actor.kind === 'authenticated' ? other.actor.accountId : null,
      adminId,
    ]);
  });

  it('counts only the calls the gate allowed', async () => {
    const t = setup();
    const viewer = t.admin([VIEW]);
    const addressId = await t.address();
    await expect(t.revealSignIn(viewer)).resolves.toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    await expect(t.revealAddress(viewer, addressId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    await expect(t.resetPassword(viewer)).resolves.toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(t.adminLimits.counted).toEqual([]);
  });

  it('counts an attempt on an unknown address or customer, so probing is limited too', async () => {
    const t = setup();
    const admin = t.admin();
    const unknown = '01990000-0000-7000-8000-00000000ffff';
    await expect(t.revealAddress(admin, unknown)).resolves.toEqual({
      ok: false,
      error: { code: 'customers.address-not-found' },
    });
    expect(t.adminLimits.counted).toHaveLength(1);
  });

  it('refuses when the counter cannot be read or the alert cannot be recorded (fail closed)', async () => {
    const t = setup();
    const admin = t.admin();
    t.adminLimits.failing = true;
    await expect(t.revealSignIn(admin)).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    await expect(t.resetPassword(admin)).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(t.identity.calls).toBe(0);

    t.adminLimits.failing = false;
    await times(limits.piiRevealAlertAt - 1, () => t.revealSignIn(admin));
    t.failingEvents.on = true;
    const calls = t.identity.calls;
    await expect(t.revealSignIn(admin)).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(t.identity.calls).toBe(calls);
  });
});
