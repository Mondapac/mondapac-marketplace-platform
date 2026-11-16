import { err } from '@mondapac/shared-kernel';
import type {
  CustomerSectionPeers,
  IdentitySectionPeer,
} from '../application/ports/customer-section-peers';

const UNAVAILABLE = () => Promise.resolve(err({ code: 'access.unavailable' as const }));

/**
 * The owners of the customer page's sections, refusing (fail closed) until
 * `CustomersSectionsModule` binds the real facades at start.
 */
export class LateBoundSectionPeers implements CustomerSectionPeers {
  #bound: CustomerSectionPeers | null = null;

  bind(peers: CustomerSectionPeers): void {
    this.#bound = peers;
  }

  readonly identity: IdentitySectionPeer = {
    adminCustomerSignIns: (context, request) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.adminCustomerSignIns(context, request),
    adminRevealCustomerSignIn: (context, input) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.adminRevealCustomerSignIn(context, input),
    adminCustomerSessions: (context, accountId) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.adminCustomerSessions(context, accountId),
    adminSignOutCustomer: (context, accountId) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.adminSignOutCustomer(context, accountId),
    adminSendCustomerPasswordReset: (context, accountId) =>
      this.#bound === null
        ? UNAVAILABLE()
        : this.#bound.identity.adminSendCustomerPasswordReset(context, accountId),
  };
}
