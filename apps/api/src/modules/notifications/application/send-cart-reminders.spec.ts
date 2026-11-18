import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { MailSendError, type MailMessage } from '../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { CartReminderFacade, IdleCart } from '../../cart';
import type { ContactEmailTarget, IdentityFacade } from '../../identity';
import type { LegalFacade } from '../../legal';
import { ConfigNotificationsPolicy } from '../infrastructure/config-notifications-policy';
import { HmacUnsubscribeTokens } from '../infrastructure/hmac-unsubscribe-tokens';
import type { CartReminderKey, CartReminderRepository } from './ports/cart-reminder.repository';
import type { CartReminderSettings } from './ports/notifications-policy';
import { AdminCustomerCartReminders } from './use-cases/admin-customer-cart-reminders.use-case';
import {
  SendCartReminders,
  type CartReminderDependencies,
} from './use-cases/send-cart-reminders.use-case';

// The abandoned-cart email (personalization 1c) in memory on both Market fixtures: a signed-in
// customer with consent whose cart has sat idle gets one mail at about 4 hours and one at about
// 24 hours, once per cart change; nothing without consent or after an unsubscribe; nothing in
// `off` mode, and only test accounts in `test` mode.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);
const CHANGED = Temporal.Instant.from('2026-10-19T08:00:00Z');
const hoursAfter = (hours: number) => CHANGED.add({ milliseconds: Math.round(hours * 3_600_000) });

/** legal in memory: the accounts that agreed, per Market. */
class FakeLegal implements LegalFacade {
  readonly granted = new Set<string>();
  marketingEmailConsentOf(context: CallContext, accountId: Id<'Account'>) {
    return Promise.resolve(
      ok({ granted: this.granted.has(`${context.market.marketId}|${accountId}`) }),
    );
  }
  withdrawMarketingEmailByLink() {
    return Promise.resolve(ok({ withdrawn: false }));
  }
}

/** The repository's page order: `(lastChangedAt, cartId)`. */
const order = (a: Pick<IdleCart, 'lastChangedAt' | 'cartId'>, b: typeof a) =>
  Temporal.Instant.compare(a.lastChangedAt, b.lastChangedAt) ||
  (a.cartId < b.cartId ? -1 : a.cartId > b.cartId ? 1 : 0);

/** cart in memory: the idle query over a list of carts, as the repository answers it. */
class FakeCarts implements CartReminderFacade {
  carts: IdleCart[] = [];
  refuse = false;
  idleCarts(context: CallContext, request: Parameters<CartReminderFacade['idleCarts']>[1]) {
    if (this.refuse) return Promise.resolve(err({ code: 'access.denied' } as const));
    const after = request.after;
    const page = this.carts
      .filter(
        (cart) =>
          Temporal.Instant.compare(cart.lastChangedAt, request.changedAfter) > 0 &&
          Temporal.Instant.compare(cart.lastChangedAt, request.changedAtOrBefore) <= 0 &&
          (request.accountIds === undefined || request.accountIds.includes(cart.accountId)) &&
          (after === null || order(cart, after) > 0),
      )
      .sort(order)
      .slice(0, request.limit);
    return Promise.resolve(ok(page));
  }
}

class MemoryReminders implements CartReminderRepository {
  readonly taken = new Map<string, Temporal.Instant>();
  take(market: MarketContext, key: CartReminderKey, at: Temporal.Instant) {
    const k = `${market.marketId}|${key.accountId}|${key.cartChangedAt.toString()}|${key.stage}`;
    if (this.taken.has(k)) return Promise.resolve(false);
    this.taken.set(k, at);
    return Promise.resolve(true);
  }
  purgeTakenBefore(_market: MarketContext, cutoff: Temporal.Instant, limit: number) {
    let count = 0;
    for (const [k, at] of this.taken) {
      if (count < limit && Temporal.Instant.compare(at, cutoff) < 0) {
        this.taken.delete(k);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  /** The rows of one account in this Market, oldest taken first. */
  private ofAccount(market: MarketContext, accountId: Id<'Account'>) {
    return [...this.taken]
      .map(([k, takenAt]) => {
        const [marketId, account, changed, stage] = k.split('|');
        return { marketId, account, changed: changed!, stage: Number(stage), takenAt };
      })
      .filter((row) => row.marketId === market.marketId && row.account === accountId)
      .sort((a, b) => Temporal.Instant.compare(a.takenAt, b.takenAt) || a.stage - b.stage);
  }
  pageOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    const rows = this.ofAccount(market, accountId);
    if (direction === 'desc') rows.reverse();
    return Promise.resolve(
      rows.slice(window.offset, window.offset + window.limit).map((row) => ({
        accountId,
        cartChangedAt: Temporal.Instant.from(row.changed),
        stage: row.stage === 2 ? (2 as const) : (1 as const),
        takenAt: row.takenAt,
      })),
    );
  }
  countOfAccount(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.ofAccount(market, accountId).length);
  }
}

describe.each([['AU'], ['ZZ']] as const)('cart reminders in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const base = new ConfigNotificationsPolicy(markets);
  const cartPage = markets.get(market.marketId).notifications!.cartReminders!.cartPage;

  let settings: CartReminderSettings | null;
  let legal: FakeLegal;
  let carts: FakeCarts;
  let reminders: MemoryReminders;
  let sent: MailMessage[];
  let failSend: boolean;
  let clock: FixedClock;
  let useCase: SendCartReminders;

  const cart = (n: number, accountId: Id<'Account'>, changed = CHANGED): IdleCart => ({
    cartId: id<'Cart'>(n),
    accountId,
    lastChangedAt: changed,
    lineCount: 3,
  });
  const runAt = async (hours: number) => {
    clock.set(hoursAfter(hours));
    return useCase.execute(system, {});
  };

  beforeEach(() => {
    settings = { mode: 'live', cartPage, testAccountIds: [] };
    legal = new FakeLegal();
    legal.granted.add(`${code}|${ALICE}`);
    legal.granted.add(`${code}|${BOB}`);
    carts = new FakeCarts();
    carts.carts = [cart(1, ALICE)];
    reminders = new MemoryReminders();
    sent = [];
    failSend = false;
    clock = new FixedClock(CHANGED);
    const addresses = new Map<string, string>([
      [ALICE, 'alice.private@customer.example'],
      [BOB, 'bob.private@customer.example'],
    ]);
    const deps: CartReminderDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      contacts: {
        latest: () =>
          Promise.resolve({ version: 1, email: 'help@market.example', changedAt: null! }),
        append: () => Promise.resolve(true),
      },
      legal,
      identity: {
        contactEmailOf: (_context: CallContext, target: ContactEmailTarget) =>
          Promise.resolve(
            ok(
              target.kind === 'customer'
                ? (addresses.get(target.accountId) ?? `${target.accountId}@customer.example`)
                : null,
            ),
          ),
      } as unknown as IdentityFacade,
      transport: {
        send: (message: MailMessage) => {
          if (failSend) return Promise.reject(new MailSendError('mail.transport-refused'));
          sent.push(message);
          return Promise.resolve();
        },
      },
      policy: Object.assign(Object.create(base) as ConfigNotificationsPolicy, {
        cartReminders: () => settings,
      }),
      tokens: new HmacUnsubscribeTokens(new Uint8Array(32).fill(3)),
      carts,
      reminders,
      clock,
    };
    useCase = new SendCartReminders(gate, deps);
  });

  it('sends nothing before 4 hours, the first reminder at about 4 hours, once', async () => {
    expect((await runAt(3.9)).ok).toBe(true);
    expect(sent).toEqual([]);

    const first = await runAt(4.1);
    expect(first).toMatchObject({ ok: true, value: { mode: 'live', outcomes: { sent: 1 } } });
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail).toMatchObject({
      to: 'alice.private@customer.example',
      subject: 'You left something in your cart',
    });
    expect(mail!.text).toContain('Items in your cart: 3');
    expect(mail!.text).toContain(cartPage);
    // The marketing rule's footer and the one-click header come with it.
    expect(mail!.text).toContain('Unsubscribe at any time:');
    expect(mail!.listUnsubscribe).toContain('token=');
    expect(mail!.text).not.toMatch(/\{\w+\}/);

    await runAt(5);
    await runAt(11.9);
    expect(sent).toHaveLength(1);
  });

  it('sends the second reminder at about 24 hours, once, and nothing after 72 hours', async () => {
    await runAt(4.1);
    await runAt(20);
    expect(sent).toHaveLength(1);
    await runAt(24.1);
    await runAt(30);
    expect(sent.map((m) => m.subject)).toEqual([
      'You left something in your cart',
      'Your cart is still waiting',
    ]);
    reminders.taken.clear();
    await runAt(72.5);
    expect(sent).toHaveLength(2);
  });

  it('skips a late first reminder past 12 hours but still sends the second', async () => {
    await runAt(13);
    expect(sent).toEqual([]);
    await runAt(25);
    expect(sent.map((m) => m.subject)).toEqual(['Your cart is still waiting']);
  });

  it('starts again after the buyer changes the cart', async () => {
    await runAt(4.1);
    carts.carts = [cart(1, ALICE, hoursAfter(6))];
    await runAt(9);
    expect(sent).toHaveLength(1);
    await runAt(10.1);
    expect(sent).toHaveLength(2);
  });

  it('mails nobody without consent, and stops after an unsubscribe', async () => {
    legal.granted.clear();
    expect(await runAt(4.1)).toMatchObject({ ok: true, value: { outcomes: { 'no-consent': 1 } } });
    expect(sent).toEqual([]);

    legal.granted.add(`${code}|${BOB}`);
    carts.carts = [cart(2, BOB)];
    await runAt(4.2);
    expect(sent).toHaveLength(1);
    legal.granted.delete(`${code}|${BOB}`);
    await runAt(24.1);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing in off mode or without settings, and only to test accounts in test mode', async () => {
    carts.carts = [cart(1, ALICE), cart(2, BOB)];
    settings = { mode: 'off', cartPage, testAccountIds: [ALICE] };
    expect(await runAt(4.1)).toMatchObject({ ok: true, value: { mode: 'off' } });
    settings = null;
    await runAt(4.2);
    expect(sent).toEqual([]);

    // Test mode with no test account reads nothing at all.
    settings = { mode: 'test', cartPage, testAccountIds: [] };
    carts.refuse = true;
    expect((await runAt(4.25)).ok).toBe(true);
    carts.refuse = false;

    settings = { mode: 'test', cartPage, testAccountIds: [BOB] };
    await runAt(4.3);
    expect(sent.map((m) => m.to)).toEqual(['bob.private@customer.example']);
    // ALICE is not taken in test mode, so she is still due once the Market goes live.
    settings = { mode: 'live', cartPage, testAccountIds: [] };
    await runAt(4.4);
    expect(sent.map((m) => m.to)).toEqual([
      'bob.private@customer.example',
      'alice.private@customer.example',
    ]);
  });

  it('pages through more carts than one page holds', async () => {
    const many = Array.from({ length: 450 }, (_, n) => id<'Account'>(0x1000 + n));
    for (const account of many) legal.granted.add(`${code}|${account}`);
    // Three last-change instants, so the cursor crosses equal instants and instant boundaries.
    carts.carts = many.map((account, n) =>
      cart(100 + n, account, CHANGED.subtract({ minutes: n % 3 })),
    );
    await runAt(4.1);
    expect(new Set(sent.map((m) => m.to)).size).toBe(450);
  });

  it('ends the run at the first failed send, taking only that stage, and fails on a refused read', async () => {
    carts.carts = [cart(1, ALICE), cart(2, BOB)];
    failSend = true;
    expect(await runAt(4.1)).toEqual({
      ok: false,
      error: { code: 'notifications.cart-reminders-failed' },
    });
    expect(reminders.taken.size).toBe(1);
    failSend = false;
    await runAt(4.2);
    // The failed stage is not sent again; the next cart goes in the next run.
    expect(sent.map((m) => m.to)).toEqual(['bob.private@customer.example']);

    carts.refuse = true;
    expect(await runAt(25)).toMatchObject({ ok: false });
  });

  it('purges taken reminders after 30 days, and refuses a caller other than the system', async () => {
    await runAt(4.1);
    expect(reminders.taken.size).toBe(1);
    carts.carts = [];
    expect(await runAt(4.1 + 30 * 24 + 1)).toMatchObject({ ok: true, value: { purged: 1 } });
    expect(await useCase.execute(testCallContext(market, 'anonymous'), {})).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});

// Customers management phase 2b: the admin's read of the reminders one customer was sent, on both
// Market fixtures: the customer's own rows of this Market only, both paging modes, admins only.
describe.each([['AU'], ['ZZ']] as const)(
  'the reminders a customer was sent, in market %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const T0 = Temporal.Instant.from('2026-11-16T00:00:00Z');
    const CUSTOMER = id<'Account'>(0xc1);
    const OTHER = id<'Account'>(0xc2);
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

    async function seeded() {
      const reminders = new MemoryReminders();
      for (const [n, stage] of [
        [1, 1],
        [1, 2],
        [2, 1],
      ] as const) {
        await reminders.take(
          market,
          { accountId: CUSTOMER, cartChangedAt: T0.add({ hours: n }), stage },
          T0.add({ hours: n * 10 + stage }),
        );
      }
      await reminders.take(other, { accountId: CUSTOMER, cartChangedAt: T0, stage: 1 }, T0);
      await reminders.take(market, { accountId: OTHER, cartChangedAt: T0, stage: 1 }, T0);
      return new AdminCustomerCartReminders(gate, { unitOfWork: new FakeUnitOfWork(), reminders });
    }

    it('pages the customer’s own reminders of this Market, newest first', async () => {
      const useCase = await seeded();
      const page = await useCase.execute(admin(), {
        accountId: CUSTOMER,
        direction: 'desc',
        window: { offset: 0, limit: 2 },
        withTotal: true,
      });
      expect(page).toEqual({
        ok: true,
        value: {
          total: 3,
          rows: [
            {
              cartChangedAt: T0.add({ hours: 2 }).toString(),
              stage: 1,
              sentAt: T0.add({ hours: 21 }).toString(),
            },
            {
              cartChangedAt: T0.add({ hours: 1 }).toString(),
              stage: 2,
              sentAt: T0.add({ hours: 12 }).toString(),
            },
          ],
        },
      });
      const next = await useCase.execute(admin(), {
        accountId: CUSTOMER,
        direction: 'asc',
        window: { offset: 2, limit: 3 },
        withTotal: false,
      });
      expect(next).toMatchObject({ ok: true, value: { total: null, rows: [{ stage: 1 }] } });
    });

    it('refuses the system actor and an acting-as session', async () => {
      const useCase = await seeded();
      const request = {
        accountId: CUSTOMER,
        direction: 'desc' as const,
        window: { offset: 0, limit: 10 },
        withTotal: true,
      };
      await expect(
        useCase.execute(testCallContext(market, 'system'), request),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      const acting = admin();
      await expect(
        useCase.execute(
          { ...acting, actor: { ...acting.actor, actingAs: { sellerId: 'x' } } as never },
          request,
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });

    it('declares only its own key', () => {
      expect(AdminCustomerCartReminders.access.rule).toEqual({
        kind: 'permissions',
        allOf: ['notifications.customer-cart-reminder.view'],
      });
    });
  },
);
