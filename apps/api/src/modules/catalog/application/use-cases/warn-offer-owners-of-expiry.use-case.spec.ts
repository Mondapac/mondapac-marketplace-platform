import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailMessage } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { ConfigOfferOwnerMailSettings } from '../../infrastructure/offer-owner-notices';
import type { CertificateOfferOwner, TagSelectionReader } from '../ports/tag-selection.reader';
import {
  MAX_OWNERS_PER_WARNING,
  WarnOfferOwnersOfExpiry,
} from './warn-offer-owners-of-expiry.use-case';

// Certification request C-6 (CERT-45; certification slice 15), on both Market fixtures: one mail
// per Owner of Offers whose badge rests on the expiring manufacturer certificate, naming the last
// valid day in the Market zone; no mail past the badge's validity or without an address; the
// system actor only; a repeated delivery is reported as handled; the owners are bounded.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2027-06-01T00:00:00Z');
const CERT = '0197f2a0-0000-7000-8000-0000000000c1';
const seller = (n: number) =>
  `0197f2a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Seller'>;

describe.each(['AU', 'ZZ'] as const)('warn offer owners of an expiry, Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const zone = markets.get(market.marketId).timezone;
  // 00:00 of 2027-07-01 in the Market zone: the certificate counts to the end of 2027-06-30.
  const validUntil = Temporal.PlainDate.from('2027-07-01').toZonedDateTime(zone).toInstant();

  function rig(owners: readonly CertificateOfferOwner[], emails: Map<string, string | null>) {
    const sent: MailMessage[] = [];
    const asked: { certificateId: string; limit: number }[] = [];
    const tagSelection = {
      ownersOfCertificate: (_m: MarketContext, certificateId: string, limit: number) => {
        asked.push({ certificateId, limit });
        return Promise.resolve(owners.slice(0, limit));
      },
    } as unknown as TagSelectionReader;
    const handled = new Set<string>();
    const useCase = new WarnOfferOwnersOfExpiry(gate, {
      unitOfWork: {
        run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
        runOnce: fakeRunOnce(handled),
      },
      tagSelection,
      ownerContacts: { emailOf: (_c, sellerId) => Promise.resolve(emails.get(sellerId) ?? null) },
      mailTransport: {
        send: (message: MailMessage) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      mailSettings: new ConfigOfferOwnerMailSettings(markets),
      clock: new FixedClock(T0),
    });
    const delivery = (eventId = 'e1'): EventDelivery =>
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
    return { useCase, sent, asked, warn, delivery };
  }

  it('mails each Owner with a live badge on the certificate, naming the last valid day in the Market zone', async () => {
    const r = rig(
      [
        { sellerId: seller(1), typeCode: 'halal', offers: 3, validUntil },
        { sellerId: seller(2), typeCode: 'halal', offers: 1, validUntil },
        // The badge validity already passed: the expiry event removes it, no warning.
        { sellerId: seller(3), typeCode: 'halal', offers: 2, validUntil: T0 },
        { sellerId: seller(4), typeCode: 'halal', offers: 2, validUntil: null },
        // No usable address.
        { sellerId: seller(5), typeCode: 'halal', offers: 2, validUntil },
      ],
      new Map<string, string | null>([
        [seller(1), 'one@example.test'],
        [seller(2), 'two@example.test'],
        [seller(3), 'three@example.test'],
        [seller(4), 'four@example.test'],
        [seller(5), null],
      ]),
    );
    expect(await r.warn()).toEqual({
      ok: true,
      value: { code: 'catalog.expiry-notice.sent', owners: 5, sent: 2, skipped: 3, capped: false },
    });
    expect(r.asked).toEqual([{ certificateId: CERT, limit: MAX_OWNERS_PER_WARNING + 1 }]);
    expect(r.sent.map((m) => m.to)).toEqual(['one@example.test', 'two@example.test']);
    const { fromAddress } = markets.get(market.marketId).identity.mail;
    expect(r.sent[0]!.from.address).toBe(fromAddress);
    expect(r.sent[0]!.text).toContain('3 of your offers show the halal badge');
    expect(r.sent[0]!.text).toContain(`the end of 2027-06-30 (${zone} time)`);
    expect(r.sent[1]!.text).toContain('1 of your offers shows the halal badge');
    // Never an id, a certificate number or an issuer.
    expect(r.sent.map((m) => m.text).join('\n')).not.toContain(CERT);

    // A repeated delivery is reported as handled.
    expect(await r.warn()).toEqual({
      ok: true,
      value: { code: 'catalog.expiry-notice.already-handled' },
    });
  });

  it('reaches at most the bounded number of Owners and says it was capped', async () => {
    const owners = Array.from({ length: MAX_OWNERS_PER_WARNING + 5 }, (_, i) => ({
      sellerId: seller(i + 10),
      typeCode: 'halal',
      offers: 1,
      validUntil,
    }));
    const r = rig(owners, new Map(owners.map((o) => [o.sellerId, 'x@example.test'])));
    const result = await r.warn();
    expect(result).toEqual({
      ok: true,
      value: {
        code: 'catalog.expiry-notice.sent',
        owners: MAX_OWNERS_PER_WARNING,
        sent: MAX_OWNERS_PER_WARNING,
        skipped: 0,
        capped: true,
      },
    });
  });

  it('refuses any caller but the system actor, before any read', async () => {
    const r = rig([], new Map());
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
