import type { AuthenticatedActor } from '@mondapac/shared-kernel';

// Hassan (inventory design 6; 4.5, finding 8): stock writes refuse an acting-as (Login as Seller)
// session, but `AuthenticatedActor` has no acting-as field until SEL-08, so the refusal cannot be
// written yet. This test is the tripwire, the pattern of pricing's `set-regular-price.acting-as`.
// It is checked at compile time by `pnpm typecheck` (apps/api/tsconfig.json includes src/): the
// moment the actor type gains any key (an acting-as account, an impersonator, a delegated flag,
// ...), the assignment below stops compiling, and the SEL-08 change must add the explicit refusal
// to `inventory.set-stock-level` (and every later stock write), the `acting_as_account_id` column
// of the ledger (data design 3.5) and their tests before it updates this list. The run-time `it`
// only keeps the file a valid suite.

/** The string keys of the authenticated actor today (the brand is a symbol and is excluded). */
type ActorKeys = Extract<keyof AuthenticatedActor, string>;

/** Exactly the keys reviewed for inventory's writes: none of them carries an acting-as session. */
type ReviewedKeys = 'kind' | 'marketId' | 'population' | 'accountId' | 'sessionId' | 'sellerId';

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile when `AuthenticatedActor` gains or loses a key. */
const actorKeysReviewed: Exactly<ActorKeys, ReviewedKeys> = true;

describe('inventory stock writes and the acting-as session (Hassan finding 8)', () => {
  it('compiles only while AuthenticatedActor has exactly the reviewed keys', () => {
    expect(actorKeysReviewed).toBe(true);
  });
});
