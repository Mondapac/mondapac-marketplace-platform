import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTargets } from '../ports/link-secrets';

/** One delivery of `identity.seller-registered.v1` (identity design 8.2). */
export interface SendWelcomeMailInput {
  readonly delivery: EventDelivery;
  readonly sellerId: Id;
  readonly ownerAccountId: Id | null;
  readonly origin: 'self' | 'invitation';
  /** The access state when the seller was registered: `pending` means approval is required. */
  readonly accessState: SellerAccessStateCode;
}

export type WelcomeMailSkipped =
  'origin.not-self' | 'owner.none' | 'account.gone' | 'account.disabled' | 'account.unverified';

export type SendWelcomeMailOutput =
  | { readonly code: 'welcome-mail.sent' }
  | { readonly code: 'welcome-mail.skipped'; readonly reason: WelcomeMailSkipped }
  | { readonly code: 'welcome-mail.already-handled' };

export type SendWelcomeMailFailure = { readonly code: 'access.denied' };

export interface SendWelcomeMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly targets: LinkTargets;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The seller welcome mail (`ux.md` E2, F4 step 3; SEL-02; identity design 9; slice 5). Rule
 * `system`, from the subscription `identity.welcome-mail` on `identity.seller-registered.v1`,
 * which a self-registered seller records when its owner confirms the email. The body says
 * whether the seller waits for approval (`pending` at registration) or may start (`ux.md` 3.4).
 * A seller created by an invitation (slice 8) gets no welcome here: its owner joins through the
 * invitation.
 *
 * It skips an owner account that is gone, disabled or not verified, sends outside any unit, and
 * marks the delivery in `runOnce`. The mail carries no token: its button opens the seller
 * sign-in page. No log line holds the address, the name or the body.
 */
export class SendWelcomeMail extends UseCase<
  SendWelcomeMailInput,
  SendWelcomeMailOutput,
  SendWelcomeMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-welcome-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendWelcomeMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendWelcomeMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendWelcomeMailInput,
  ): Promise<Result<SendWelcomeMailOutput, SendWelcomeMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts } = this.deps;

    let reason: WelcomeMailSkipped | null = null;
    let account = null;
    if (input.origin !== 'self') {
      reason = 'origin.not-self';
    } else if (input.ownerAccountId === null) {
      reason = 'owner.none';
    } else {
      const ownerId = input.ownerAccountId as Id<'Account'>;
      const loaded = await unitOfWork.run(
        market,
        async () => ok(await accounts.findById(market, ownerId)),
        { readOnly: true },
      );
      if (!loaded.ok) throw new Error('send-welcome-mail: the read unit failed');
      account = loaded.value;
      if (account === null || account.state.population !== 'seller') reason = 'account.gone';
      else if (account.state.status !== 'active') reason = 'account.disabled';
      else if (!account.isEmailVerified) reason = 'account.unverified';
    }

    if (reason === null && account !== null) {
      const target = this.deps.targets.target(market, 'seller', 'sign-in');
      if (target === null) {
        throw new Error(`send-welcome-mail: no seller sign-in page in ${market.marketId}`);
      }
      const composed = this.deps.composer.compose(market, {
        template: 'welcome',
        population: 'seller',
        url: target,
        approvalRequired: input.accessState === 'pending',
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
    if (!marked.ok) throw new Error('send-welcome-mail: the inbox unit failed');
    const output: SendWelcomeMailOutput = !marked.value.handled
      ? { code: 'welcome-mail.already-handled' }
      : reason === null
        ? { code: 'welcome-mail.sent' }
        : { code: 'welcome-mail.skipped', reason };
    this.#logger.log({
      msg: `identity.${output.code}`,
      ...(reason === null ? {} : { reason }),
      sellerId: input.sellerId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
