import type { AuthenticatedActor } from '@mondapac/shared-kernel';

// Hassan, part 3b review L2 (pricing design 5.4, 21 carried condition): pricing's writes refuse
// an acting-as (Login as Seller) session, but `AuthenticatedActor` has no acting-as field until
// SEL-08, so the refusal cannot be written yet. This test is the tripwire. It is checked at
// compile time by `pnpm typecheck` (apps/api/tsconfig.json includes src/): the moment the actor
// type gains any key (an acting-as account, an impersonator, a delegated flag, ...), the
// assignment below stops compiling, and the SEL-08 change must add the explicit refusal to
// `pricing.set-regular-price` (and every later pricing write) with its test before it updates
// this list. The run-time `it` only keeps the file a valid suite.

/** The string keys of the authenticated actor today (the brand is a symbol and is excluded). */
type ActorKeys = Extract<keyof AuthenticatedActor, string>;

/** Exactly the keys reviewed for pricing's writes: none of them carries an acting-as session. */
type ReviewedKeys = 'kind' | 'marketId' | 'population' | 'accountId' | 'sessionId' | 'sellerId';

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile when `AuthenticatedActor` gains or loses a key. */
const actorKeysReviewed: Exactly<ActorKeys, ReviewedKeys> = true;

describe('pricing writes and the acting-as session (Hassan L2)', () => {
  it('compiles only while AuthenticatedActor has exactly the reviewed keys', () => {
    expect(actorKeysReviewed).toBe(true);
  });
});
