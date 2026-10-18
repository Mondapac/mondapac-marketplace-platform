// Public contracts of the certification module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts.
export type { ClaimTermMatch } from '../domain/claim-text-matcher';
export type {
  BadgeData,
  CertificationTypeCode,
  ClaimDecision,
  ClaimQuery,
  ClaimReason,
} from '../domain/claim-types';
export {
  CERTIFICATION_FACADE,
  type CertificationFacade,
  type CertificationTypeView,
  type CertificationUnavailable,
  type CertificationValidationFailed,
  type ClaimTextInput,
  type SellerCertificateOverviewRow,
} from './certification.facade';
export { CERTIFICATION_PERMISSIONS } from './permissions';
export { CERTIFICATION_AUDIT_ACTIONS } from '../domain/audit';
export {
  CERTIFICATION_EVENTS,
  // Consumed by catalog's tag re-evaluation (catalog design 5.5, 9.5; slice 12).
  SellerCertificationApproved,
  SellerCertificationExpired,
  SellerCertificationIssuerConfirmed,
  SellerCertificationRevoked,
} from '../domain/events';
// The port `catalog` implements for certification (design 8.2, request C-3).
export {
  CATALOG_REFERENCES,
  MAX_CATALOG_REFERENCE_IDS,
  type CatalogReferences,
} from './catalog-references';
