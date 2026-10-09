import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccessDecisionKind } from '../../domain/access-decision';
import type { AccessDecisionRepository } from '../ports/access-decision.repository';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMail, IdentityMailComposer } from '../ports/identity-mails';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTargets } from '../ports/link-secrets';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import { readSellerPeople } from '../sellers/seller-owner';

/** One delivery of a decision event: `identity.seller-access-<decision>.v1` (8.2). */
export interface SendSellerAccessMailInput {
  readonly delivery: EventDelivery;
  readonly sellerId: Id;
  readonly decisionId: Id;
  /** The decision the event announced; the stored decision must be the same. */
  readonly decision: AccessDecisionKind;
}

export type SellerAccessMailSkipped =
  | 'decision.gone'
  | 'decision.superseded'
  | 'owner.none'
  | 'account.disabled'
  | 'account.unverified'
  | 'reason.erased';

export type SendSellerAccessMailOutput =
  | { readonly code: 'seller-access-mail.sent' }
  | { readonly code: 'seller-access-mail.skipped'; readonly reason: SellerAccessMailSkipped }
  | { readonly code: 'seller-access-mail.already-handled' };

export type SendSellerAccessMailFailure = { readonly code: 'access.denied' };

export interface SendSellerAccessMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly decisions: AccessDecisionRepository;
  readonly memberships: SellerMembershipRepository;
  readonly grants: RoleGrantReader;
  readonly accounts: AccountRepository;
  readonly targets: LinkTargets;
  readonly composer: IdentityMailComposer;
  readonly transport: MailTransport;
  readonly policy: IdentityMarketPolicy;
}

const TEMPLATES = {
  approved: 'seller-approved',
  rejected: 'seller-rejected',
  suspended: 'seller-suspended',
  reinstated: 'seller-reinstated',
} as const;

/**
 * The result mails of the access decisions (`ux.md` E4 to E7; identity design 3.3, 9; SEL-02,
 * SEL-13; slice 9), to the **Seller Owner only** (decision 9: Staff never read the reason). Rule
 * `system`, from the four subscriptions `identity.seller-<decision>-mail`. The order of 9:
 *
 * 1. A read-only unit loads the decision (its reason opened under the seller's key), the seller's
 *    latest decision and its owner. Nothing is sent, and the delivery is only marked, when the
 *    decision is gone or is not the one announced, when a later decision superseded it (a late
 *    delivery never tells an outdated state), when the seller has no owner yet (an invitation not
 *    accepted), when the owner is disabled or unverified, or when the reason was erased with the
 *    seller's key.
 * 2. Outside any unit: the mail is rendered in the Market's locale and sent. E5 and E6 quote the
 *    reason in the body (`ux.md` 3.4); subjects never hold it. E4, E5 and E7 link to the seller
 *    sign-in page, E6 has no button. No token.
 * 3. `runOnce` marks the delivery. Mail is at least once (a crash after the send repeats it).
 *
 * No log line holds the address, the reason or the body: ids and codes only.
 */
export class SendSellerAccessMail extends UseCase<
  SendSellerAccessMailInput,
  SendSellerAccessMailOutput,
  SendSellerAccessMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.send-seller-access-mail',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SendSellerAccessMail');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SendSellerAccessMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendSellerAccessMailInput,
  ): Promise<Result<SendSellerAccessMailOutput, SendSellerAccessMailFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, decisions } = this.deps;
    const sellerId = input.sellerId as Id<'Seller'>;

    const loaded = await unitOfWork.run(
      market,
      async () => {
        const decision = await decisions.findById(market, input.decisionId as Id<'AccessDecision'>);
        const latest = await decisions.latestOf(market, sellerId);
        const people = await readSellerPeople(this.deps, market, sellerId);
        return ok({ decision, latest, owner: people.owner });
      },
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('send-seller-access-mail: the read unit failed');
    const { decision, latest, owner } = loaded.value;

    let reason: SellerAccessMailSkipped | null = null;
    if (
      decision === null ||
      decision.sellerId !== sellerId ||
      decision.decision !== input.decision
    ) {
      reason = 'decision.gone';
    } else if (latest?.id !== decision.id) reason = 'decision.superseded';
    else if (owner === null) reason = 'owner.none';
    else if (owner.state.status !== 'active') reason = 'account.disabled';
    else if (!owner.isEmailVerified) reason = 'account.unverified';
    else if (decision.reasonErased) reason = 'reason.erased';

    if (reason === null && owner !== null && decision !== null) {
      const mail = this.mailOf(context, decision.decision, decision.reason);
      const composed = this.deps.composer.compose(market, mail);
      await this.deps.transport.send({
        to: owner.state.email.typed,
        from: this.deps.policy.mailSender(market),
        subject: composed.subject,
        text: composed.text,
      });
    }

    const marked = await unitOfWork.runOnce(market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) throw new Error('send-seller-access-mail: the inbox unit failed');
    const output: SendSellerAccessMailOutput = !marked.value.handled
      ? { code: 'seller-access-mail.already-handled' }
      : reason === null
        ? { code: 'seller-access-mail.sent' }
        : { code: 'seller-access-mail.skipped', reason };
    this.#logger.log({
      msg: `identity.${output.code}`,
      ...(reason === null ? {} : { reason }),
      decision: input.decision,
      sellerId: input.sellerId,
      decisionId: input.decisionId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }

  private mailOf(
    context: CallContext,
    decision: AccessDecisionKind,
    reason: string | null,
  ): IdentityMail {
    const template = TEMPLATES[decision];
    if (template === 'seller-suspended') {
      if (reason === null) throw new Error('send-seller-access-mail: a suspension has a reason');
      return { template, population: 'seller', reason };
    }
    const url = this.deps.targets.target(context.market, 'seller', 'sign-in');
    if (url === null) {
      throw new Error(
        `send-seller-access-mail: no seller sign-in page in ${context.market.marketId}`,
      );
    }
    if (template === 'seller-rejected') {
      if (reason === null) throw new Error('send-seller-access-mail: a rejection has a reason');
      return { template, population: 'seller', url, reason };
    }
    return { template, population: 'seller', url };
  }
}
