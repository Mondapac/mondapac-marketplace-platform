// Public contracts of the certification module (ADR-0008): event types and the facade interface.
// Other modules may import only what this file exports, through ../index.ts.
export type { ClaimTermMatch } from '../domain/claim-text-matcher';
export type { CertificationTypeCode } from '../domain/claim-types';
export {
  CERTIFICATION_FACADE,
  type CertificationFacade,
  type CertificationTypeView,
  type CertificationUnavailable,
  type CertificationValidationFailed,
  type ClaimTextInput,
} from './certification.facade';
