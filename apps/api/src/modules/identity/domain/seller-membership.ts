import type { Id, MarketId, PendingEvent, Temporal } from '@mondapac/shared-kernel';

export const SELLER_MEMBERSHIP_STATES = ['active', 'removed'] as const;
export type SellerMembershipStateCode = (typeof SELLER_MEMBERSHIP_STATES)[number];

/** The state of a {@link SellerMembership} (identity design 2.1; data design 3.9). */
export interface SellerMembershipState {
  readonly id: Id<'SellerMembership'>;
  readonly marketId: MarketId;
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerMembershipStateCode;
  /** Set if and only if the state is `removed`. */
  readonly removedAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** A state that breaks an invariant of 2.1: a bug of the caller or a corrupt row. */
export class SellerMembershipInvariantError extends Error {
  override readonly name = 'SellerMembershipInvariantError';
  constructor(readonly invariant: 'state' | 'removed-at' | 'version') {
    super(`SellerMembership invariant broken: ${invariant}`);
  }
}

/**
 * The `SellerMembership` aggregate (identity design 2.1, 2.3): which seller an account works
 * for, read by ownership checks (R6). One active membership per account in Phase 2 (a database
 * rule, ADR-0018 decision 3). Slice 5 builds the founding membership of a self-registered
 * Seller Owner; its creation records no event (`seller-registered` carries the owner, 8.2).
 * Removal arrives with the team slices.
 */
export class SellerMembership {
  readonly #state: SellerMembershipState;

  private constructor(
    state: SellerMembershipState,
    /** The version read from the store; null for a membership not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    if (!(SELLER_MEMBERSHIP_STATES as readonly string[]).includes(state.state)) {
      throw new SellerMembershipInvariantError('state');
    }
    if ((state.state === 'removed') !== (state.removedAt !== null)) {
      throw new SellerMembershipInvariantError('removed-at');
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new SellerMembershipInvariantError('version');
    }
    this.#state = Object.freeze({ ...state });
  }

  /** The first membership of a new seller: its owner, at self-registration (5.5). */
  static found(input: {
    readonly id: Id<'SellerMembership'>;
    readonly marketId: MarketId;
    readonly accountId: Id<'Account'>;
    readonly sellerId: Id<'Seller'>;
    readonly now: Temporal.Instant;
  }): SellerMembership {
    const { id, marketId, accountId, sellerId, now } = input;
    return new SellerMembership(
      {
        id,
        marketId,
        accountId,
        sellerId,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: now,
      },
      null,
    );
  }

  /** A membership read from the store. Checks the invariants again. */
  static restore(state: SellerMembershipState): SellerMembership {
    return new SellerMembership(state, state.version);
  }

  get state(): SellerMembershipState {
    return this.#state;
  }

  get isActive(): boolean {
    return this.#state.state === 'active';
  }

  /** No change records an event in slice 5. */
  get pendingEvents(): readonly PendingEvent[] {
    return [];
  }
}
