import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { expiredMail, expiryWarningMail } from '../../domain/decision-mail';
import { renewalSubmitBy } from '../../domain/expiry';
import type { SellerOwnerContact } from '../ports/decision-mail.ports';
import type {
  ExpiryPolicyProvider,
  SellerCertificateExpiryRepository,
} from '../ports/expiry.repository';
import type { CertificationMailPolicy } from '../ports/review.ports';

export interface ExpiryMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly expiries: SellerCertificateExpiryRepository;
  readonly contacts: SellerOwnerContact;
  readonly transport: MailTransport;
  readonly mailPolicy: CertificationMailPolicy;
  readonly policies: ExpiryPolicyProvider;
  readonly clock: Clock;
}

/** One delivery of `-expiry-warning-due` or `-expired`: ids (and the threshold) only. */
export interface SendExpiryMailInput {
  readonly delivery: EventDelivery;
  readonly kind: 'warning' | 'expired';
  readonly certificateId: string;
  readonly sellerId: string;
  readonly submissionId: string;
  /** The warning's threshold; null for `expired`. */
  readonly thresholdDays: number | null;
}

export type SendExpiryMailOutput =
  | { readonly code: 'expiry-mail.sent' }
  | {
      readonly code: 'expiry-mail.skipped';
      readonly reason: 'certificate.changed' | 'warning.past-expiry' | 'recipient.none';
    }
  | { readonly code: 'expiry-mail.already-handled' };

export type SendExpiryMailFailure = { readonly code: 'access.denied' };

const logger = new Logger('CertificationExpiryMail');

/**
 * The expiry warning and the expiry notice to a seller's Owner (certification design 12; brief
 * s4 c 2): rule `system`, from the subscriptions of the module's own events. As the decision
 * mail (PN2): a read-only unit loads the record now, the address comes through `identity`, the
 * mail is sent outside any unit and `runOnce` marks the delivery (at least once). A record that
 * moved on before delivery (a renewal approved, revoked) gets no mail: a warning only while the
 * named submission is still the approved one of an `approved` record, the notice only while the
 * record is `expired` on it. A warning delivered after its certificate's boundary is not sent
 * (the text names the expiry date, never a count of days).
 */
export class SendExpiryMail extends UseCase<
  SendExpiryMailInput,
  SendExpiryMailOutput,
  SendExpiryMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.send-expiry-mail',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ExpiryMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendExpiryMailInput,
  ): Promise<Result<SendExpiryMailOutput, SendExpiryMailFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const certificate = parseId<'SellerCertification'>(input.certificateId);
    const seller = parseId<'Seller'>(input.sellerId);
    const submission = parseId<'Submission'>(input.submissionId);
    if (!certificate.ok || !seller.ok || !submission.ok) {
      throw new Error('expiry-mail: the event holds a bad id');
    }
    if (
      input.kind === 'warning' &&
      (input.thresholdDays === null || !Number.isInteger(input.thresholdDays))
    ) {
      throw new Error('expiry-mail: a warning without a threshold');
    }

    const loaded = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.expiries.notice(market, certificate.value)),
      { readOnly: true },
    );
    if (!loaded.ok) throw new Error('expiry-mail: the read unit failed');
    const notice = loaded.value;

    let skipped: 'certificate.changed' | 'warning.past-expiry' | 'recipient.none' | null = null;
    const expectedStatus = input.kind === 'warning' ? 'approved' : 'expired';
    if (
      notice === null ||
      notice.sellerId !== seller.value ||
      notice.approvedSubmissionId !== submission.value ||
      notice.status !== expectedStatus ||
      notice.expiryDate === null
    ) {
      skipped = 'certificate.changed';
    } else if (
      input.kind === 'warning' &&
      (notice.boundary === null || Temporal.Instant.compare(deps.clock.now(), notice.boundary) >= 0)
    ) {
      // A warning delivered after the expiry would say the wrong thing (Hassan I2).
      skipped = 'warning.past-expiry';
    } else {
      const to = await deps.contacts.emailOf(context, seller.value);
      if (to === null) skipped = 'recipient.none';
      else {
        const expiryDate = notice.expiryDate.toString();
        let composed;
        if (input.kind === 'warning') {
          const thresholdDays = input.thresholdDays!;
          const submitByDays = deps.policies.policyFor(market).renewalSubmitByDays;
          // The submit-by day is named only while it is still ahead of the warning's day.
          const submitBy =
            thresholdDays <= submitByDays
              ? null
              : renewalSubmitBy(notice.expiryDate, submitByDays).toString();
          composed = expiryWarningMail({ typeCode: notice.typeCode, expiryDate, submitBy });
        } else {
          composed = expiredMail({ typeCode: notice.typeCode, expiryDate });
        }
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
    if (!marked.ok) throw new Error('expiry-mail: the inbox unit failed');
    const output: SendExpiryMailOutput = !marked.value.handled
      ? { code: 'expiry-mail.already-handled' }
      : skipped !== null
        ? { code: 'expiry-mail.skipped', reason: skipped }
        : { code: 'expiry-mail.sent' };
    // Ids and codes only: never an address.
    logger.log({
      msg: `certification.${output.code}`,
      ...('reason' in output ? { reason: output.reason } : {}),
      kind: input.kind,
      ...(input.thresholdDays === null ? {} : { thresholdDays: input.thresholdDays }),
      certificateId: input.certificateId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
