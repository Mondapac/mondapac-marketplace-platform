import type { Id, MarketId, PendingEvent, Temporal } from '@mondapac/shared-kernel';
import { SELLER_ACCESS_STATES, SELLER_ORIGINS, SellerRegistered } from './events';

export type SellerOrigin = (typeof SELLER_ORIGINS)[number];
export type SellerAccessStateCode = (typeof SELLER_ACCESS_STATES)[number];

/** The state of a {@link SellerAccess} (identity design 2.1, 3.3; data design 3.9). */
export interface SellerAccessState {
  readonly sellerId: Id<'Seller'>;
  readonly marketId: MarketId;
  readonly origin: SellerOrigin;
  readonly state: SellerAccessStateCode;
  readonly stateChangedAt: Temporal.Instant;
  /** Re-applications since the last approval (3.3); never negative. */
  readonly reapplyCount: number;
  /** When `seller-registered` was recorded (M4); null until the owner verified the email. */
  readonly registeredAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** A state that breaks an invariant of 2.1 or 3.3: a bug of the caller or a corrupt row. */
export class SellerAccessInvariantError extends Error {
  override readonly name = 'SellerAccessInvariantError';
  constructor(readonly invariant: 'reapply-count' | 'version' | 'state' | 'origin') {
    super(`SellerAccess invariant broken: ${invariant}`);
  }
}

/**
 * The `SellerAccess` aggregate (identity design 2.1 and 3.3; ADR-0022): one per seller id,
 * minted by `identity`; its state covers every account of the seller. Slice 5 builds the
 * creation by self-registration and the `seller-registered` step; the decisions (approve,
 * reject, suspend, reinstate, re-apply) arrive with slice 9. Times come from the caller's
 * `Clock`; a change raises the version by one and records at most one event.
 */
export class SellerAccess {
  #state: SellerAccessState;
  #events: PendingEvent[] = [];

  private constructor(
    state: SellerAccessState,
    /** The version read from the store; null for a seller not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    if (!Number.isInteger(state.reapplyCount) || state.reapplyCount < 0) {
      throw new SellerAccessInvariantError('reapply-count');
    }
    if (!Number.isInteger(state.version) || state.version < 1) {
      throw new SellerAccessInvariantError('version');
    }
    if (!(SELLER_ACCESS_STATES as readonly string[]).includes(state.state)) {
      throw new SellerAccessInvariantError('state');
    }
    if (!(SELLER_ORIGINS as readonly string[]).includes(state.origin)) {
      throw new SellerAccessInvariantError('origin');
    }
    this.#state = Object.freeze({ ...state });
  }

  /**
   * A seller created by self-registration (3.3, SEL-03, AC 5): `pending` when the Market
   * requires approval, `approved` when it does not. No event: the seller is published only
   * when its owner verifies the email ({@link recordRegistered}; 8.2).
   */
  static forSelfRegistration(input: {
    readonly sellerId: Id<'Seller'>;
    readonly marketId: MarketId;
    readonly approvalRequired: boolean;
    readonly now: Temporal.Instant;
  }): SellerAccess {
    const { sellerId, marketId, approvalRequired, now } = input;
    return new SellerAccess(
      {
        sellerId,
        marketId,
        origin: 'self',
        state: approvalRequired ? 'pending' : 'approved',
        stateChangedAt: now,
        reapplyCount: 0,
        registeredAt: null,
        version: 1,
        createdAt: now,
      },
      null,
    );
  }

  /** A seller access read from the store. Checks the invariants again. */
  static restore(state: SellerAccessState): SellerAccess {
    return new SellerAccess(state, state.version);
  }

  get state(): SellerAccessState {
    return this.#state;
  }

  /** Events recorded since the aggregate was built or restored. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /** Whether `seller-registered` was recorded: the seller exists for other modules. */
  get isRegistered(): boolean {
    return this.#state.registeredAt !== null;
  }

  /** Whether an account of this seller may open a session (3.3): every state but `suspended`. */
  get allowsSignIn(): boolean {
    return this.#state.state !== 'suspended';
  }

  /** Whether the seller is `approved`: outside the allow-list of 5.2 nothing else passes. */
  get isApproved(): boolean {
    return this.#state.state === 'approved';
  }

  /**
   * The owner verified the email (8.2, M4): records `identity.seller-registered.v1` with the
   * current access state, as the version step that sets `registeredAt`. Once only; the answer
   * says whether this call recorded it.
   */
  recordRegistered(ownerAccountId: Id<'Account'>, now: Temporal.Instant): boolean {
    if (this.#state.registeredAt !== null) return false;
    const version = this.#state.version + 1;
    this.#state = Object.freeze({ ...this.#state, registeredAt: now, version });
    this.#events.push(
      SellerRegistered.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: version,
        occurredAt: now,
        payload: {
          sellerId: this.#state.sellerId,
          ownerAccountId,
          origin: this.#state.origin,
          accessState: this.#state.state,
        },
      }),
    );
    return true;
  }
}
