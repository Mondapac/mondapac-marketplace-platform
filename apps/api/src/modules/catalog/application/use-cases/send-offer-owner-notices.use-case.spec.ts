import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { MailMessage } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { MAX_NOTICE_ATTEMPTS } from '../../domain/certificate-expiry-notice';
import { ConfigOfferOwnerMailSettings } from '../../infrastructure/offer-owner-notices';
import type {
  DueOfferOwnerNotice,
  OfferOwnerNoticeRepository,
} from '../ports/offer-owner-notice.repository';
import type { OfferOwnerMailSettings } from '../ports/offer-owner-notices';
import {
  NOTICE_BATCH_SIZE,
  NOTICE_RUN_BUDGET_MS,
  SendOfferOwnerNotices,
} from './send-offer-owner-notices.use-case';

// The sender of the warnings to Offer owners (certification request C-6; CERT-45; certification
// slice 15; Hassan M1, M2 and I2, Mojtaba N2), on both Market fixtures: each notice is sent and
// marked on its own; a failing Owner is deferred or, at the last attempt, failed, and never
// causes a resend to another or blocks the next; an Owner already marked is never mailed again;
// an unusable Market zone sends nothing; the run stops at its budget; the system actor only.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2027-06-01T00:00:00Z');
const seller = (n: number) =>
  `0197f2a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Seller'>;
const noticeId = (n: number) =>
  `0197f2a0-0000-7000-8000-${(n + 0x1000).toString(16).padStart(12, '0')}` as Id<'OfferOwnerNotice'>;

interface Row extends DueOfferOwnerNotice {
  state: 'pending' | 'sent' | 'skipped' | 'failed';
  outcome: string | null;
  nextAttemptAt: Temporal.Instant;
  attemptsNow: number;
}

describe.each(['AU', 'ZZ'] as const)('send offer owner notices, Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const zone = markets.get(market.marketId).timezone;
  const validUntil = Temporal.PlainDate.from('2027-07-01').toZonedDateTime(zone).toInstant();

  function rig(
    count: number,
    options: {
      readonly emails?: (sellerId: string) => string | null;
      readonly failSendTo?: ReadonlySet<string>;
      readonly failAddressOf?: ReadonlySet<string>;
      readonly zone?: string;
      readonly attempts?: number;
      readonly validUntil?: Temporal.Instant;
      readonly tick?: number;
    } = {},
  ) {
    const rows: Row[] = Array.from({ length: count }, (_, i) => ({
      id: noticeId(i + 1),
      sellerId: seller(i + 1),
      typeCode: 'halal',
      offers: i + 1,
      validUntil: options.validUntil ?? validUntil,
      attempts: options.attempts ?? 0,
      attemptsNow: options.attempts ?? 0,
      state: 'pending',
      outcome: null,
      nextAttemptAt: T0,
    }));
    const sent: MailMessage[] = [];
    const reads: string[] = [];
    let now = T0;
    const clock = {
      now: () => {
        const at = now;
        now = now.add({ milliseconds: options.tick ?? 0 });
        return at;
      },
    };
    const notices: OfferOwnerNoticeRepository = {
      enqueue: () => Promise.reject(new Error('not used')),
      due: (_m, at, limit) =>
        Promise.resolve(
          rows
            .filter(
              (row) =>
                row.state === 'pending' && Temporal.Instant.compare(row.nextAttemptAt, at) <= 0,
            )
            .slice(0, limit)
            .map((row) => ({ ...row, attempts: row.attemptsNow })),
        ),
      settle: (_m, id, end) => {
        const row = rows.find((r) => r.id === id)!;
        if (row.state !== 'pending') return Promise.resolve(false);
        row.state = end.state;
        row.outcome = end.state === 'sent' ? null : end.outcome;
        row.attemptsNow = end.attempts;
        return Promise.resolve(true);
      },
      defer: (_m, id, retry) => {
        const row = rows.find((r) => r.id === id)!;
        if (row.state !== 'pending') return Promise.resolve(false);
        row.attemptsNow = retry.attempts;
        row.nextAttemptAt = retry.nextAttemptAt;
        return Promise.resolve(true);
      },
    };
    const realSettings = new ConfigOfferOwnerMailSettings(markets);
    const mailSettings: OfferOwnerMailSettings = {
      sender: (m) => realSettings.sender(m),
      zone: (m) => options.zone ?? realSettings.zone(m),
    };
    const useCase = new SendOfferOwnerNotices(gate, {
      unitOfWork: {
        run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
        runOnce: () => Promise.reject(new Error('not used')),
      },
      notices,
      ownerContacts: {
        emailOf: (_c, sellerId) => {
          reads.push(sellerId);
          if (options.failAddressOf?.has(sellerId)) return Promise.reject(new Error('identity'));
          return Promise.resolve(
            options.emails ? options.emails(sellerId) : `${sellerId.slice(-4)}@example.test`,
          );
        },
      },
      mailTransport: {
        send: (message: MailMessage) => {
          if (options.failSendTo?.has(message.to)) return Promise.reject(new Error('smtp'));
          sent.push(message);
          return Promise.resolve();
        },
      },
      mailSettings,
      clock,
    });
    const run = () => useCase.execute(testCallContext(market, 'system'), {});
    const later = (minutes: number) => {
      now = now.add({ minutes });
    };
    return { rows, sent, reads, run, useCase, later };
  }

  it('sends each due notice once, naming the last valid day in the Market zone, and marks it', async () => {
    const r = rig(2);
    expect(await r.run()).toEqual({
      ok: true,
      value: { examined: 2, sent: 2, skipped: 0, deferred: 0, failed: 0, budgetSpent: false },
    });
    expect(r.sent.map((m) => m.to)).toEqual([
      `${seller(1).slice(-4)}@example.test`,
      `${seller(2).slice(-4)}@example.test`,
    ]);
    expect(r.sent[0]!.from.address).toBe(markets.get(market.marketId).identity.mail.fromAddress);
    expect(r.sent[0]!.text).toContain('1 of your offers shows the halal badge');
    expect(r.sent[1]!.text).toContain('2 of your offers show the halal badge');
    expect(r.sent[0]!.text).toContain(`the end of 2027-06-30 (${zone} time)`);
    expect(r.sent.map((m) => m.text).join('\n')).not.toContain(noticeId(1));
    expect(r.rows.map((row) => [row.state, row.attemptsNow])).toEqual([
      ['sent', 1],
      ['sent', 1],
    ]);
    // The next run finds nothing: no Owner already mailed is mailed again.
    expect(await r.run()).toEqual({
      ok: true,
      value: { examined: 0, sent: 0, skipped: 0, deferred: 0, failed: 0, budgetSpent: false },
    });
    expect(r.sent).toHaveLength(2);
  });

  it('defers only the failing Owner; the others are sent and never mailed again on its retry', async () => {
    const failing = `${seller(2).slice(-4)}@example.test`;
    const failSendTo = new Set([failing]);
    const r = rig(3, { failSendTo });
    expect(await r.run()).toEqual({
      ok: true,
      value: { examined: 3, sent: 2, skipped: 0, deferred: 1, failed: 0, budgetSpent: false },
    });
    expect(r.sent.map((m) => m.to)).not.toContain(failing);
    expect(r.rows[1]!.state).toBe('pending');
    expect(r.rows[1]!.attemptsNow).toBe(1);
    expect(r.rows[1]!.nextAttemptAt.toString()).toBe('2027-06-01T00:05:00Z');

    // Not due yet: nothing is sent.
    expect((await r.run()).ok && r.sent).toHaveLength(2);
    // Due and the transport recovered: only the deferred Owner is mailed.
    failSendTo.clear();
    r.later(5);
    expect(await r.run()).toEqual({
      ok: true,
      value: { examined: 1, sent: 1, skipped: 0, deferred: 0, failed: 0, budgetSpent: false },
    });
    expect(r.sent.map((m) => m.to)).toEqual([
      `${seller(1).slice(-4)}@example.test`,
      `${seller(3).slice(-4)}@example.test`,
      failing,
    ]);
    expect(r.rows[1]!.attemptsNow).toBe(2);
  });

  it('defers an Owner whose address read fails, without blocking the next', async () => {
    const r = rig(2, { failAddressOf: new Set([seller(1)]) });
    expect(await r.run()).toEqual({
      ok: true,
      value: { examined: 2, sent: 1, skipped: 0, deferred: 1, failed: 0, budgetSpent: false },
    });
    expect(r.rows.map((row) => row.state)).toEqual(['pending', 'sent']);
  });

  it('fails a notice at its last attempt, with the outcome, and sends the others', async () => {
    const r = rig(2, {
      attempts: MAX_NOTICE_ATTEMPTS - 1,
      failSendTo: new Set([`${seller(1).slice(-4)}@example.test`]),
    });
    expect(await r.run()).toEqual({
      ok: true,
      value: { examined: 2, sent: 1, skipped: 0, deferred: 0, failed: 1, budgetSpent: false },
    });
    expect(r.rows.map((row) => [row.state, row.outcome, row.attemptsNow])).toEqual([
      ['failed', 'send-failed', MAX_NOTICE_ATTEMPTS],
      ['sent', null, MAX_NOTICE_ATTEMPTS],
    ]);
  });

  it('skips an Owner without an address and a badge already past its validity', async () => {
    const none = rig(1, { emails: () => null });
    expect((await none.run()).ok).toBe(true);
    expect(none.rows[0]!.state).toBe('skipped');
    expect(none.rows[0]!.outcome).toBe('no-address');
    expect(none.sent).toEqual([]);

    const past = rig(1, { validUntil: T0 });
    expect((await past.run()).ok).toBe(true);
    expect(past.rows[0]!.outcome).toBe('past-validity');
    expect(past.reads).toEqual([]);
    expect(past.sent).toEqual([]);
  });

  it.each(['', '+10:00', 'Mars/Base'])(
    'sends nothing and reads nothing when the Market zone %p is not usable (fail closed)',
    async (bad) => {
      const r = rig(2, { zone: bad });
      expect(await r.run()).toEqual({ ok: false, error: { code: 'market.zone-unusable' } });
      expect(r.reads).toEqual([]);
      expect(r.sent).toEqual([]);
      expect(r.rows.every((row) => row.state === 'pending')).toBe(true);
    },
  );

  it('takes at most one batch and starts no send past its budget', async () => {
    const all = rig(NOTICE_BATCH_SIZE + 3);
    const first = await all.run();
    expect(first.ok && first.value.examined).toBe(NOTICE_BATCH_SIZE);

    // Each clock read moves on: the run stops once its budget is spent, the rest stay pending.
    const slow = rig(5, { tick: NOTICE_RUN_BUDGET_MS / 4 });
    const result = await slow.run();
    expect(result.ok && result.value.budgetSpent).toBe(true);
    expect(slow.rows.some((row) => row.state === 'pending')).toBe(true);
  });

  it('refuses any caller but the system actor, before any read', async () => {
    const r = rig(1);
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: seller(99) as unknown as Id<'Account'>,
        sessionId: seller(98) as unknown as Id<'Session'>,
        sellerId: null,
      }),
    );
    expect(await r.useCase.execute(admin, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(r.reads).toEqual([]);
  });
});
