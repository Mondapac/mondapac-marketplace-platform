import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryReviews } from '../../../../../test/support/certification-review-fakes';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailMessage } from '../../../../platform/mail/mail-transport';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { DecisionOutcome } from '../../domain/review';
import { CheckedInReviewPolicy } from '../../infrastructure/review-policy/checked-in-review-policy';
import { ConfigCertificationMailPolicy } from '../../infrastructure/config-certification-mail-policy';
import type { ReviewSubmission } from '../ports/review.repository';
import { SendDecisionMail } from './send-decision-mail.use-case';

// The mail to the seller's Owner after a decision (certification design 12), on both Market
// fixtures: the right text per outcome, the Market's reason label, no reviewer text, no number,
// one send per delivery, and the skips (decision gone, no recipient).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-17T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('decision mail, Market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const policies = new CheckedInReviewPolicy();

  function rig(
    outcome: DecisionOutcome | null,
    options: { reasonCode?: string | null; email?: string | null } = {},
  ) {
    const clock = new FixedClock(T0);
    const ids = new SequenceIdGenerator(clock);
    const sellerId = ids.next<'Seller'>();
    const submissionId = ids.next<'Submission'>();
    const reviews = new MemoryReviews(
      code,
      {
        id: ids.next<'SellerCertification'>(),
        sellerId,
        typeCode: 'halal',
        version: 1,
      } as never,
      {
        id: submissionId,
        decision:
          outcome === null
            ? null
            : {
                outcome,
                reasonCode: options.reasonCode ?? null,
                reasonTextCiphertext: 'v1.reviewer-private-text',
                decidedAt: T0,
                actorKind: 'admin',
              },
      } as unknown as ReviewSubmission,
    );
    const sent: MailMessage[] = [];
    const handled = new Set<string>();
    const unitOfWork = {
      run: <T, E>(
        _m: MarketContext,
        work: () => Promise<{ ok: true; value: T } | { ok: false; error: E }>,
      ) => work(),
      runOnce: fakeRunOnce(handled),
    };
    const useCase = new SendDecisionMail(gate, {
      unitOfWork,
      reviews,
      contacts: {
        emailOf: () =>
          Promise.resolve(options.email === undefined ? 'owner@example.test' : options.email),
      },
      transport: {
        send: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      mailPolicy: new ConfigCertificationMailPolicy(markets),
      policies,
    });
    const delivery = (n = 1): EventDelivery => ({
      eventId: ids.next<'event'>(),
      subscriber: 'certification.approved-mail',
      attempt: n,
    });
    return {
      useCase,
      sent,
      sellerId,
      submissionId,
      delivery,
      system: testCallContext(market, 'system'),
    };
  }

  it('sends the approved mail and marks the delivery handled', async () => {
    const r = rig('approved');
    const delivery = r.delivery();
    const input = {
      delivery,
      sellerId: r.sellerId,
      submissionId: r.submissionId,
      decision: 'approved' as const,
    };
    expect(await r.useCase.execute(r.system, input)).toEqual({
      ok: true,
      value: { code: 'decision-mail.sent' },
    });
    expect(await r.useCase.execute(r.system, input)).toEqual({
      ok: true,
      value: { code: 'decision-mail.already-handled' },
    });
    // At least once (identity PN2): the mail goes before the mark, so a redelivery of a handled
    // event answers "already handled" but is not a promise of no second send.
    expect(r.sent.length).toBeGreaterThanOrEqual(1);
    expect(r.sent[0]).toMatchObject({
      to: 'owner@example.test',
      subject: 'Your certificate was approved',
    });
  });

  it.each(['changes-requested', 'declined'] as const)(
    'puts the Market reason label of a %s decision in the mail and never the reviewer text',
    async (outcome) => {
      const reason = policies.policyFor(market).reasons.find((x) => x.outcomes.includes(outcome))!;
      const r = rig(outcome, { reasonCode: reason.code });
      const result = await r.useCase.execute(r.system, {
        delivery: r.delivery(),
        sellerId: r.sellerId,
        submissionId: r.submissionId,
        decision: outcome,
      });
      expect(result).toEqual({ ok: true, value: { code: 'decision-mail.sent' } });
      expect(r.sent[0]!.text).toContain(reason.label);
      expect(r.sent[0]!.text).not.toContain('reviewer-private-text');
    },
  );

  it('skips when the decision is gone or differs, and when there is no recipient', async () => {
    const none = rig(null);
    expect(
      await none.useCase.execute(none.system, {
        delivery: none.delivery(),
        sellerId: none.sellerId,
        submissionId: none.submissionId,
        decision: 'approved',
      }),
    ).toEqual({ ok: true, value: { code: 'decision-mail.skipped', reason: 'decision.gone' } });

    const other = rig('declined');
    expect(
      await other.useCase.execute(other.system, {
        delivery: other.delivery(),
        sellerId: other.sellerId,
        submissionId: other.submissionId,
        decision: 'approved',
      }),
    ).toEqual({ ok: true, value: { code: 'decision-mail.skipped', reason: 'decision.gone' } });

    const nobody = rig('approved', { email: null });
    expect(
      await nobody.useCase.execute(nobody.system, {
        delivery: nobody.delivery(),
        sellerId: nobody.sellerId,
        submissionId: nobody.submissionId,
        decision: 'approved',
      }),
    ).toEqual({ ok: true, value: { code: 'decision-mail.skipped', reason: 'recipient.none' } });
    expect([none.sent, other.sent, nobody.sent]).toEqual([[], [], []]);
  });

  it('serves only the system actor', async () => {
    const r = rig('approved');
    const actor = testAuthenticatedActor(market, {
      population: 'admin',
      accountId: r.sellerId as unknown as Id<'Account'>,
      sessionId: r.submissionId as unknown as Id<'Session'>,
      sellerId: null,
    });
    const result = await r.useCase.execute(testCallContext(market, actor), {
      delivery: r.delivery(),
      sellerId: r.sellerId,
      submissionId: r.submissionId,
      decision: 'approved',
    });
    expect(result.ok).toBe(false);
    expect(r.sent).toEqual([]);
  });
});
