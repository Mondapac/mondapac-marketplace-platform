import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
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

type OwnerResult<T> = Promise<Result<T, { readonly code: string }>>;
type Window = { readonly offset: number; readonly limit: number };
type Page<R> = { readonly rows: readonly R[]; readonly total: number | null };

// The shapes below mirror the owners' facade contracts (cart, notifications, engagement, legal,
// assistant). They are declared here, not imported: those modules reach `ordering`, which
// imports `customers`, so even a type import would close a module cycle. The real facades
// satisfy them structurally when `CustomersSectionsModule` binds them, which the compiler checks.

/** One line of the current cart: ids, quantity, the price when added (Money) and when. */
export interface SectionCartLine {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly priceAtAdd: Money;
  readonly addedAt: string;
}

export interface SectionCart {
  readonly cart: {
    readonly createdAt: string;
    readonly lastChangedAt: string;
    readonly lines: readonly SectionCartLine[];
  } | null;
  readonly savedCount: number;
}

export interface SectionSavedItem {
  readonly savedItemId: Id<'SavedItem'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly savedAt: string;
}

export interface SectionReminderSent {
  readonly cartChangedAt: string;
  readonly stage: 1 | 2;
  /**
   * When notifications took the stage for sending (`cart_reminders.taken_at`), not proof of
   * delivery: the claim stays when the send then failed or was skipped (no consent, no address,
   * unsubscribe or contact not configured), so the stage is never retried.
   */
  readonly sentAt: string;
}

export interface SectionCartAddition {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly addedAt: string;
}

export interface SectionBehaviour {
  readonly personalization: { readonly enabled: boolean; readonly changedAt: string | null };
  readonly summary: {
    readonly productViews: number;
    readonly categoryViews: number;
    readonly cartAdditions: number;
    readonly topCategories: readonly {
      readonly categoryId: Id<'Category'>;
      readonly views: number;
    }[];
  };
}

export interface SectionConsentState {
  readonly channel: string;
  readonly granted: boolean;
  readonly source: string | null;
  readonly changedAt: string | null;
}

export interface SectionConsentChange {
  readonly channel: string;
  readonly granted: boolean;
  readonly source: string;
  readonly occurredAt: string;
}

export interface SectionConversationDates {
  readonly startedAt: string;
  readonly lastMessageAt: string;
}

interface AccountPageRequest {
  readonly accountId: Id<'Account'>;
  readonly direction: 'asc' | 'desc';
  readonly window: Window;
  readonly withTotal: boolean;
}

/** cart: the current cart and the saved-for-later list. */
export interface CartSectionPeer {
  adminCustomerCart(context: CallContext, accountId: Id<'Account'>): OwnerResult<SectionCart>;
  adminCustomerSavedItems(
    context: CallContext,
    request: AccountPageRequest,
  ): OwnerResult<Page<SectionSavedItem>>;
}

/** notifications: the abandoned-cart reminders sent (kept 30 days). */
export interface RemindersSectionPeer {
  adminCustomerCartReminders(
    context: CallContext,
    request: AccountPageRequest,
  ): OwnerResult<Page<SectionReminderSent>>;
}

/** engagement: the personalization switch, the behaviour summary and the add-to-cart history. */
export interface BehaviourSectionPeer {
  adminCustomerBehaviour(
    context: CallContext,
    accountId: Id<'Account'>,
  ): OwnerResult<SectionBehaviour>;
  adminCustomerCartAdditions(
    context: CallContext,
    request: AccountPageRequest & {
      readonly from: Temporal.Instant | null;
      readonly to: Temporal.Instant | null;
    },
  ): OwnerResult<Page<SectionCartAddition>>;
}

/** legal: the marketing consent and its history. */
export interface ConsentSectionPeer {
  adminCustomerConsent(
    context: CallContext,
    accountId: Id<'Account'>,
  ): OwnerResult<{ readonly channels: readonly SectionConsentState[] }>;
  adminCustomerConsentHistory(
    context: CallContext,
    request: AccountPageRequest & { readonly channels: readonly string[] | null },
  ): OwnerResult<Page<SectionConsentChange>>;
}

/** assistant: the count (always) and the dates of the customer's conversations. */
export interface ConversationsSectionPeer {
  adminCustomerConversations(
    context: CallContext,
    request: Omit<AccountPageRequest, 'withTotal'>,
  ): OwnerResult<{ readonly rows: readonly SectionConversationDates[]; readonly total: number }>;
}

export interface CustomerSectionPeers {
  readonly identity: IdentitySectionPeer;
  readonly cart: CartSectionPeer;
  readonly reminders: RemindersSectionPeer;
  readonly behaviour: BehaviourSectionPeer;
  readonly consent: ConsentSectionPeer;
  readonly conversations: ConversationsSectionPeer;
}

export const CUSTOMER_SECTION_PEERS = Symbol('CUSTOMER_SECTION_PEERS');
