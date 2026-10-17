import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { issuerAddedMail, issuerNotAcceptedMail } from '../../domain/decision-mail';
import type { IssuerRequestOutcome } from '../../domain/issuer-request';
import type { SellerOwnerContact } from '../ports/decision-mail.ports';
import type { IssuerRequestRepository } from '../ports/issuer-request.repository';
import type { CertificationMailPolicy, ReviewPolicyProvider } from '../ports/review.ports';

export interface IssuerRequestMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly requests: IssuerRequestRepository;
  readonly contacts: SellerOwnerContact;
  readonly transport: MailTransport;
  readonly mailPolicy: CertificationMailPolicy;
  readonly policies: ReviewPolicyProvider;
}

/** One delivery of `issuer-request-answered.v1`: ids and the outcome; the answer is read now. */
export interface SendIssuerRequestMailInput {
  readonly delivery: EventDelivery;
  readonly issuerRequestId: string;
  readonly sellerId: string;
  readonly outcome: IssuerRequestOutcome;
}

export type SendIssuerRequestMailOutput =
  | { readonly code: 'issuer-request-mail.sent' }
  | {
      readonly code: 'issuer-request-mail.skipped';
      readonly reason: 'answer.gone' | 'recipient.none';
    }
  | { readonly code: 'issuer-request-mail.already-handled' };

export type SendIssuerRequestMailFailure = { readonly code: 'access.denied' };

const logger = new Logger('CertificationIssuerRequestMail');

/**
 * The mail to a seller's Owner after an admin answered their "my issuer is not listed" request
 * (certification design 12). Rule `system`, from the subscription of the module's own
 * `issuer-request-answered.v1`. As the decision mail (PN2): a read-only unit loads the answer, the
 * address is read through `identity`, the mail is sent outside any unit and `runOnce` marks the
 * delivery. The mail goes to the seller only, never to an issuer, and it carries the type and the
 * Market's plain reason label: never the typed name. The log line holds ids and codes only.
 */
export class SendIssuerRequestMail extends UseCase<
  SendIssuerRequestMailInput,
  SendIssuerRequestMailOutput,
  SendIssuerRequestMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.send-issuer-request-mail',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssuerRequestMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendIssuerRequestMailInput,
  ): Promise<Result<SendIssuerRequestMailOutput, SendIssuerRequestMailFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const request = parseId<'IssuerRequest'>(input.issuerRequestId);
    const seller = parseId<'Seller'>(input.sellerId);
    if (!request.ok || !seller.ok) throw new Error('issuer-request-mail: the event holds a bad id');

    const loaded = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.requests.notice(market, request.value)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('issuer-request-mail: the read unit failed');
    const notice = loaded.value;

    let skipped: 'answer.gone' | 'recipient.none' | null = null;
    if (notice === null || notice.state !== input.outcome || notice.sellerId !== seller.value) {
      skipped = 'answer.gone';
    } else {
      const to = await deps.contacts.emailOf(context, seller.value);
      if (to === null) skipped = 'recipient.none';
      else {
        const reasonLabel =
          notice.answerReasonCode === null
            ? null
            : (deps.policies
                .policyFor(market)
                .issuerRequestReasons.find((reason) => reason.code === notice.answerReasonCode)
                ?.label ?? null);
        const composed =
          input.outcome === 'issuer-added'
            ? issuerAddedMail({ typeCode: notice.typeCode })
            : issuerNotAcceptedMail({ typeCode: notice.typeCode, reasonLabel });
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
    if (!marked.ok) throw new Error('issuer-request-mail: the inbox unit failed');
    const output: SendIssuerRequestMailOutput = !marked.value.handled
      ? { code: 'issuer-request-mail.already-handled' }
      : skipped !== null
        ? { code: 'issuer-request-mail.skipped', reason: skipped }
        : { code: 'issuer-request-mail.sent' };
    logger.log({
      msg: `certification.${output.code}`,
      ...('reason' in output ? { reason: output.reason } : {}),
      outcome: input.outcome,
      issuerRequestId: input.issuerRequestId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
