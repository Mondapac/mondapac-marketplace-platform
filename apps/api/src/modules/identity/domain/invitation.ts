import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result } from '@mondapac/shared-kernel';
import { parseDisplayName } from './display-name';
import type { EmailAddress } from './email-address';
import {
  INVITATION_KINDS,
  InvitationAccepted,
  InvitationIssued,
  InvitationRevoked,
} from './events';

/** The three kinds (identity design 3.4): admin (slice 7), seller-owner (9), staff (11). */
export { INVITATION_KINDS };
export type InvitationKind = (typeof INVITATION_KINDS)[number];

/** Stored states (data design 3.10); `expired` is never stored, it is read from the clock. */
export const INVITATION_STATES = ['pending', 'accepted', 'revoked'] as const;
export type InvitationStateCode = (typeof INVITATION_STATES)[number];

/** Where an invitation stands at an instant (identity design 3.4). */
export type InvitationStatus = InvitationStateCode | 'expired';

/** The state of an {@link Invitation} (identity design 2.1, 3.4; data design 3.10). */
export interface InvitationState {
  readonly id: Id<'Invitation'>;
  readonly marketId: MarketId;
  readonly kind: InvitationKind;
  /** Personal; only while pending (data design 4: never after a decision). */
  readonly email: EmailAddress | null;
  /** Personal; only on a pending seller-owner invitation (D 3.4, `ux.md` D6). */
  readonly displayName: string | null;
  /** May dangle by design (R12): acceptance re-checks that the role exists. */
  readonly roleId: Id<'Role'>;
  /** The seller of a seller-owner or staff invitation; null for admin. */
  readonly sellerId: Id<'Seller'> | null;
  /** Null for the first-admin routine (D 7.4, HF5 (b)). */
  readonly invitedByAccountId: Id<'Account'> | null;
  /** SHA-256 of the token sent; null until dispatch. The token itself is never held. */
  readonly tokenHash: Uint8Array | null;
  /** Set with the hash at dispatch; a re-send replaces both. */
  readonly expiresAt: Temporal.Instant | null;
  readonly state: InvitationStateCode;
  readonly decidedAt: Temporal.Instant | null;
  readonly acceptedAccountId: Id<'Account'> | null;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
}

/** An invitation that cannot be used now: one answer for every cause (8.6 row 1). */
export type InvitationRejected = { readonly code: 'invitation.rejected' };
const REJECTED: InvitationRejected = Object.freeze({ code: 'invitation.rejected' });

/** An invitation that would break an invariant of 3.10: a programmer error, never a user's. */
export class InvitationInvariantError extends Error {
  override readonly name = 'InvitationInvariantError';
  constructor(detail: string) {
    super(`identity.invitations: ${detail}`);
  }
}

/**
 * The `Invitation` aggregate (identity design 2.1, 3.4; data design 3.10; R12).
 *
 * - `issue`: `pending` without a token. The token is minted at dispatch by the mail handler
 *   (6.6), which stores its hash with the expiry (`dispatch`); a re-send dispatches again, so
 *   the earlier token stops working at once.
 * - `accept`: only a dispatched, unexpired, pending invitation, once; the address and the name
 *   are cleared with the decision, so no personal data outlives it (data design 4). The guards
 *   that need other aggregates (the role still exists, the inviter may still grant it, HF5 (b))
 *   belong to the accepting use case.
 * - `revoke`: the inviter's side withdraws a pending invitation.
 *
 * The email, role, seller and kind never change: a different one is a new invitation (3.4).
 * Times come from the caller's `Clock`; every change raises the version by one (C5). Events
 * (8.2, slice 7b): `identity.invitation-issued.v1` at issue (the mail handler dispatches on it)
 * and `identity.invitation-accepted.v1` at acceptance; a dispatch records none.
 *
 * - `replaceableAt`: whether an issue for the same address and scope may replace this pending
 *   invitation (M7; item G, Ali 2026-10-08): it is past its expiry, or it was never dispatched
 *   and is older than its kind's lifetime, so a lost mail never blocks a new invitation.
 */
export class Invitation {
  #state: InvitationState;
  #events: PendingEvent[] = [];

  private constructor(
    state: InvitationState,
    /** The version read from the store; null for an invitation not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    Invitation.check(state);
    this.#state = Invitation.freeze(state);
  }

  static issue(input: {
    readonly id: Id<'Invitation'>;
    readonly marketId: MarketId;
    readonly kind: InvitationKind;
    readonly email: EmailAddress;
    /** Required for, and only for, a seller-owner invitation. */
    readonly displayName?: string | null;
    readonly roleId: Id<'Role'>;
    /** Required for seller-owner and staff; null for admin. */
    readonly sellerId: Id<'Seller'> | null;
    readonly invitedByAccountId: Id<'Account'> | null;
    readonly now: Temporal.Instant;
  }): Invitation {
    const invitation = new Invitation(
      {
        id: input.id,
        marketId: input.marketId,
        kind: input.kind,
        email: input.email,
        displayName: input.displayName ?? null,
        roleId: input.roleId,
        sellerId: input.sellerId,
        invitedByAccountId: input.invitedByAccountId,
        tokenHash: null,
        expiresAt: null,
        state: 'pending',
        decidedAt: null,
        acceptedAccountId: null,
        createdAt: input.now,
        version: 1,
      },
      null,
    );
    const { id, kind, sellerId } = invitation.#state;
    invitation.#events.push(
      InvitationIssued.record({
        aggregateId: id,
        aggregateVersion: 1,
        occurredAt: input.now,
        payload: { invitationId: id, kind, sellerId },
      }),
    );
    return invitation;
  }

  static restore(state: InvitationState): Invitation {
    return new Invitation(state, state.version);
  }

  get state(): InvitationState {
    return this.#state;
  }

  /** Events recorded since the invitation was built or restored. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /**
   * Whether an issue may replace this invitation at `now` (M7; item G): it is pending and either
   * past its expiry, or never dispatched and created at least `lifetimeMinutes` (its kind's
   * lifetime) ago. A decided invitation is never in the way: its address is gone.
   */
  replaceableAt(now: Temporal.Instant, lifetimeMinutes: number): boolean {
    if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
      throw new RangeError('replaceableAt: a positive whole lifetime in minutes is required');
    }
    if (this.#state.state !== 'pending') return false;
    if (this.#state.tokenHash !== null) return this.statusAt(now) === 'expired';
    const cutoff = this.#state.createdAt.add({ minutes: lifetimeMinutes });
    return Temporal.Instant.compare(now, cutoff) >= 0;
  }

  statusAt(now: Temporal.Instant): InvitationStatus {
    const { state, expiresAt } = this.#state;
    if (state !== 'pending') return state;
    return expiresAt !== null && Temporal.Instant.compare(now, expiresAt) >= 0
      ? 'expired'
      : 'pending';
  }

  /** Whether the invitation may be accepted at `now`: dispatched, pending and unexpired. */
  usableAt(now: Temporal.Instant): boolean {
    return this.#state.tokenHash !== null && this.statusAt(now) === 'pending';
  }

  /**
   * The mail with a new token was sent (6.6): its hash and the expiry are stored, replacing an
   * earlier token (a re-send, 3.4 `pending` → `pending`). Only a pending invitation.
   */
  dispatch(
    tokenHash: Uint8Array,
    now: Temporal.Instant,
    lifetimeMinutes: number,
  ): Result<void, InvitationRejected> {
    if (this.#state.state !== 'pending') return err(REJECTED);
    if (tokenHash.length !== 32 || !Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
      throw new RangeError('dispatch: a 32-byte hash and a positive whole lifetime are required');
    }
    this.change({
      tokenHash: Uint8Array.from(tokenHash),
      expiresAt: now.add({ minutes: lifetimeMinutes }),
    });
    return ok(undefined);
  }

  /** `pending` → `accepted` by the account created for it (3.4). */
  accept(accountId: Id<'Account'>, now: Temporal.Instant): Result<void, InvitationRejected> {
    if (!this.usableAt(now)) return err(REJECTED);
    this.change({
      state: 'accepted',
      decidedAt: now,
      acceptedAccountId: accountId,
      email: null,
      displayName: null,
    });
    const { id, kind, sellerId, version } = this.#state;
    this.#events.push(
      InvitationAccepted.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: {
          invitationId: id,
          kind,
          sellerId,
          accountId,
        },
      }),
    );
    return ok(undefined);
  }

  /**
   * `pending` → `pending`: a re-send by the inviter's side (3.4, flows E2 and F2; slice 8b). The
   * stored token is voided at once (its hash and expiry cleared), so the earlier link stops
   * working before the new mail goes; the version rises and `identity.invitation-issued.v1` is
   * recorded again, which the mail handler dispatches with a new token and a new expiry.
   *
   * Refused once `now` is at or past `createdAt` plus the kind's lifetime (Mohammad C2 on PR
   * #187): the cleared token would make it a never-dispatched invitation that item G already
   * counts as stale, and `expired` → `pending` is not a transition of 3.4. The admin invites
   * again instead, which replaces it.
   */
  reissue(now: Temporal.Instant, lifetimeMinutes: number): Result<void, InvitationRejected> {
    if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
      throw new RangeError('reissue: a positive whole lifetime in minutes is required');
    }
    if (this.#state.state !== 'pending') return err(REJECTED);
    const cutoff = this.#state.createdAt.add({ minutes: lifetimeMinutes });
    if (Temporal.Instant.compare(now, cutoff) >= 0) return err(REJECTED);
    this.change({ tokenHash: null, expiresAt: null });
    const { id, kind, sellerId, version } = this.#state;
    this.#events.push(
      InvitationIssued.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { invitationId: id, kind, sellerId },
      }),
    );
    return ok(undefined);
  }

  /**
   * `pending` → `revoked` (3.4); an expired pending invitation may be revoked too. Records
   * `identity.invitation-revoked.v1` (8.2; slice 8b).
   */
  revoke(now: Temporal.Instant): Result<void, InvitationRejected> {
    if (this.#state.state !== 'pending') return err(REJECTED);
    this.change({ state: 'revoked', decidedAt: now, email: null, displayName: null });
    const { id, kind, sellerId, version } = this.#state;
    this.#events.push(
      InvitationRevoked.record({
        aggregateId: id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { invitationId: id, kind, sellerId },
      }),
    );
    return ok(undefined);
  }

  private change(fields: Partial<InvitationState>): void {
    const next = { ...this.#state, ...fields, version: this.#state.version + 1 };
    Invitation.check(next);
    this.#state = Invitation.freeze(next);
  }

  /** The CHECKs of data design 3.10, in memory: a broken invitation is never built. */
  private static check(state: InvitationState): void {
    const pending = state.state === 'pending';
    if (!(INVITATION_KINDS as readonly string[]).includes(state.kind)) {
      throw new InvitationInvariantError('unknown kind');
    }
    if (!(INVITATION_STATES as readonly string[]).includes(state.state)) {
      throw new InvitationInvariantError('unknown state');
    }
    if (pending !== (state.email !== null)) {
      throw new InvitationInvariantError('the address is held while pending, and only then');
    }
    if ((state.kind === 'admin') !== (state.sellerId === null)) {
      throw new InvitationInvariantError('a seller on seller-owner and staff invitations only');
    }
    const ownerName = state.kind === 'seller-owner' && pending;
    if (state.displayName !== null && !ownerName) {
      throw new InvitationInvariantError('a name only on a pending seller-owner invitation');
    }
    if (ownerName && state.displayName === null) {
      throw new InvitationInvariantError('a seller-owner invitation names its invitee');
    }
    // The name rules of an account's display name (HF13; review nit): parsed by the caller,
    // re-checked here so a malformed name is never stored.
    if (state.displayName !== null) {
      const parsed = parseDisplayName(state.displayName);
      if (!parsed.ok || parsed.value !== state.displayName) {
        throw new InvitationInvariantError('the name follows the display-name rules');
      }
    }
    if ((state.tokenHash === null) !== (state.expiresAt === null)) {
      throw new InvitationInvariantError('the token hash and the expiry are set together');
    }
    if (pending !== (state.decidedAt === null)) {
      throw new InvitationInvariantError('a decision instant once decided, and only then');
    }
    if ((state.state === 'accepted') !== (state.acceptedAccountId !== null)) {
      throw new InvitationInvariantError('the accepting account once accepted, and only then');
    }
    if (state.version < 1 || !Number.isInteger(state.version)) {
      throw new InvitationInvariantError('the version is a whole number from 1');
    }
  }

  private static freeze(state: InvitationState): InvitationState {
    return Object.freeze({
      ...state,
      tokenHash: state.tokenHash === null ? null : Uint8Array.from(state.tokenHash),
    });
  }
}
