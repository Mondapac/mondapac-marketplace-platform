import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import { OneTimeLink } from '../../domain/one-time-link';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
import { countMailAttempt } from '../sign-up/mail-attempt';
import type { FieldProblem } from './register-customer.use-case';

export interface RequestSellerVerificationInput {
  readonly email: string;
  /** The IPv4 address or the IPv6 /64 of the client, from the socket: the `mail.origin` key. */
  readonly origin: string;
}

/** The one answer for every address (AC 21; identity design 6.7, 8.6 row 1). */
export type RequestSellerVerificationOutput = { readonly code: 'verification-resend.accepted' };

export type RequestSellerVerificationFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly FieldProblem[];
};

export interface RequestSellerVerificationDependencies {
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
 * "Send the verification email again" for a seller-side account (identity design 3.2, 3.7, 6.7,
 * 6.8; `ux.md` A3, A4; slice 5). Rule `anonymous`; the customer use case for the seller
 * population. The mail counters come first, in a unit of their own, and their verdict decides
 * whether a mail may go; only then, and only for an active, unverified seller-side account, the
 * account's `verify-email` link is requested again (the earlier token stops working) with
 * `identity.one-time-link-requested.v1`. One answer, `verification-resend.accepted`, whatever
 * the address (AC 21).
 */
export class RequestSellerVerification extends UseCase<
  RequestSellerVerificationInput,
  RequestSellerVerificationOutput,
  RequestSellerVerificationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.request-seller-verification',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('RequestSellerVerification');

  constructor(
    gate: UseCaseGate,
    private readonly deps: RequestSellerVerificationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RequestSellerVerificationInput,
  ): Promise<Result<RequestSellerVerificationOutput, RequestSellerVerificationFailure>> {
    const { market } = context;
    const { unitOfWork, accounts, links, outbox } = this.deps;
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    const accepted = ok({ code: 'verification-resend.accepted' as const });

    const now = this.deps.clock.now();
    const allowed = await countMailAttempt(
      this.deps,
      context,
      'seller',
      email.value.normalized,
      input.origin,
      now,
    );
    if (!allowed) {
      this.#logger.log({
        msg: 'identity.request-seller-verification.mail-throttled',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return accepted;
    }

    try {
      await unitOfWork.run(market, async () => {
        const account = await accounts.findByEmail(market, 'seller', email.value.normalized);
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
