import { err, ok } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { SubscriberContext } from '../../../../platform/events/event-subscriptions';
import type { CultureDemoteApprovalsSystem } from '../../application/use-cases/culture-demote-approvals-system.use-case';
import type { RecheckCultureCertificates } from '../../application/use-cases/recheck-culture-certificates.use-case';
import type { RecheckCulturesOfIssuer } from '../../application/use-cases/recheck-cultures-of-issuer.use-case';
import {
  cultureCertificateSubscriptions,
  DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER,
  RECHECK_ON_CERTIFICATE_EXPIRED_SUBSCRIBER,
  RECHECK_ON_CERTIFICATE_REVOKED_SUBSCRIBER,
  RECHECK_ON_ISSUER_DEACTIVATED_SUBSCRIBER,
} from './culture-certificate.subscriptions';

// The wiring of sellers' culture subscriptions (multi-culture package 3a; QA on #848): each event
// reaches its one system use case with the delivery's Market context, a refusal throws (retry), and
// the N1 demotion throws while approvals remain.

const delivery = {} as EventDelivery;
const SELLER = '01990000-0000-7000-8000-000000000051';
const CULTURE = '01990000-0000-7000-8000-0000000000c1';
const ISSUER = '01990000-0000-7000-8000-0000000000e1';

describe.each(['AU', 'ZZ'])('sellers culture subscriptions in %s', (marketId) => {
  const context = { market: { marketId } } as unknown as SubscriberContext;

  function subscriptions(answer: { refuse?: boolean; remaining?: boolean } = {}) {
    const calls: { useCase: string; market: string; input: unknown }[] = [];
    const fake = (useCase: string, value: unknown) => ({
      execute: (given: SubscriberContext, input: unknown) => {
        calls.push({ useCase, market: given.market.marketId, input });
        return Promise.resolve(answer.refuse ? err({ code: 'sellers.unavailable' }) : ok(value));
      },
    });
    const all = cultureCertificateSubscriptions(
      fake('recheck', { demoted: 0 }) as unknown as RecheckCultureCertificates,
      fake('demote', {
        demoted: 1,
        remaining: answer.remaining === true,
      }) as unknown as CultureDemoteApprovalsSystem,
      fake('recheck-issuer', { demoted: 0 }) as unknown as RecheckCulturesOfIssuer,
    );
    const fire = (name: string, payload: object) =>
      all.find((item) => item.name === name)!.handle({ payload } as never, delivery, context);
    return { calls, fire };
  }

  it('re-checks the seller on a certificate expired or revoked', async () => {
    const s = subscriptions();
    await s.fire(RECHECK_ON_CERTIFICATE_EXPIRED_SUBSCRIBER, { sellerId: SELLER });
    await s.fire(RECHECK_ON_CERTIFICATE_REVOKED_SUBSCRIBER, { sellerId: SELLER });
    expect(s.calls).toEqual([
      { useCase: 'recheck', market: marketId, input: { sellerId: SELLER } },
      { useCase: 'recheck', market: marketId, input: { sellerId: SELLER } },
    ]);
  });

  it('re-checks the sellers of a derecognised issuer, and ignores closed-to-new', async () => {
    const s = subscriptions();
    await s.fire(RECHECK_ON_ISSUER_DEACTIVATED_SUBSCRIBER, {
      issuerId: ISSUER,
      form: 'closed-to-new',
    });
    await s.fire(RECHECK_ON_ISSUER_DEACTIVATED_SUBSCRIBER, {
      issuerId: ISSUER,
      form: 'derecognised',
    });
    expect(s.calls).toEqual([
      { useCase: 'recheck-issuer', market: marketId, input: { issuerId: ISSUER } },
    ]);
  });

  it('demotes on approvals invalidated, and throws while approvals remain (N1 retry)', async () => {
    await subscriptions().fire(DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER, { cultureId: CULTURE });
    await expect(
      subscriptions({ remaining: true }).fire(DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER, {
        cultureId: CULTURE,
      }),
    ).rejects.toThrow('approvals remain');
  });

  it.each([
    [RECHECK_ON_CERTIFICATE_EXPIRED_SUBSCRIBER, { sellerId: SELLER }],
    [RECHECK_ON_CERTIFICATE_REVOKED_SUBSCRIBER, { sellerId: SELLER }],
    [RECHECK_ON_ISSUER_DEACTIVATED_SUBSCRIBER, { issuerId: ISSUER, form: 'derecognised' }],
    [DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER, { cultureId: CULTURE }],
  ])('%s throws on a refusal, so the delivery is retried', async (name, payload) => {
    await expect(subscriptions({ refuse: true }).fire(name, payload)).rejects.toThrow(
      'refused: sellers.unavailable',
    );
  });
});
