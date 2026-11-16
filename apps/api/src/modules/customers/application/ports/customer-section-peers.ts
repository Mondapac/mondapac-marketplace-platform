import type { IdentityFacade } from '../../../identity';

// What the customer page's sections (customers management phase 2b) ask of the modules that own
// their data: one facade read per owner, each behind the owner's own key, which the owner checks
// again. The real facades satisfy these structurally; `CustomersSectionsModule` binds them at
// start, and until then every call fails closed. Types only: customers imports no other module's
// code here, so no module cycle forms (cart, reviews and the others reach ordering, which imports
// customers).

/** identity: the customer's sign-ins, sessions, the reveal and the two account actions. */
export type IdentitySectionPeer = Pick<
  IdentityFacade,
  | 'adminCustomerSignIns'
  | 'adminRevealCustomerSignIn'
  | 'adminCustomerSessions'
  | 'adminSignOutCustomer'
  | 'adminSendCustomerPasswordReset'
>;

export interface CustomerSectionPeers {
  readonly identity: IdentitySectionPeer;
}

export const CUSTOMER_SECTION_PEERS = Symbol('CUSTOMER_SECTION_PEERS');
