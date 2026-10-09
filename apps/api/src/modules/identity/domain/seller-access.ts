import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import {
  AccessDecision,
  parseAccessReason,
  type AccessDecisionKind,
  type AccessReasonInvalid,
} from './access-decision';
import {
  SELLER_ACCESS_STATES,
  SELLER_ORIGINS,
  SellerAccessApproved,
  SellerAccessReapplied,
  SellerAccessRejected,
  SellerAccessReinstated,
  SellerAccessSuspended,
  SellerRegistered,
} from './events';

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

/** A transition that 3.3 does not list from the current state (8.6 row 1). */
export type SellerAccessWrongState = { readonly code: 'seller-access.wrong-state' };
const WRONG_STATE: SellerAccessWrongState = Object.freeze({ code: 'seller-access.wrong-state' });

/** A rejected seller that used up its re-applications (3.3: the "final state"). */
export type SellerAccessReapplyLimit = { readonly code: 'seller-access.reapply-limit' };

/** Who decides, when, and under which id (identity design 3.3; data design 3.11). */
export interface DecisionInput {
  readonly decisionId: Id<'AccessDecision'>;
  /** The deciding account; null for the system actor (C4). */
  readonly decidedBy: Id<'Account'> | null;
  readonly now: Temporal.Instant;
}

/** Approve and reject also carry `sellers`' submission id, once `sellers` calls (8.4). */
export interface BasedDecisionInput extends DecisionInput {
  readonly basisId: Id | null;
}

/**
 * The `SellerAccess` aggregate (identity design 2.1 and 3.3; ADR-0022): one per seller id,
 * minted by `identity`; its state covers every account of the seller. Times come from the
 * caller's `Clock`; a change raises the version by one and records at most one event.
 *
 * - Creation: by self-registration (slice 5; published when the owner verifies the email) or by
 *   an admin's seller-owner invitation (slice 9; published at once, 8.2).
 * - Decisions (slice 9): `approve` and `reject` a `pending` seller, `suspend` an `approved` one,
 *   `reinstate` a `suspended` one. Each answers the {@link AccessDecision} to store; a rejection
 *   and a suspension need a non-empty reason (decision 9), checked here, so no entry point can
 *   reject or suspend without one. Every other transition is `seller-access.wrong-state`.
 * - `reapply` (slice 9, behind the seller-access contract): `rejected` → `pending` while the
 *   re-applications since the last approval are fewer than the Market's limit.
 */
export class SellerAccess {
  #state: SellerAccessState;
  #events: PendingEvent[] = [];

  private constructor(
    state: SellerAccessState,
    /** The version read from the store; null for a seller not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    SellerAccess.check(state);
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

  /**
   * A seller created by an admin with a seller-owner invitation (3.3, 3.4; SEL-06, AC 5, AC 31):
   * `pending` when the Market requires approval, `approved` when it does not, as a
   * self-registration. Registered at once (8.2: "at creation for an invitation"): the purge never
   * deletes it, and `identity.seller-registered.v1` is recorded now, with no owner yet.
   */
  static forInvitation(input: {
    readonly sellerId: Id<'Seller'>;
    readonly marketId: MarketId;
    readonly approvalRequired: boolean;
    readonly now: Temporal.Instant;
  }): SellerAccess {
    const { sellerId, marketId, approvalRequired, now } = input;
    const access = new SellerAccess(
      {
        sellerId,
        marketId,
        origin: 'invitation',
        state: approvalRequired ? 'pending' : 'approved',
        stateChangedAt: now,
        reapplyCount: 0,
        registeredAt: now,
        version: 1,
        createdAt: now,
      },
      null,
    );
    access.#events.push(
      SellerRegistered.record({
        aggregateId: sellerId,
        aggregateVersion: 1,
        occurredAt: now,
        payload: {
          sellerId,
          ownerAccountId: null,
          origin: 'invitation',
          accessState: access.#state.state,
        },
      }),
    );
    return access;
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

  /**
   * `pending` → `approved` (3.3; SEL-03, AC 4, AC 9). The re-application count starts again: the
   * limit counts re-applications "since the last approval". The guard on the owner (an account
   * with a verified email) needs other aggregates and belongs to the use case.
   */
  approve(input: BasedDecisionInput): Result<AccessDecision, SellerAccessWrongState> {
    if (this.#state.state !== 'pending') return err(WRONG_STATE);
    const decision = this.decision('approved', null, input.basisId, input);
    this.move('approved', input.now, 0);
    this.#events.push(
      SellerAccessApproved.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: this.#state.version,
        occurredAt: input.now,
        payload: {
          sellerId: this.#state.sellerId,
          decisionId: input.decisionId,
          basisId: input.basisId,
        },
      }),
    );
    return ok(decision);
  }

  /** `pending` → `rejected` with a non-empty reason (3.3; decision 9, AC 6). */
  reject(
    input: BasedDecisionInput & { readonly reason: unknown },
  ): Result<AccessDecision, SellerAccessWrongState | AccessReasonInvalid> {
    if (this.#state.state !== 'pending') return err(WRONG_STATE);
    const reason = parseAccessReason(input.reason);
    if (!reason.ok) return reason;
    const decision = this.decision('rejected', reason.value, input.basisId, input);
    this.move('rejected', input.now, this.#state.reapplyCount);
    this.#events.push(
      SellerAccessRejected.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: this.#state.version,
        occurredAt: input.now,
        payload: {
          sellerId: this.#state.sellerId,
          decisionId: input.decisionId,
          basisId: input.basisId,
        },
      }),
    );
    return ok(decision);
  }

  /** `approved` → `suspended` with a non-empty reason (3.3; SEL-07, decision 9, AC 14). */
  suspend(
    input: DecisionInput & { readonly reason: unknown },
  ): Result<AccessDecision, SellerAccessWrongState | AccessReasonInvalid> {
    if (this.#state.state !== 'approved') return err(WRONG_STATE);
    const reason = parseAccessReason(input.reason);
    if (!reason.ok) return reason;
    const decision = this.decision('suspended', reason.value, null, input);
    this.move('suspended', input.now, this.#state.reapplyCount);
    this.#events.push(
      SellerAccessSuspended.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: this.#state.version,
        occurredAt: input.now,
        payload: { sellerId: this.#state.sellerId, decisionId: input.decisionId },
      }),
    );
    return ok(decision);
  }

  /** `suspended` → `approved` (3.3; AC 14). No reason (data design 3.11). */
  reinstate(input: DecisionInput): Result<AccessDecision, SellerAccessWrongState> {
    if (this.#state.state !== 'suspended') return err(WRONG_STATE);
    const decision = this.decision('reinstated', null, null, input);
    this.move('approved', input.now, this.#state.reapplyCount);
    this.#events.push(
      SellerAccessReinstated.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: this.#state.version,
        occurredAt: input.now,
        payload: { sellerId: this.#state.sellerId, decisionId: input.decisionId },
      }),
    );
    return ok(decision);
  }

  /**
   * Whether a re-application is still possible under `limit` (3.3; 8.6 row 2: the status read
   * says so, and the panel shows "Changes needed" or "Not approved").
   */
  canReapply(limit: number): boolean {
    SellerAccess.checkLimit(limit);
    return this.#state.state === 'rejected' && this.#state.reapplyCount < limit;
  }

  /**
   * `rejected` → `pending` by the Seller Owner (3.3; AC 6): fewer than `limit` re-applications
   * since the last approval, else `seller-access.reapply-limit` and the seller stays rejected.
   * Records `identity.seller-access-reapplied.v1`; no decision is written (data design 3.11).
   */
  reapply(
    now: Temporal.Instant,
    limit: number,
  ): Result<void, SellerAccessWrongState | SellerAccessReapplyLimit> {
    SellerAccess.checkLimit(limit);
    if (this.#state.state !== 'rejected') return err(WRONG_STATE);
    if (this.#state.reapplyCount >= limit) return err({ code: 'seller-access.reapply-limit' });
    this.move('pending', now, this.#state.reapplyCount + 1);
    this.#events.push(
      SellerAccessReapplied.record({
        aggregateId: this.#state.sellerId,
        aggregateVersion: this.#state.version,
        occurredAt: now,
        payload: { sellerId: this.#state.sellerId },
      }),
    );
    return ok(undefined);
  }

  private decision(
    decision: AccessDecisionKind,
    reason: string | null,
    basisId: Id | null,
    input: DecisionInput,
  ): AccessDecision {
    return AccessDecision.decide({
      id: input.decisionId,
      marketId: this.#state.marketId,
      sellerId: this.#state.sellerId,
      decision,
      reason,
      basisId,
      decidedByAccountId: input.decidedBy,
      decidedAt: input.now,
    });
  }

  private move(state: SellerAccessStateCode, now: Temporal.Instant, reapplyCount: number): void {
    const next: SellerAccessState = {
      ...this.#state,
      state,
      stateChangedAt: now,
      reapplyCount,
      version: this.#state.version + 1,
    };
    SellerAccess.check(next);
    this.#state = Object.freeze(next);
  }

  private static checkLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('reapply: the limit is a positive whole number');
    }
  }

  private static check(state: SellerAccessState): void {
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
  }
}
