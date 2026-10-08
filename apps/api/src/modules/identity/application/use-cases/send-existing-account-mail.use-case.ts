import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTargets } from '../ports/link-secrets';

/** One delivery of `identity.sign-up-repeated.v1` (identity design 6.7, 8.2). */
export interface SendExistingAccountMailInput {
  readonly delivery: EventDelivery;
  readonly accountId: Id;
  readonly cause: 'unverified-replaced' | 'verified-notice';
  /** When the sign-up recorded the notice: the account's notice instant, unless a later one. */
  readonly occurredAt: Temporal.Instant;
}

export type ExistingAccountMailSkipped =
  | 'cause.not-a-notice'
  | 'account.gone'
  | 'account.disabled'
  | 'account.unverified'
  | 'notice.superseded';

export type SendExistingAccountMailOutput =
  | { readonly code: 'existing-account-mail.sent' }
  | { readonly code: 'existing-account-mail.skipped'; readonly reason: ExistingAccountMailSkipped }
  | { readonly code: 'existing-account-mail.already-handled' };

export type SendExistingAccountMailFailure = { readonly code: 'access.denied' };

export interface SendExistingAccountMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly targets: LinkTargets;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The "you already have an account" mail (identity design 6.7, 9; `ux.md` E12; AC 21; slice 3).
 * Rule `system`, from the subscription `identity.existing-account-mail` on
 * `identity.sign-up-repeated.v1`. Only the `verified-notice` cause mails; the other cause (an
 * unverified account's repeated sign-up) is mailed through its new link request (3.7).
 *
 * The sign-up already decided, from its own counter reservations, that this notice may go
 * (Mojtaba item 3) and recorded the notice instant, at most once per the Market's interval; the
 * handler reads no counter. It skips an account that is gone, disabled, no longer verified, or
 * whose notice instant has moved on (a later event will mail); then it sends outside any unit
 * and marks the delivery in `runOnce`. The mail carries no token: its button opens the sign-in
 * page. No log line holds the address or the body.
 */
export class SendExistingAccountMail extends UseCase<
  SendExistingAccountMailInput,
  SendExistingAccountMailOutput,
  SendExistingAccountMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-existing-account-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendExistingAccountMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendExistingAccountMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendExistingAccountMailInput,
  ): Promise<Result<SendExistingAccountMailOutput, SendExistingAccountMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts } = this.deps;

    let reason: ExistingAccountMailSkipped | null = null;
    let account = null;
    if (input.cause !== 'verified-notice') {
      reason = 'cause.not-a-notice';
    } else {
      const loaded = await unitOfWork.run(
        market,
        async () => ok(await accounts.findById(market, input.accountId as Id<'Account'>)),
        { readOnly: true },
      );
      if (!loaded.ok) throw new Error('send-existing-account-mail: the read unit failed');
      account = loaded.value;
      if (account === null) reason = 'account.gone';
      else if (account.state.status !== 'active') reason = 'account.disabled';
      else if (!account.isEmailVerified) reason = 'account.unverified';
      // A later notice has its own event, which mails; this one is stale.
      else if (
        account.state.existingAccountNoticeAt === null ||
        Temporal.Instant.compare(account.state.existingAccountNoticeAt, input.occurredAt) > 0
      ) {
        reason = 'notice.superseded';
      }
    }

    if (reason === null && account !== null) {
      const population = account.state.population;
      const target = this.deps.targets.target(market, population, 'sign-in');
      if (target === null) {
        throw new Error(
          `send-existing-account-mail: no sign-in page for ${population} in ${market.marketId}`,
        );
      }
      const composed = this.deps.composer.compose(market, {
        template: 'existing-account',
        population,
        url: target,
      });
      await this.deps.transport.send({
        to: account.state.email.typed,
        from: this.deps.policy.mailSender(market),
        subject: composed.subject,
        text: composed.text,
      });
    }

    const marked = await unitOfWork.runOnce(market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) throw new Error('send-existing-account-mail: the inbox unit failed');
    const output: SendExistingAccountMailOutput = !marked.value.handled
      ? { code: 'existing-account-mail.already-handled' }
      : reason === null
        ? { code: 'existing-account-mail.sent' }
        : { code: 'existing-account-mail.skipped', reason };
    this.#logger.log({
      msg: `identity.${output.code}`,
      ...(reason === null ? {} : { reason }),
      accountId: input.accountId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
