import type { AuthenticatedActor, CallContext } from '@mondapac/shared-kernel';

// Hassan (inventory design 3.1, 4.2 step 1, finding 8): `inventory.reserve` refuses an acting-as
// (Login as Seller) session, but `AuthenticatedActor` has no acting-as field until SEL-08, so the
// refusal cannot be written yet. This is the tripwire, the pattern of
// `set-stock-level.acting-as.spec.ts`: the moment the actor or the call context gains any key, the
// assignments below stop compiling, and the SEL-08 change must add the explicit refusal to
// `reserve` and its test before it updates the lists.

type ActorKeys = Extract<keyof AuthenticatedActor, string>;
type ReviewedKeys = 'kind' | 'marketId' | 'population' | 'accountId' | 'sessionId' | 'sellerId';
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile when `AuthenticatedActor` gains or loses a key. */
const actorKeysReviewed: Exactly<ActorKeys, ReviewedKeys> = true;

type ContextKeys = Extract<keyof CallContext, string>;
type ReviewedContextKeys = 'market' | 'actor' | 'correlationId';

/** Fails to compile when `CallContext` gains or loses a key. */
const contextKeysReviewed: Exactly<ContextKeys, ReviewedContextKeys> = true;

describe('inventory.reserve and the acting-as session (Hassan finding 8)', () => {
  it('compiles only while the actor and call context have exactly the reviewed keys', () => {
    expect(actorKeysReviewed).toBe(true);
    expect(contextKeysReviewed).toBe(true);
  });
});
