import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
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
import { ConfigCertificationMailPolicy } from '../../infrastructure/config-certification-mail-policy';
import { CheckedInExpiryPolicy } from '../../infrastructure/expiry-policy/checked-in-expiry-policy';
import type { ExpiryNotice, SellerCertificateExpiryRepository } from '../ports/expiry.repository';
import { SendExpiryMail, type SendExpiryMailInput } from './send-expiry-mail.use-case';

// The expiry warning and the expiry notice to the seller's Owner (certification design 12; brief
// s4 c 2), on both Market fixtures: the consequence, the expiry date and the Market's submit-by
// date, one send per delivery, and no mail once the record moved on (renewed, revoked).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2027-03-01T00:00:00Z');
const SUBMIT_BY = { AU: '2027-03-24', ZZ: '2027-03-29' } as const;

describe.each(['AU', 'ZZ'] as const)('expiry mail, Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');

  function rig(notice: Partial<ExpiryNotice> | null, email: string | null = 'owner@example.test') {
    const ids = new SequenceIdGenerator(new FixedClock(T0));
    const sellerId = ids.next<'Seller'>();
    const submissionId = ids.next<'Submission'>();
    const certificateId = ids.next<'SellerCertification'>();
    const stored: ExpiryNotice | null =
      notice === null
        ? null
        : {
            sellerId,
            typeCode: 'halal',
            status: 'approved',
            approvedSubmissionId: submissionId,
            expiryDate: Temporal.PlainDate.from('2027-03-31'),
            ...notice,
          };
    const expiries = {
      notice: () => Promise.resolve(stored),
    } as unknown as SellerCertificateExpiryRepository;
    const sent: MailMessage[] = [];
    const useCase = new SendExpiryMail(gate, {
      unitOfWork: {
        run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
        runOnce: fakeRunOnce(new Set()),
      },
      expiries,
      contacts: { emailOf: () => Promise.resolve(email) },
      transport: {
        send: (message: MailMessage) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      mailPolicy: new ConfigCertificationMailPolicy(markets),
      policies: new CheckedInExpiryPolicy(),
    });
    let n = 0;
    const delivery = (): EventDelivery =>
      ({
        eventId: `e${(n += 1)}` as Id,
        subscriber: 'certification.expiry-warning-mail',
        attempt: 1,
      }) as unknown as EventDelivery;
    const send = (input: Partial<SendExpiryMailInput>, d: EventDelivery = delivery()) =>
      useCase.execute(testCallContext(market, 'system'), {
        delivery: d,
        kind: 'warning',
        certificateId,
        sellerId,
        submissionId,
        thresholdDays: 30,
        ...input,
      });
    return { send, sent, delivery, sellerId, submissionId };
  }

  it('warns 30 days ahead with the consequence and the Market submit-by date', async () => {
    const r = rig({});
    const result = await r.send({});
    expect(result).toEqual({ ok: true, value: { code: 'expiry-mail.sent' } });
    expect(r.sent).toHaveLength(1);
    const mail = r.sent[0]!;
    expect(mail.to).toBe('owner@example.test');
    expect(mail.subject).toBe('Your certificate expires in 30 days');
    expect(mail.text).toContain('valid until the end of 2027-03-31, your local time');
    expect(mail.text).toContain('cannot be bought with it');
    expect(mail.text).toContain(`by ${SUBMIT_BY[code]}`);
  });

  it('says "now" once the submit-by date is not ahead of the warning (1-day warning)', async () => {
    const r = rig({});
    await r.send({ thresholdDays: 1 });
    expect(r.sent[0]!.subject).toBe('Your certificate expires in 1 day');
    expect(r.sent[0]!.text).toContain('submit your renewed certificate now');
    expect(r.sent[0]!.text).not.toContain(SUBMIT_BY[code]);
  });

  it('sends the expiry notice for an expired record', async () => {
    const r = rig({ status: 'expired' });
    const result = await r.send({ kind: 'expired', thresholdDays: null });
    expect(result).toEqual({ ok: true, value: { code: 'expiry-mail.sent' } });
    expect(r.sent[0]!.subject).toBe('Your certificate has expired');
    expect(r.sent[0]!.text).toContain('expired at the end of 2027-03-31, your local time');
  });

  it.each([
    [
      'a renewal was approved since',
      { approvedSubmissionId: 'other' as Id<'Submission'> },
      'warning',
    ],
    ['the record was revoked', { status: 'revoked' as const }, 'warning'],
    ['the record is no longer expired', { status: 'approved' as const }, 'expired'],
    ['the record is gone', null, 'warning'],
  ] as const)('sends nothing when %s', async (_name, notice, kind) => {
    const r = rig(notice);
    const result = await r.send({ kind, thresholdDays: kind === 'warning' ? 14 : null });
    expect(result).toEqual({
      ok: true,
      value: { code: 'expiry-mail.skipped', reason: 'certificate.changed' },
    });
    expect(r.sent).toHaveLength(0);
  });

  it('skips without a recipient and marks a repeated delivery handled', async () => {
    const none = rig({}, null);
    expect(await none.send({})).toEqual({
      ok: true,
      value: { code: 'expiry-mail.skipped', reason: 'recipient.none' },
    });
    const r = rig({});
    const d = r.delivery();
    await r.send({}, d);
    expect(await r.send({}, d)).toEqual({
      ok: true,
      value: { code: 'expiry-mail.already-handled' },
    });
  });

  it('refuses any caller but the system actor', async () => {
    const r = rig({});
    const ids = new SequenceIdGenerator(new FixedClock(T0));
    const result = await new SendExpiryMail(gate, {} as never).execute(
      testCallContext(market, 'anonymous'),
      {
        delivery: r.delivery(),
        kind: 'warning',
        certificateId: ids.next(),
        sellerId: ids.next(),
        submissionId: ids.next(),
        thresholdDays: 30,
      },
    );
    expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
  });
});
