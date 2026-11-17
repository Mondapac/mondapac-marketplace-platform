import { err } from '@mondapac/shared-kernel';
import type { CustomerSectionPeers } from '../application/ports/customer-section-peers';

const UNAVAILABLE = () => Promise.resolve(err({ code: 'access.unavailable' as const }));

type Method = (...args: never[]) => Promise<unknown>;

/**
 * One owner's methods, each refusing (fail closed) until the owner is bound, then calling it with
 * the caller's arguments unchanged.
 */
function lateBound<K extends keyof CustomerSectionPeers>(
  bound: () => CustomerSectionPeers | null,
  owner: K,
  methods: readonly (keyof CustomerSectionPeers[K])[],
): CustomerSectionPeers[K] {
  return Object.fromEntries(
    methods.map((name) => [
      name,
      (...args: never[]) => {
        const peers = bound();
        if (peers === null) return UNAVAILABLE();
        return (peers[owner][name] as Method).apply(peers[owner], args);
      },
    ]),
  ) as CustomerSectionPeers[K];
}

/**
 * The owners of the customer page's sections, refusing (fail closed) until
 * `CustomersSectionsModule` binds the real facades at start.
 */
export class LateBoundSectionPeers implements CustomerSectionPeers {
  #bound: CustomerSectionPeers | null = null;

  bind(peers: CustomerSectionPeers): void {
    this.#bound = peers;
  }

  readonly #peers = () => this.#bound;

  readonly identity = lateBound(this.#peers, 'identity', [
    'adminCustomerSignIns',
    'adminRevealCustomerSignIn',
    'adminCustomerSessions',
    'adminSignOutCustomer',
    'adminSendCustomerPasswordReset',
  ]);

  readonly cart = lateBound(this.#peers, 'cart', ['adminCustomerCart', 'adminCustomerSavedItems']);

  readonly reminders = lateBound(this.#peers, 'reminders', ['adminCustomerCartReminders']);

  readonly behaviour = lateBound(this.#peers, 'behaviour', [
    'adminCustomerBehaviour',
    'adminCustomerCartAdditions',
  ]);

  readonly consent = lateBound(this.#peers, 'consent', [
    'adminCustomerConsent',
    'adminCustomerConsentHistory',
  ]);

  readonly conversations = lateBound(this.#peers, 'conversations', ['adminCustomerConversations']);
}
