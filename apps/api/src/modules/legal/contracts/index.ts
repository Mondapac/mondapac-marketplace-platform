// Public contracts of the legal module (ADR-0008): the facades, their tokens and the permission
// catalogue. Every customer use case is `own-resources`; the admin's read of one customer's
// consent holds `legal.customer-consent.view`. Other modules may import only what this file
// exports, through ../index.ts.
export { LEGAL_FACADE, type LegalFacade } from './legal.facade';
export {
  CUSTOMER_CONSENT_FACADE,
  type AdminConsentChange,
  type AdminConsentHistoryRequest,
  type AdminConsentState,
  type CustomerConsentFacade,
  type CustomerConsentFailure,
} from './customer-consent.facade';
export { LEGAL_CUSTOMER_CONSENT_VIEW, LEGAL_PERMISSIONS } from './permissions';
export { MARKETING_CHANNELS } from '../domain/marketing-consent';
