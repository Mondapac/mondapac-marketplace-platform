import { CultureApprovalsInvalidated } from '../../../catalog';
import { SellerCertificationExpired, SellerCertificationRevoked } from '../../../certification';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { CultureDemoteApprovalsSystem } from '../../application/use-cases/culture-demote-approvals-system.use-case';
import type { RecheckCultureCertificates } from '../../application/use-cases/recheck-culture-certificates.use-case';

/** The subscriber names: also the `handler` of `sellers.inbox`. */
export const RECHECK_ON_CERTIFICATE_EXPIRED_SUBSCRIBER =
  'sellers.recheck-cultures-on-certificate-expired';
export const RECHECK_ON_CERTIFICATE_REVOKED_SUBSCRIBER =
  'sellers.recheck-cultures-on-certificate-revoked';
export const DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER =
  'sellers.demote-on-culture-approvals-invalidated';

/**
 * Sellers' subscriptions of multi-culture package 3a. Entry adapters: the Market's system-actor
 * context goes unchanged to one `system` use case; a refusal throws, so the delivery is retried
 * and, after its last attempt, dead-lettered with an alert (P 6.4).
 *
 * - A seller certificate expired or was revoked (ADR-0048 security review M2): the seller's
 *   approvals in certified cultures are re-checked against its valid certificates now, and one
 *   without a valid certificate of the culture's type goes back to `requested`. Certification has
 *   no "suspended" state for a seller certificate (only for a manufacturer certificate, which is
 *   no membership basis), so these two events are every end of validity besides the stored
 *   boundary itself, which the visibility rule checks at read time.
 * - Catalog could not restore a culture's required type nor demote at once (security review N1):
 *   every approval of the culture is taken back to `requested`. While approvals are left
 *   (`remaining`), the handler throws, so the outbox retries it until none is left.
 *
 * Registered by `SellerStoreProfileModule`: certification and catalog import sellers, so their
 * events are imported only outside `SellersModule`'s file graph.
 */
export function cultureCertificateSubscriptions(
  recheck: RecheckCultureCertificates,
  demote: CultureDemoteApprovalsSystem,
): RegisteredSubscription[] {
  const rechecked = async (
    name: string,
    context: Parameters<RecheckCultureCertificates['execute']>[0],
    sellerId: string,
  ): Promise<void> => {
    const result = await recheck.execute(context, { sellerId });
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: RECHECK_ON_CERTIFICATE_EXPIRED_SUBSCRIBER,
      event: SellerCertificationExpired,
      handle: (event, _delivery, context) =>
        rechecked(RECHECK_ON_CERTIFICATE_EXPIRED_SUBSCRIBER, context, event.payload.sellerId),
    }),
    subscription({
      name: RECHECK_ON_CERTIFICATE_REVOKED_SUBSCRIBER,
      event: SellerCertificationRevoked,
      handle: (event, _delivery, context) =>
        rechecked(RECHECK_ON_CERTIFICATE_REVOKED_SUBSCRIBER, context, event.payload.sellerId),
    }),
    subscription({
      name: DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER,
      event: CultureApprovalsInvalidated,
      async handle(event, _delivery, context) {
        const result = await demote.execute(context, { cultureId: event.payload.cultureId });
        if (!result.ok) {
          throw new Error(
            `${DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER} refused: ${result.error.code}`,
          );
        }
        if (result.value.remaining) {
          throw new Error(`${DEMOTE_ON_APPROVALS_INVALIDATED_SUBSCRIBER}: approvals remain, retry`);
        }
      },
    }),
  ];
}
