import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { approvedMail, changesRequestedMail, declinedMail } from '../../domain/decision-mail';
import type { DecisionOutcome } from '../../domain/review';
import type { SellerOwnerContact } from '../ports/decision-mail.ports';
import type { CertificationMailPolicy, ReviewPolicyProvider } from '../ports/review.ports';
import type { CertificateReviewRepository } from '../ports/review.repository';

export interface DecisionMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reviews: CertificateReviewRepository;
  readonly contacts: SellerOwnerContact;
  readonly transport: MailTransport;
  readonly mailPolicy: CertificationMailPolicy;
  readonly policies: ReviewPolicyProvider;
}

/** One delivery of a decision event: ids only; the decision is read now. */
export interface SendDecisionMailInput {
  readonly delivery: EventDelivery;
  readonly submissionId: string;
  readonly sellerId: string;
  readonly decision: DecisionOutcome;
}

export type SendDecisionMailOutput =
  | { readonly code: 'decision-mail.sent' }
  | { readonly code: 'decision-mail.skipped'; readonly reason: 'decision.gone' | 'recipient.none' }
  | { readonly code: 'decision-mail.already-handled' };

export type SendDecisionMailFailure = { readonly code: 'access.denied' };

const logger = new Logger('CertificationDecisionMail');

/**
 * The mail to a seller's Owner after a review decision (certification design 12): approved,
 * changes needed (with the reason) or declined (with the reason). Rule `system`, from the
 * subscriptions of the module's own decision events. As the other handlers (PN2): a read-only
 * unit loads the decision, the address is read through `identity`, the mail is sent outside any
 * unit and `runOnce` marks the delivery; a crash in between sends it again (at least once). The
 * reviewer's text, the certificate number and the address never reach a log line.
 */
export class SendDecisionMail extends UseCase<
  SendDecisionMailInput,
  SendDecisionMailOutput,
  SendDecisionMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.send-decision-mail',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DecisionMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendDecisionMailInput,
  ): Promise<Result<SendDecisionMailOutput, SendDecisionMailFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const submission = parseId<'Submission'>(input.submissionId);
    const seller = parseId<'Seller'>(input.sellerId);
    if (!submission.ok || !seller.ok) throw new Error('decision-mail: the event holds a bad id');

    const loaded = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.reviews.decisionNotice(market, submission.value)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('decision-mail: the read unit failed');
    const notice = loaded.value;

    let skipped: 'decision.gone' | 'recipient.none' | null = null;
    if (notice === null || notice.outcome !== input.decision || notice.sellerId !== seller.value) {
      skipped = 'decision.gone';
    } else {
      const to = await deps.contacts.emailOf(context, seller.value);
      if (to === null) skipped = 'recipient.none';
      else {
        const policy = deps.policies.policyFor(market);
        const reasonLabel =
          notice.reasonCode === null
            ? null
            : (policy.reasons.find((reason) => reason.code === notice.reasonCode)?.label ?? null);
        const composed =
          input.decision === 'approved'
            ? approvedMail({ typeCode: notice.typeCode })
            : input.decision === 'changes-requested'
              ? changesRequestedMail({ typeCode: notice.typeCode, reasonLabel })
              : declinedMail({ typeCode: notice.typeCode, reasonLabel });
        await deps.transport.send({
          to,
          from: deps.mailPolicy.mailSender(market),
          subject: composed.subject,
          text: composed.text,
        });
      }
    }

    const marked = await deps.unitOfWork.runOnce(market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) throw new Error('decision-mail: the inbox unit failed');
    const output: SendDecisionMailOutput = !marked.value.handled
      ? { code: 'decision-mail.already-handled' }
      : skipped !== null
        ? { code: 'decision-mail.skipped', reason: skipped }
        : { code: 'decision-mail.sent' };
    // Ids and codes only: never an address, a reason text or a number.
    logger.log({
      msg: `certification.${output.code}`,
      ...('reason' in output ? { reason: output.reason } : {}),
      decision: input.decision,
      submissionId: input.submissionId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
