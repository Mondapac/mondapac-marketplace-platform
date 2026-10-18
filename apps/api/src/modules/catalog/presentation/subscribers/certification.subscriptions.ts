import {
  ClaimPolicyChanged,
  ProductCertificationApproved,
  ProductCertificationCoverageChanged,
  SellerCertificationApproved,
  SellerCertificationExpired,
  SellerCertificationIssuerConfirmed,
  SellerCertificationRevoked,
} from '../../../certification';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { ReevaluateFromCertification } from '../../application/use-cases/reevaluate-from-certification.use-case';

/** The subscriber names: also the `handler` of `catalog.inbox` (design 9.5). */
export const REEVALUATE_ON_SELLER_CERTIFICATION_APPROVED =
  'catalog.reevaluate-on-seller-certification-approved';
export const REEVALUATE_ON_SELLER_CERTIFICATION_EXPIRED =
  'catalog.reevaluate-on-seller-certification-expired';
export const REEVALUATE_ON_SELLER_CERTIFICATION_REVOKED =
  'catalog.reevaluate-on-seller-certification-revoked';
export const REEVALUATE_ON_SELLER_CERTIFICATION_ISSUER_CONFIRMED =
  'catalog.reevaluate-on-seller-certification-issuer-confirmed';
export const REEVALUATE_ON_CLAIM_POLICY_CHANGED = 'catalog.reevaluate-on-claim-policy-changed';
export const REEVALUATE_ON_PRODUCT_CERTIFICATION_APPROVED =
  'catalog.reevaluate-on-product-certification-approved';
export const REEVALUATE_ON_PRODUCT_CERTIFICATION_COVERAGE_CHANGED =
  'catalog.reevaluate-on-product-certification-coverage-changed';

/**
 * Catalog's subscriptions to certification's seller-certificate events (catalog design 5.5, 9.5;
 * slice 12) and, from certification slice 14, to the claim policy and manufacturer certificate
 * events, which select by the type id of their payload. Entry adapters only: the delivery and the Market's system-actor context (the Market
 * from the envelope) go unchanged to the one `system` use case, with the cause and the id the
 * cause selects by, both taken from the payload of a definition certification publishes. A
 * refusal throws, so the delivery is retried and, after its last attempt, dead-lettered with an
 * alert (P 6.4); the daily reconciliation is the backstop.
 */
export function certificationSubscriptions(
  reevaluate: ReevaluateFromCertification,
): RegisteredSubscription[] {
  const run = async (
    name: string,
    ...[context, input]: Parameters<ReevaluateFromCertification['execute']>
  ): Promise<void> => {
    const result = await reevaluate.execute(context, input);
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: REEVALUATE_ON_SELLER_CERTIFICATION_APPROVED,
      event: SellerCertificationApproved,
      handle: (event, delivery, context) =>
        run(REEVALUATE_ON_SELLER_CERTIFICATION_APPROVED, context, {
          delivery,
          occurredAt: event.occurredAt,
          cause: 'seller-certification-approved',
          subjectId: event.payload.sellerId,
        }),
    }),
    subscription({
      name: REEVALUATE_ON_SELLER_CERTIFICATION_EXPIRED,
      event: SellerCertificationExpired,
      handle: (event, delivery, context) =>
        run(REEVALUATE_ON_SELLER_CERTIFICATION_EXPIRED, context, {
          delivery,
          occurredAt: event.occurredAt,
          cause: 'seller-certification-expired',
          subjectId: event.payload.sellerCertificationId,
        }),
    }),
    subscription({
      name: REEVALUATE_ON_SELLER_CERTIFICATION_REVOKED,
      event: SellerCertificationRevoked,
      handle: (event, delivery, context) =>
        run(REEVALUATE_ON_SELLER_CERTIFICATION_REVOKED, context, {
          delivery,
          occurredAt: event.occurredAt,
          cause: 'seller-certification-revoked',
          subjectId: event.payload.sellerCertificationId,
        }),
    }),
    subscription({
      name: REEVALUATE_ON_SELLER_CERTIFICATION_ISSUER_CONFIRMED,
      event: SellerCertificationIssuerConfirmed,
      handle: (event, delivery, context) =>
        run(REEVALUATE_ON_SELLER_CERTIFICATION_ISSUER_CONFIRMED, context, {
          delivery,
          occurredAt: event.occurredAt,
          cause: 'seller-certification-issuer-confirmed',
          subjectId: event.payload.submissionId,
        }),
    }),
    subscription({
      name: REEVALUATE_ON_CLAIM_POLICY_CHANGED,
      event: ClaimPolicyChanged,
      handle: (event, delivery, context) =>
        run(REEVALUATE_ON_CLAIM_POLICY_CHANGED, context, {
          delivery,
          occurredAt: event.occurredAt,
          cause: 'claim-policy-changed',
          subjectId: event.payload.typeId,
        }),
    }),
    subscription({
      name: REEVALUATE_ON_PRODUCT_CERTIFICATION_APPROVED,
      event: ProductCertificationApproved,
      handle: (event, delivery, context) =>
        run(REEVALUATE_ON_PRODUCT_CERTIFICATION_APPROVED, context, {
          delivery,
          occurredAt: event.occurredAt,
          cause: 'product-certification-approved',
          subjectId: event.payload.typeId,
        }),
    }),
    subscription({
      name: REEVALUATE_ON_PRODUCT_CERTIFICATION_COVERAGE_CHANGED,
      event: ProductCertificationCoverageChanged,
      handle: (event, delivery, context) =>
        run(REEVALUATE_ON_PRODUCT_CERTIFICATION_COVERAGE_CHANGED, context, {
          delivery,
          occurredAt: event.occurredAt,
          cause: 'product-certification-coverage-changed',
          subjectId: event.payload.typeId,
          recheckCertificateId: event.payload.productCertificationId,
        }),
    }),
  ];
}
