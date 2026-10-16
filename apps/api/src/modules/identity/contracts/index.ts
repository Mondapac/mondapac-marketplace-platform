// Public contracts of the identity module (ADR-0008): event types, the permission catalogue
// (identity design 5.3; slice 8a-1) and the facade interface.
// Other modules may import only what this file exports, through ../index.ts. Event
// definitions are declared in domain/events/ and re-exported here (ADR-0006 decision 6), as are
// the audited actions of domain/audit/ (docs/design/domain/platform-audit.md 3.2).
export { IDENTITY_EVENTS, SellerAccessApproved, SellerRegistered } from '../domain/events';
export { IDENTITY_AUDIT_ACTIONS } from '../domain/audit';
export * from './permissions';
export { IDENTITY_STEP_UP_ACTIONS, STEP_UP_PROOF_MINUTES, type StepUpFailure } from './step-up';
export {
  IDENTITY_FACADE,
  type ActorDescription,
  type ConfirmSecondFactorFailure,
  type ContactEmailTarget,
  type IdentityFacade,
  type SellerMembershipSummary,
} from './identity.facade';
