import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { issuerDerecognisedMail } from '../../domain/decision-mail';
import type { SellerOwnerContact } from '../ports/decision-mail.ports';
import type { CertificationRegistryRepository } from '../ports/registry.repository';
import type { CertificationMailPolicy } from '../ports/review.ports';

export interface DerecognitionMailDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly registry: CertificationRegistryRepository;
  readonly contacts: SellerOwnerContact;
  readonly transport: MailTransport;
  readonly mailPolicy: CertificationMailPolicy;
}

/** One delivery of `issuer-deactivated.v1`; only `form: derecognised` mails anyone. */
export interface SendDerecognitionMailInput {
  readonly delivery: EventDelivery;
  readonly issuerId: string;
  readonly form: 'closed-to-new' | 'derecognised';
}

export type SendDerecognitionMailOutput =
  | { readonly code: 'derecognition-mail.sent'; readonly sent: number; readonly skipped: number }
  | { readonly code: 'derecognition-mail.issuer-gone' }
  | { readonly code: 'derecognition-mail.not-applicable' }
  | { readonly code: 'derecognition-mail.already-handled' };

export type SendDerecognitionMailFailure = { readonly code: 'access.denied' };

/** The sellers read per page; every page is mailed before the next is read. */
export const DERECOGNITION_MAIL_PAGE = 100;

const logger = new Logger('CertificationDerecognitionMail');

/**
 * The mail of deactivation form 2 (certification design 3.5, 12; Q6): one mail to the Owner of
 * each seller whose approved certificate names the derecognised issuer. Rule `system`, from the
 * subscription of the module's own `issuer-deactivated.v1`. As the other mails (PN2): the sellers
 * are read in read-only units by page, each address through `identity`, each mail sent outside
 * any unit, and `runOnce` marks the delivery at the end. Delivery is at least once: a failure part
 * way throws, the delivery is retried, and the sellers already mailed get the mail again (a
 * one-time safety notice; per-seller markers are an open item). The text names the type and the
 * issuer's public name only. The log line holds ids and counts only.
 */
export class SendDerecognitionMail extends UseCase<
  SendDerecognitionMailInput,
  SendDerecognitionMailOutput,
  SendDerecognitionMailFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.send-derecognition-mail',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DerecognitionMailDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SendDerecognitionMailInput,
  ): Promise<Result<SendDerecognitionMailOutput, SendDerecognitionMailFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const parsed = parseId<'Issuer'>(input.issuerId);
    if (!parsed.ok) throw new Error('derecognition-mail: the event holds a bad id');
    const issuerId = parsed.value;

    const mails = input.form === 'derecognised';
    const loaded = mails
      ? await deps.unitOfWork.run(
          market,
          async () => ok(await deps.registry.issuer(market, issuerId)),
          { readOnly: true },
        )
      : ok(null);
    if (!loaded.ok) throw new Error('derecognition-mail: the read unit failed');
    const issuer = loaded.value;

    let sent = 0;
    let skipped = 0;
    if (issuer !== null && issuer.state === 'derecognised') {
      const composed = issuerDerecognisedMail({
        typeCode: issuer.typeCode,
        issuerName: issuer.displayName,
      });
      const from = deps.mailPolicy.mailSender(market);
      let after: Id<'Seller'> | null = null;
      for (;;) {
        const cursor: Id<'Seller'> | null = after;
        const page: Result<readonly Id<'Seller'>[], never> = await deps.unitOfWork.run(
          market,
          async () =>
            ok(
              await deps.registry.affectedSellers(
                market,
                issuerId,
                cursor,
                DERECOGNITION_MAIL_PAGE,
              ),
            ),
          { readOnly: true },
        );
        if (!page.ok) throw new Error('derecognition-mail: the read unit failed');
        for (const sellerId of page.value) {
          const to = await deps.contacts.emailOf(context, sellerId);
          if (to === null) {
            skipped += 1;
            continue;
          }
          await deps.transport.send({ to, from, subject: composed.subject, text: composed.text });
          sent += 1;
        }
        if (page.value.length < DERECOGNITION_MAIL_PAGE) break;
        after = page.value[page.value.length - 1]!;
      }
    }

    const marked = await deps.unitOfWork.runOnce(market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) throw new Error('derecognition-mail: the inbox unit failed');
    const output: SendDerecognitionMailOutput = !marked.value.handled
      ? { code: 'derecognition-mail.already-handled' }
      : !mails
        ? { code: 'derecognition-mail.not-applicable' }
        : issuer === null || issuer.state !== 'derecognised'
          ? { code: 'derecognition-mail.issuer-gone' }
          : { code: 'derecognition-mail.sent', sent, skipped };
    logger.log({
      msg: `certification.${output.code}`,
      ...('sent' in output ? { sent: output.sent, skipped: output.skipped } : {}),
      issuerId,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
