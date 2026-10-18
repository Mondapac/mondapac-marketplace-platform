import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type {
  OfferOwnerNoticeDraft,
  OfferOwnerNoticeRepository,
} from '../ports/offer-owner-notice.repository';
import type { CertificateOfferOwner, TagSelectionReader } from '../ports/tag-selection.reader';
import {
  MAX_OWNERS_PER_WARNING,
  WarnOfferOwnersOfExpiry,
} from './warn-offer-owners-of-expiry.use-case';

// Certification request C-6 (CERT-45; certification slice 15; Hassan M1, Mojtaba N2), on both
// Market fixtures: the handler sends nothing; in its inbox unit it writes one pending notice per
// Owner whose badge on the expiring manufacturer certificate is still valid; the system actor
// only; a repeated delivery writes nothing; the owners are bounded.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2027-06-01T00:00:00Z');
const CERT = '0197f2a0-0000-7000-8000-0000000000c1';
const EVENT = '0197f2a0-0000-7000-8000-0000000000e1';
const seller = (n: number) =>
  `0197f2a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Seller'>;

describe.each(['AU', 'ZZ'] as const)('warn offer owners of an expiry, Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const zone = markets.get(market.marketId).timezone;
  const validUntil = Temporal.PlainDate.from('2027-07-01').toZonedDateTime(zone).toInstant();

  function rig(owners: readonly CertificateOfferOwner[]) {
    const asked: { certificateId: string; limit: number }[] = [];
    const written: {
      sourceEventId: string;
      thresholdDays: number;
      notices: OfferOwnerNoticeDraft[];
    }[] = [];
    let inUnit = false;
    const tagSelection = {
      ownersOfCertificate: (_m: MarketContext, certificateId: string, limit: number) => {
        expect(inUnit).toBe(true);
        asked.push({ certificateId, limit });
        return Promise.resolve(owners.slice(0, limit));
      },
    } as unknown as TagSelectionReader;
    const notices = {
      enqueue: (_m: MarketContext, batch: Parameters<OfferOwnerNoticeRepository['enqueue']>[1]) => {
        expect(inUnit).toBe(true);
        written.push({
          sourceEventId: batch.sourceEventId,
          thresholdDays: batch.thresholdDays,
          notices: [...batch.notices],
        });
        return Promise.resolve(batch.notices.length);
      },
    } as unknown as OfferOwnerNoticeRepository;
    const handled = new Set<string>();
    const runOnce = fakeRunOnce(handled);
    const clock = new FixedClock(T0);
    const useCase = new WarnOfferOwnersOfExpiry(gate, {
      unitOfWork: {
        run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
        runOnce: (async (m: MarketContext, d: EventDelivery, work: () => Promise<unknown>) => {
          inUnit = true;
          try {
            return await (runOnce as (a: unknown, b: unknown, c: unknown) => Promise<unknown>)(
              m,
              d,
              work,
            );
          } finally {
            inUnit = false;
          }
        }) as never,
      },
      tagSelection,
      notices,
      ids: new SequenceIdGenerator(clock),
      clock,
    });
    const delivery = (eventId = EVENT): EventDelivery =>
      ({
        eventId,
        subscriber: 'catalog.warn-offer-owners-of-expiry',
        attempt: 1,
      }) as unknown as EventDelivery;
    const warn = (eventId?: string) =>
      useCase.execute(testCallContext(market, 'system'), {
        delivery: delivery(eventId),
        productCertificationId: CERT,
        thresholdDays: 30,
      });
    return { useCase, asked, written, warn, delivery };
  }

  it('writes one pending notice per Owner with a live badge in the inbox unit, and sends nothing', async () => {
    const r = rig([
      { sellerId: seller(1), typeCode: 'halal', offers: 3, validUntil },
      { sellerId: seller(2), typeCode: 'halal', offers: 1, validUntil },
      // The badge validity already passed: the expiry event removes it, no warning.
      { sellerId: seller(3), typeCode: 'halal', offers: 2, validUntil: T0 },
      { sellerId: seller(4), typeCode: 'halal', offers: 2, validUntil: null },
    ]);
    expect(await r.warn()).toEqual({
      ok: true,
      value: {
        code: 'catalog.expiry-notice.queued',
        owners: 4,
        queued: 2,
        skipped: 2,
        capped: false,
      },
    });
    expect(r.asked).toEqual([{ certificateId: CERT, limit: MAX_OWNERS_PER_WARNING + 1 }]);
    expect(r.written).toHaveLength(1);
    expect(r.written[0]!.sourceEventId).toBe(EVENT);
    expect(r.written[0]!.thresholdDays).toBe(30);
    expect(r.written[0]!.notices.map((n) => [n.sellerId, n.offers])).toEqual([
      [seller(1), 3],
      [seller(2), 1],
    ]);

    // A repeated delivery writes nothing more.
    expect(await r.warn()).toEqual({
      ok: true,
      value: { code: 'catalog.expiry-notice.already-handled' },
    });
    expect(r.written).toHaveLength(1);
  });

  it('writes at most the bounded number of Owners and says it was capped', async () => {
    const owners = Array.from({ length: MAX_OWNERS_PER_WARNING + 5 }, (_, i) => ({
      sellerId: seller(i + 10),
      typeCode: 'halal',
      offers: 1,
      validUntil,
    }));
    const r = rig(owners);
    expect(await r.warn()).toEqual({
      ok: true,
      value: {
        code: 'catalog.expiry-notice.queued',
        owners: MAX_OWNERS_PER_WARNING,
        queued: MAX_OWNERS_PER_WARNING,
        skipped: 0,
        capped: true,
      },
    });
    expect(r.written[0]!.notices).toHaveLength(MAX_OWNERS_PER_WARNING);
  });

  it('refuses any caller but the system actor, before any read', async () => {
    const r = rig([]);
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: seller(99) as unknown as Id<'Account'>,
        sessionId: seller(98) as unknown as Id<'Session'>,
        sellerId: null,
      }),
    );
    expect(
      await r.useCase.execute(admin, {
        delivery: r.delivery(),
        productCertificationId: CERT,
        thresholdDays: 30,
      }),
    ).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(r.asked).toEqual([]);
  });
});
