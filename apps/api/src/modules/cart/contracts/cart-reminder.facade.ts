import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** A signed-in customer's cart that holds lines and has been idle. Ids and counts only. */
export interface IdleCart {
  readonly cartId: Id<'Cart'>;
  readonly accountId: Id<'Account'>;
  /** The cart's last change: a reminder is sent once per stage for each value. */
  readonly lastChangedAt: Temporal.Instant;
  readonly lineCount: number;
}

/** The cart reads of the notifications cart reminder (personalization 1c). */
export interface CartReminderFacade {
  /**
   * One page (at most 200) of the Market's account carts with lines, last changed after
   * `changedAfter` and at or before `changedAtOrBefore`, in `(lastChangedAt, cartId)` order after
   * `after`. Never a guest or merged cart, nor one the buyer has not changed since a paid order
   * cleared lines from it. System actor only.
   */
  idleCarts(
    context: CallContext,
    request: {
      readonly changedAfter: Temporal.Instant;
      readonly changedAtOrBefore: Temporal.Instant;
      readonly after: {
        readonly lastChangedAt: Temporal.Instant;
        readonly cartId: Id<'Cart'>;
      } | null;
      readonly limit: number;
      /** Only these accounts' carts (a Market's test accounts), at most 50. */
      readonly accountIds?: readonly Id<'Account'>[];
    },
  ): Promise<Result<readonly IdleCart[], AccessDenied | { readonly code: 'validation.failed' }>>;
}

/** Nest token of the {@link CartReminderFacade}, provided and exported by `CartModule`. */
export const CART_REMINDER_FACADE = Symbol('CART_REMINDER_FACADE');
