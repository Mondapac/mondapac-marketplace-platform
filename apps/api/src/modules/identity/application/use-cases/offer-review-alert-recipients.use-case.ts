import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccessReviewer, AdminKeyHolders } from '../ports/access-reviewers';

/**
 * The admin key whose holders get the Offer review queue backlog mail: the key of the admins who
 * work the Offer review queue (catalog's `CATALOG_PRODUCT_APPROVE`). identity does not import
 * catalog, so the key is written here; notifications' spec checks it equals catalog's declaration.
 */
export const OFFER_REVIEW_ALERT_KEY = 'catalog.product.approve';

/** The most addresses one answer holds, in account-id order (as the reviewer notice, Hassan Q4). */
export const MAX_OFFER_REVIEW_ALERT_RECIPIENTS = 50;

export type OfferReviewAlertRecipientsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface OfferReviewAlertRecipientsDependencies {
  readonly keyHolders: AdminKeyHolders;
}

/**
 * `offerReviewAlertRecipients` (risk-based Offer approval, slice 8b): the addresses the Offer
 * review queue backlog mail goes to. Rule `system`; any other actor is refused. The recipients
 * are the reviewer rule of identity design 8.7 over a fixed key ({@link OFFER_REVIEW_ALERT_KEY}):
 * admin accounts of the context's Market that are active, have a verified email and an active
 * second factor, and hold the key among their effective keys. No caller input chooses the key or
 * the population. At most {@link MAX_OFFER_REVIEW_ALERT_RECIPIENTS}, by account id; more is an
 * error log with the count only. A failed read is `access.unavailable`, never a guess. Personal
 * data: the caller uses each address for one send and never logs, stores or puts it in an event;
 * this use case logs counts only.
 */
export class OfferReviewAlertRecipients extends UseCase<
  Record<string, never>,
  readonly string[],
  OfferReviewAlertRecipientsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.offer-review-alert-recipients',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('OfferReviewAlertRecipients');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferReviewAlertRecipientsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<readonly string[], OfferReviewAlertRecipientsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    let holders: readonly AccessReviewer[];
    try {
      holders = await this.deps.keyHolders.holdersOf(market, OFFER_REVIEW_ALERT_KEY);
    } catch {
      this.#logger.error({
        msg: 'identity.offer-review-alert-recipients.unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
    if (holders.length > MAX_OFFER_REVIEW_ALERT_RECIPIENTS) {
      this.#logger.error({
        msg: 'identity.offer-review-alert-recipients.capped',
        count: holders.length,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return ok(holders.slice(0, MAX_OFFER_REVIEW_ALERT_RECIPIENTS).map((holder) => holder.email));
  }
}
