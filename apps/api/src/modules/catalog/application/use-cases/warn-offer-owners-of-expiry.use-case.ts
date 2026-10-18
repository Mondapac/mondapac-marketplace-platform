import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  certificateExpiryNoticeMail,
  lastValidDay,
  shouldNoticeOwner,
} from '../../domain/certificate-expiry-notice';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';
import type { CertificateOfferOwner, TagSelectionReader } from '../ports/tag-selection.reader';

/**
 * The most owners one warning reaches (each send may take up to 5 s, so one delivery stays
 * bounded); more are logged as `capped` for operators.
 */
export const MAX_OWNERS_PER_WARNING = 200;

export interface WarnOfferOwnersInput {
  readonly delivery: EventDelivery;
  /** The manufacturer certificate of `product-certification-expiry-warning-due.v1`. */
  readonly productCertificationId: string;
  readonly thresholdDays: number;
}

export type WarnOfferOwnersOutput =
  | {
      readonly code: 'catalog.expiry-notice.sent';
      readonly owners: number;
      readonly sent: number;
      readonly skipped: number;
      readonly capped: boolean;
    }
  | { readonly code: 'catalog.expiry-notice.already-handled' };

export type WarnOfferOwnersFailure = { readonly code: 'access.denied' };

export interface WarnOfferOwnersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly tagSelection: TagSelectionReader;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailTransport: MailTransport;
  readonly mailSettings: OfferOwnerMailSettings;
  readonly clock: Clock;
}

/**
 * The handler `catalog.warn-offer-owners-of-expiry` (certification design 8.3 and request C-6;
 * CERT-45; certification slice 15): rule `system`, from the subscription on certification's
 * `product-certification-expiry-warning-due.v1`; the Market is the envelope's. A read-only unit
 * finds the sellers whose Offers show a badge resting on that manufacturer certificate (`active`
 * tags whose copy names it, kind `manufacturer`), with the number of such Offers and the earliest
 * `valid_until`; outside any unit, each Owner's address comes through `identity` and one plain
 * text mail names the type, the number of Offers and the last valid day in the Market zone. A
 * seller whose badge validity has already passed is skipped (the badge goes with the expiry
 * event). Then `runOnce` marks the delivery: a retry after a partial send may mail an Owner twice
 * (at least once, as certification's mails). Nothing in the log but ids, codes and counts.
 */
export class WarnOfferOwnersOfExpiry extends UseCase<
  WarnOfferOwnersInput,
  WarnOfferOwnersOutput,
  WarnOfferOwnersFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.warn-offer-owners-of-expiry',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('WarnOfferOwnersOfExpiry');

  constructor(
    gate: UseCaseGate,
    private readonly deps: WarnOfferOwnersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: WarnOfferOwnersInput,
  ): Promise<Result<WarnOfferOwnersOutput, WarnOfferOwnersFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const certificate = parseId(input.productCertificationId);
    if (!certificate.ok) throw new Error('expiry-notice: the event holds a bad id');

    const read = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await deps.tagSelection.ownersOfCertificate(
            market,
            certificate.value as Id,
            MAX_OWNERS_PER_WARNING + 1,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('expiry-notice: the read unit failed');
    const capped = read.value.length > MAX_OWNERS_PER_WARNING;
    const owners: readonly CertificateOfferOwner[] = read.value.slice(0, MAX_OWNERS_PER_WARNING);

    const now = deps.clock.now();
    const zone = deps.mailSettings.zone(market);
    let sent = 0;
    let skipped = 0;
    for (const owner of owners) {
      if (owner.validUntil === null || !shouldNoticeOwner(owner.validUntil, now)) {
        skipped += 1;
        continue;
      }
      const to = await deps.ownerContacts.emailOf(context, owner.sellerId);
      if (to === null) {
        skipped += 1;
        continue;
      }
      const mail = certificateExpiryNoticeMail({
        typeCode: owner.typeCode,
        offers: owner.offers,
        lastDay: lastValidDay(owner.validUntil, zone),
        zone,
      });
      await deps.mailTransport.send({
        to,
        from: deps.mailSettings.sender(market),
        subject: mail.subject,
        text: mail.text,
      });
      sent += 1;
    }

    const marked = await deps.unitOfWork.runOnce(market, input.delivery, () =>
      Promise.resolve(ok(undefined)),
    );
    if (!marked.ok) throw new Error('expiry-notice: the inbox unit failed');
    const output: WarnOfferOwnersOutput = marked.value.handled
      ? { code: 'catalog.expiry-notice.sent', owners: owners.length, sent, skipped, capped }
      : { code: 'catalog.expiry-notice.already-handled' };
    const log = {
      msg: output.code,
      ...(output.code === 'catalog.expiry-notice.sent'
        ? { owners: output.owners, sent, skipped, capped }
        : {}),
      productCertificationId: input.productCertificationId,
      thresholdDays: input.thresholdDays,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (capped) this.#logger.warn(log);
    else this.#logger.log(log);
    return ok(output);
  }
}
