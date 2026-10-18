import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { shouldNoticeOwner } from '../../domain/certificate-expiry-notice';
import type {
  OfferOwnerNoticeDraft,
  OfferOwnerNoticeRepository,
} from '../ports/offer-owner-notice.repository';
import type { TagSelectionReader } from '../ports/tag-selection.reader';

/**
 * The most owners one warning reaches; more are logged as `capped` (a warning, for operators).
 * One page of the certificate selection index; the rows are written in the inbox unit.
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
      readonly code: 'catalog.expiry-notice.queued';
      readonly owners: number;
      readonly queued: number;
      readonly skipped: number;
      readonly capped: boolean;
    }
  | { readonly code: 'catalog.expiry-notice.already-handled' };

export type WarnOfferOwnersFailure = { readonly code: 'access.denied' };

export interface WarnOfferOwnersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly tagSelection: TagSelectionReader;
  readonly notices: OfferOwnerNoticeRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/**
 * The handler `catalog.warn-offer-owners-of-expiry` (certification design 8.3 and request C-6;
 * CERT-45; certification slice 15): rule `system`, from the subscription on certification's
 * `product-certification-expiry-warning-due.v1`; the Market is the envelope's. It sends nothing
 * (Hassan M1, Mojtaba N2: a handler stays within its budget and a retry never mails twice): in
 * its `runOnce` unit it finds the sellers whose Offers show a badge resting on that manufacturer
 * certificate (`active` tags whose copy names it, kind `manufacturer`), with the number of such
 * Offers and the earliest `valid_until`, and writes one pending notice per Owner whose badge is
 * still valid. The job `catalog.send-offer-owner-notices` sends them. Nothing in the log but ids,
 * codes and counts.
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
    const sourceEvent = parseId(input.delivery.eventId);
    if (!sourceEvent.ok) throw new Error('expiry-notice: the delivery holds a bad event id');

    const now = deps.clock.now();
    const marked = await deps.unitOfWork.runOnce(market, input.delivery, async () => {
      const found = await deps.tagSelection.ownersOfCertificate(
        market,
        certificate.value,
        MAX_OWNERS_PER_WARNING + 1,
      );
      const capped = found.length > MAX_OWNERS_PER_WARNING;
      const owners = found.slice(0, MAX_OWNERS_PER_WARNING);
      const notices: OfferOwnerNoticeDraft[] = [];
      for (const owner of owners) {
        // A badge already past its validity goes with the expiry event: no warning.
        if (owner.validUntil === null || !shouldNoticeOwner(owner.validUntil, now)) continue;
        notices.push({
          id: deps.ids.next<'OfferOwnerNotice'>(),
          sellerId: owner.sellerId,
          typeCode: owner.typeCode,
          offers: owner.offers,
          validUntil: owner.validUntil,
        });
      }
      const queued = await deps.notices.enqueue(market, {
        sourceEventId: sourceEvent.value,
        productCertificationId: certificate.value,
        thresholdDays: input.thresholdDays,
        notices,
        now,
      });
      return ok({ owners: owners.length, queued, skipped: owners.length - notices.length, capped });
    });
    if (!marked.ok) throw new Error('expiry-notice: the inbox unit failed');
    const output: WarnOfferOwnersOutput = marked.value.handled
      ? { code: 'catalog.expiry-notice.queued', ...marked.value.value }
      : { code: 'catalog.expiry-notice.already-handled' };
    const log = {
      msg: output.code,
      ...(output.code === 'catalog.expiry-notice.queued'
        ? {
            owners: output.owners,
            queued: output.queued,
            skipped: output.skipped,
            capped: output.capped,
          }
        : {}),
      productCertificationId: input.productCertificationId,
      thresholdDays: input.thresholdDays,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    };
    if (output.code === 'catalog.expiry-notice.queued' && output.capped) this.#logger.warn(log);
    else this.#logger.log(log);
    return ok(output);
  }
}
