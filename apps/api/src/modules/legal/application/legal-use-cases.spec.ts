import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
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
import { LegalFacadeImplementation } from '../presentation/legal.facade';
import type { LegalDependencies } from './legal-dependencies';
import { InMemoryMarketingConsents } from './testing/in-memory-marketing-consents';
import { RecordingLegalOutbox } from './testing/recording-legal-outbox';
import { MarketingEmailConsentOf } from './use-cases/marketing-email-consent-of.use-case';
import { SetEmailPreferences } from './use-cases/set-email-preferences.use-case';
import { ViewEmailPreferences } from './use-cases/view-email-preferences.use-case';
import { WithdrawMarketingEmailByLink } from './use-cases/withdraw-marketing-email-by-link.use-case';

// Marketing email consent in memory on both Market fixtures: express opt-in (nothing until the
// customer says yes), only real changes are recorded with their source, the unsubscribe link only
// withdraws, a send asks as the system actor, and every other actor is refused.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-18T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);

describe.each([['AU'], ['ZZ']] as const)('marketing email consent in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const as = (population: 'customer' | 'seller' | 'admin', accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `leg-${population}-abcd`,
    );
  const alice = as('customer', ALICE);
  const bob = as('customer', BOB);
  const system = testCallContext(market, 'system');
  const anonymous = testCallContext(market, 'anonymous');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let store: InMemoryMarketingConsents;
  let units: FakeUnitOfWork;
  let outbox: RecordingLegalOutbox;
  let uc: {
    view: ViewEmailPreferences;
    set: SetEmailPreferences;
    consentOf: MarketingEmailConsentOf;
    withdraw: WithdrawMarketingEmailByLink;
  };

  beforeEach(() => {
    clock = new FixedClock(T0);
    store = new InMemoryMarketingConsents();
    units = new FakeUnitOfWork();
    outbox = new RecordingLegalOutbox();
    const deps: LegalDependencies = {
      unitOfWork: units,
      consents: store,
      ids: new SequenceIdGenerator(clock),
      clock,
      outbox,
    };
    uc = {
      view: new ViewEmailPreferences(gate, deps),
      set: new SetEmailPreferences(gate, deps),
      consentOf: new MarketingEmailConsentOf(gate, deps),
      withdraw: new WithdrawMarketingEmailByLink(gate, deps),
    };
  });

  it('starts with no consent and records nothing for a "no" that changes nothing', async () => {
    expect(await uc.view.execute(alice, {})).toEqual({
      ok: true,
      value: { marketing: false, changedAt: null },
    });
    expect(await uc.set.execute(alice, { marketing: false, source: 'sign-up' })).toEqual({
      ok: true,
      value: { marketing: false, changedAt: null },
    });
    expect(store.changes).toEqual([]);
    expect(outbox.events).toEqual([]);
    expect(await uc.consentOf.execute(system, { accountId: ALICE })).toEqual({
      ok: true,
      value: { granted: false },
    });
  });

  it('records the opt-in with its source, then a withdrawal from the account page', async () => {
    const given = await uc.set.execute(alice, { marketing: true, source: 'sign-up' });
    expect(given).toEqual({ ok: true, value: { marketing: true, changedAt: T0 } });
    expect(units.units.at(-1)?.options).toEqual({ isolation: 'serializable' });
    expect(await uc.consentOf.execute(system, { accountId: ALICE })).toEqual({
      ok: true,
      value: { granted: true },
    });

    clock.advance(Temporal.Duration.from({ minutes: 5 }));
    await uc.set.execute(alice, { marketing: true });
    clock.advance(Temporal.Duration.from({ minutes: 5 }));
    const withdrawn = await uc.set.execute(alice, { marketing: false });
    expect(withdrawn).toMatchObject({ ok: true, value: { marketing: false } });

    expect(
      store.changes.map(({ granted, source, marketId }) => [granted, source, marketId]),
    ).toEqual([
      [true, 'sign-up', code],
      [false, 'account', code],
    ]);
    expect(await uc.consentOf.execute(system, { accountId: ALICE })).toEqual({
      ok: true,
      value: { granted: false },
    });
    // Bob never agreed.
    expect(await uc.view.execute(bob, {})).toMatchObject({ value: { marketing: false } });

    // One event per real change, in the change's Market: the account and the channel, never the
    // value or the source; the aggregate is the change appended to the history.
    expect(outbox.events).toEqual([
      expect.objectContaining({
        type: 'legal.marketing-consent-changed.v1',
        aggregateId: store.changes[0]!.id,
        aggregateVersion: 1,
        occurredAt: T0,
        payload: { accountId: ALICE, channel: 'email' },
        marketId: code,
      }),
      expect.objectContaining({
        type: 'legal.marketing-consent-changed.v1',
        aggregateId: store.changes[1]!.id,
        occurredAt: T0.add({ minutes: 10 }),
        payload: { accountId: ALICE, channel: 'email' },
        marketId: code,
      }),
    ]);
    expect(JSON.stringify(outbox.events)).not.toMatch(/granted|marketing"|sign-up|account"/);
  });

  it('writes no event when the change cannot be stored (one unit: neither or both)', async () => {
    const failing = Object.assign(Object.create(store) as InMemoryMarketingConsents, {
      record: () => Promise.reject(new Error('down')),
    });
    const deps: LegalDependencies = {
      unitOfWork: units,
      consents: failing,
      ids: new SequenceIdGenerator(clock),
      clock,
      outbox,
    };
    await expect(
      new SetEmailPreferences(gate, deps).execute(alice, { marketing: true }),
    ).rejects.toThrow('down');
    expect(outbox.events).toEqual([]);
  });

  it.each([
    [{}, [{ path: 'marketing', code: 'required' }]],
    [{ marketing: 'yes' }, [{ path: 'marketing', code: 'type' }]],
    [{ marketing: true, source: 'unsubscribe-link' }, [{ path: 'source', code: 'one-of' }]],
    [{ marketing: true, source: 7 }, [{ path: 'source', code: 'one-of' }]],
  ])('refuses the body %j', async (body, fields) => {
    expect(await uc.set.execute(alice, body)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields },
    });
    expect(store.changes).toEqual([]);
  });

  it('withdraws by the link once; a second click and an account without consent change nothing', async () => {
    await uc.set.execute(alice, { marketing: true, source: 'account' });
    expect(await uc.withdraw.execute(anonymous, { accountId: ALICE })).toEqual({
      ok: true,
      value: { withdrawn: true },
    });
    expect(await uc.withdraw.execute(anonymous, { accountId: ALICE })).toEqual({
      ok: true,
      value: { withdrawn: false },
    });
    expect(await uc.withdraw.execute(anonymous, { accountId: BOB })).toEqual({
      ok: true,
      value: { withdrawn: false },
    });
    expect(store.changes.map(({ granted, source }) => [granted, source])).toEqual([
      [true, 'account'],
      [false, 'unsubscribe-link'],
    ]);
    // The link's withdrawal is announced like any change; the repeated click is not.
    expect(outbox.events.map((event) => event.payload)).toEqual([
      { accountId: ALICE, channel: 'email' },
      { accountId: ALICE, channel: 'email' },
    ]);
  });

  it('serves the customer only; the consent check is for the system actor', async () => {
    for (const other of [as('seller', BOB), as('admin', BOB)]) {
      expect(await uc.view.execute(other, {})).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await uc.set.execute(other, { marketing: true })).toMatchObject({ ok: false });
    }
    expect(await uc.view.execute(anonymous, {})).toMatchObject({ ok: false });
    expect(outbox.events).toEqual([]);
    expect(await uc.consentOf.execute(alice, { accountId: ALICE })).toMatchObject({ ok: false });
    expect(await uc.consentOf.execute(anonymous, { accountId: ALICE })).toMatchObject({
      ok: false,
    });
    expect(store.changes).toEqual([]);
  });

  it('passes the caller through the facade unchanged', async () => {
    const facade = new LegalFacadeImplementation({
      marketingEmailConsentOf: uc.consentOf,
      withdrawMarketingEmailByLink: uc.withdraw,
    });
    await uc.set.execute(alice, { marketing: true });
    expect(await facade.marketingEmailConsentOf(system, ALICE)).toEqual({
      ok: true,
      value: { granted: true },
    });
    expect(await facade.marketingEmailConsentOf(alice, ALICE)).toMatchObject({ ok: false });
    expect(await facade.withdrawMarketingEmailByLink(anonymous, ALICE)).toEqual({
      ok: true,
      value: { withdrawn: true },
    });
  });
});
