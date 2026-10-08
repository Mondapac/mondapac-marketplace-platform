import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import { OneTimeLink } from '../../domain/one-time-link';
import { reservationVerdict } from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { FieldProblem } from './register-customer.use-case';

export interface RequestCustomerVerificationInput {
  readonly email: string;
  /** The IPv4 address or the IPv6 /64 of the client, from the socket: the `mail.origin` key. */
  readonly origin: string;
}

/** The one answer for every address (AC 21; identity design 6.7, 8.6 row 1). */
export type RequestCustomerVerificationOutput = {
  readonly code: 'verification-resend.accepted';
};

export type RequestCustomerVerificationFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly FieldProblem[];
};

export interface RequestCustomerVerificationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * "Send the verification email again" for a customer (identity design 3.2, 3.7, 6.7, 6.8; `ux.md`
 * A3 and A4; slice 3). Rule `anonymous`. One answer, `verification-resend.accepted`, whether or
 * not the address has an account (AC 21).
 *
 * The mail counters come first, in a short READ COMMITTED unit of their own as at sign-up:
 * `mail.account` (the address) and `mail.origin` count every request, and their verdict, taken
 * from the reservations that unit returned, decides whether a mail may go (Mojtaba item 3). Only
 * then, and only for an active, unverified customer account, a second unit requests the account's
 * `verify-email` link again (the earlier token stops working) and records
 * `identity.one-time-link-requested.v1`; the mail handler does the rest. A verified, disabled or
 * unknown account gets nothing. Two requests that race on one link: the loser changes nothing and
 * answers the same.
 */
export class RequestCustomerVerification extends UseCase<
  RequestCustomerVerificationInput,
  RequestCustomerVerificationOutput,
  RequestCustomerVerificationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.request-customer-verification',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('RequestCustomerVerification');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RequestCustomerVerificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RequestCustomerVerificationInput,
  ): Promise<Result<RequestCustomerVerificationOutput, RequestCustomerVerificationFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy, accounts, links, outbox } = this.deps;
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    const accepted = ok({ code: 'verification-resend.accepted' as const });

    const now = this.deps.clock.now();
    const mail = policy.mailThrottles(market);
    const accountKey = keys.account(market, 'customer', email.value.normalized);
    const counters: readonly ThrottleCounter[] = [
      { kind: 'mail.account', keyHash: accountKey, accountKey, rule: mail.account },
      {
        kind: 'mail.origin',
        keyHash: keys.origin(market, input.origin),
        accountKey: null,
        rule: mail.origin,
      },
    ];
    const counted = await unitOfWork.run(market, async () => {
      const reservations = await throttles.reserve(market, counters, now);
      const reserved = reservations.map((reservation, index) => ({
        reservation,
        rule: counters[index]!.rule,
      }));
      return ok(reservationVerdict(reserved, now).allowed);
    });
    if (!counted.ok || !counted.value) {
      this.#logger.log({
        msg: 'identity.request-customer-verification.mail-throttled',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return accepted;
    }

    try {
      await unitOfWork.run(market, async () => {
        const account = await accounts.findByEmail(market, 'customer', email.value.normalized);
        if (account === null || account.isEmailVerified || account.state.status !== 'active') {
          return ok(undefined);
        }
        const found = await links.findFor(market, account.state.id, 'verify-email');
        let link: OneTimeLink;
        if (found === null) {
          link = OneTimeLink.request({
            id: this.deps.ids.next<'OneTimeLink'>(),
            marketId: market.marketId,
            accountId: account.state.id,
            purpose: 'verify-email',
            now,
            notify: true,
          });
          await links.add(market, link);
        } else {
          link = found;
          link.requestAgain(now, true);
          await links.save(market, link);
        }
        await outbox.append(context, link.pendingEvents);
        return ok(undefined);
      });
    } catch (error) {
      // A concurrent request renewed the same link first; it sends the mail (AC 21: same answer).
      if (!(error instanceof StaleAggregateError)) throw error;
    }
    return accepted;
  }
}
