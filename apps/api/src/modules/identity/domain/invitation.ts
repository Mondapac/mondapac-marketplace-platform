import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result } from '@mondapac/shared-kernel';
import { parseDisplayName } from './display-name';
import type { EmailAddress } from './email-address';
import { HANDOVER_MAX_FAILED_ATTEMPTS } from './handover-code';
import {
  INVITATION_KINDS,
  InvitationAccepted,
  InvitationIssued,
  InvitationRevoked,
} from './events';

/**
 * The kinds (identity design 3.4): admin (slice 7), seller-owner (9), staff (11); agent
 * (ADR-0045), which also needs a handover code.
 */
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
  /**
   * May dangle by design (R12): acceptance re-checks that the role exists. Null for an agent
   * invitation: an agent holds no role (ADR-0045 decision 6).
   */
  readonly roleId: Id<'Role'> | null;
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
  /**
   * Agent kind only (ADR-0045 decision 2): the HMAC of the handover code, bound to this
   * invitation; null once decided. The code itself is never held.
   */
  readonly handoverCodeHmac: Uint8Array | null;
  /** Agent kind only: wrong codes presented. The code is void from {@link HANDOVER_MAX_FAILED_ATTEMPTS}. */
  readonly handoverFailedAttempts: number | null;
  /** Agent kind only: the id the agent account will have, returned at issue. */
  readonly agentAccountId: Id<'Account'> | null;
}

/**
 * The state {@link Invitation.restore} takes: the agent columns may be left out and are then null,
 * so a store or a fixture of the other kinds names none of them.
 */
export type InvitationRestoreState = Omit<
  InvitationState,
  'handoverCodeHmac' | 'handoverFailedAttempts' | 'agentAccountId'
> &
  Partial<Pick<InvitationState, 'handoverCodeHmac' | 'handoverFailedAttempts' | 'agentAccountId'>>;

/**
 * Where an invitation stands at `now` (3.4): its stored state, or `expired` for a pending one at
 * or past the expiry of its last mail. The one rule of `Invitation.statusAt` and of a read that
 * holds only these fields, never the token hash (the admin team list, slice 8c).
 */
export function invitationStatusAt(
  invitation: Pick<InvitationState, 'state' | 'expiresAt'>,
  now: Temporal.Instant,
): InvitationStatus {
  const { state, expiresAt } = invitation;
  if (state !== 'pending') return state;
  return expiresAt !== null && Temporal.Instant.compare(now, expiresAt) >= 0
    ? 'expired'
    : 'pending';
}

/**
 * Whether a re-send is accepted at `now` (Mohammad C2): pending, and `now` before `createdAt`
 * plus the kind's lifetime. The one rule of `Invitation.reissuableAt` and `reissue`, and of the
 * admin team list's re-send hint (slice 8c).
 */
export function invitationReissuableAt(
  invitation: Pick<InvitationState, 'state' | 'createdAt'>,
  now: Temporal.Instant,
  lifetimeMinutes: number,
): boolean {
  if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1) {
    throw new RangeError('reissue: a positive whole lifetime in minutes is required');
  }
  if (invitation.state !== 'pending') return false;
  const cutoff = invitation.createdAt.add({ minutes: lifetimeMinutes });
  return Temporal.Instant.compare(now, cutoff) < 0;
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
        handoverCodeHmac: null,
        handoverFailedAttempts: null,
        agentAccountId: null,
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

  /**
   * An agent invitation (ADR-0045 decision 2): `pending` without a token, naming the account it
   * will create (`agentAccountId`, returned to the issuing admin) and holding only the HMAC of the
   * handover code. The inviter is required: issuing and accepting are audited with its id. No role
   * and no seller.
   */
  static issueAgent(input: {
    readonly id: Id<'Invitation'>;
    readonly marketId: MarketId;
    readonly email: EmailAddress;
    readonly displayName: string;
    readonly agentAccountId: Id<'Account'>;
    readonly handoverCodeHmac: Uint8Array;
    readonly invitedByAccountId: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): Invitation {
    const invitation = new Invitation(
      {
        id: input.id,
        marketId: input.marketId,
        kind: 'agent',
        email: input.email,
        displayName: input.displayName,
        roleId: null,
        sellerId: null,
        invitedByAccountId: input.invitedByAccountId,
        tokenHash: null,
        expiresAt: null,
        state: 'pending',
        decidedAt: null,
        acceptedAccountId: null,
        createdAt: input.now,
        version: 1,
        handoverCodeHmac: Uint8Array.from(input.handoverCodeHmac),
        handoverFailedAttempts: 0,
        agentAccountId: input.agentAccountId,
      },
      null,
    );
    invitation.#events.push(
      InvitationIssued.record({
        aggregateId: input.id,
        aggregateVersion: 1,
        occurredAt: input.now,
        payload: { invitationId: input.id, kind: 'agent', sellerId: null },
      }),
    );
    return invitation;
  }

  static restore(state: InvitationRestoreState): Invitation {
    const full: InvitationState = {
      ...state,
      handoverCodeHmac: state.handoverCodeHmac ?? null,
      handoverFailedAttempts: state.handoverFailedAttempts ?? null,
      agentAccountId: state.agentAccountId ?? null,
    };
    return new Invitation(full, full.version);
  }

  /**
   * The role of an invitation of a kind that has one (admin, seller-owner, staff). An agent
   * invitation has none (ADR-0045 decision 6): asking is a programmer error.
   */
  get roleId(): Id<'Role'> {
    const { roleId } = this.#state;
    if (roleId === null) throw new InvitationInvariantError('an agent invitation has no role');
    return roleId;
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
    return invitationStatusAt(this.#state, now);
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

  /**
   * Whether the handover code of an agent invitation can still be used: pending, with its HMAC
   * held and fewer than {@link HANDOVER_MAX_FAILED_ATTEMPTS} failures. A voided code is never
   * live again: the admin revokes and issues a new invitation.
   */
  get handoverCodeLive(): boolean {
    const { state, handoverCodeHmac, handoverFailedAttempts } = this.#state;
    return (
      state === 'pending' &&
      handoverCodeHmac !== null &&
      handoverFailedAttempts !== null &&
      handoverFailedAttempts < HANDOVER_MAX_FAILED_ATTEMPTS
    );
  }

  /**
   * One presentation of a handover code, `matched` by the caller against the stored HMAC. A
   * wrong code is counted (the version rises, so the caller saves it in a unit that commits);
   * the fifth voids the code. A correct one changes nothing. An invitation that is not usable at
   * `now`, or whose code is void, answers the same refusal and counts nothing.
   */
  presentHandoverCode(matched: boolean, now: Temporal.Instant): Result<void, InvitationRejected> {
    if (!this.usableAt(now) || !this.handoverCodeLive) return err(REJECTED);
    if (matched) return ok(undefined);
    this.change({ handoverFailedAttempts: (this.#state.handoverFailedAttempts ?? 0) + 1 });
    return err(REJECTED);
  }

  /**
   * `pending` → `accepted` for an agent, in one step (ADR-0045 decision 2): only a usable
   * invitation with a live code that `handoverCodeMatched`. The generic {@link accept} refuses an
   * agent invitation, so no caller can skip the code. The address, the name and the code's HMAC
   * are cleared with the decision.
   */
  acceptAgent(
    accountId: Id<'Account'>,
    handoverCodeMatched: boolean,
    now: Temporal.Instant,
  ): Result<void, InvitationRejected> {
    if (this.#state.kind !== 'agent') return err(REJECTED);
    if (!handoverCodeMatched || !this.usableAt(now) || !this.handoverCodeLive) return err(REJECTED);
    return this.decideAccepted(accountId, now);
  }

  /** `pending` → `accepted` by the account created for it (3.4). Not for an agent invitation. */
  accept(accountId: Id<'Account'>, now: Temporal.Instant): Result<void, InvitationRejected> {
    if (this.#state.kind === 'agent') return err(REJECTED);
    if (!this.usableAt(now)) return err(REJECTED);
    return this.decideAccepted(accountId, now);
  }

  private decideAccepted(
    accountId: Id<'Account'>,
    now: Temporal.Instant,
  ): Result<void, InvitationRejected> {
    this.change({
      state: 'accepted',
      decidedAt: now,
      acceptedAccountId: accountId,
      email: null,
      displayName: null,
      handoverCodeHmac: null,
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
   * Whether {@link reissue} would accept at `now`: pending, and `now` before `createdAt` plus the
   * kind's lifetime (Mohammad C2). Changes nothing; the admin team list's hint reads it (slice 8c).
   */
  reissuableAt(now: Temporal.Instant, lifetimeMinutes: number): boolean {
    return invitationReissuableAt(this.#state, now, lifetimeMinutes);
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
    // An agent invitation is never re-sent in place: a lost handover code means revoke and issue
    // again, which mints a new code (ADR-0045 decision 2).
    if (this.#state.kind === 'agent') return err(REJECTED);
    if (!this.reissuableAt(now, lifetimeMinutes)) return err(REJECTED);
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
    this.change({
      state: 'revoked',
      decidedAt: now,
      email: null,
      displayName: null,
      handoverCodeHmac: null,
    });
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
    const agent = state.kind === 'agent';
    if ((state.kind === 'admin' || agent) !== (state.sellerId === null)) {
      throw new InvitationInvariantError('a seller on seller-owner and staff invitations only');
    }
    if (agent !== (state.roleId === null)) {
      throw new InvitationInvariantError('a role on every invitation but the agent one');
    }
    const named = (state.kind === 'seller-owner' || agent) && pending;
    if (state.displayName !== null && !named) {
      throw new InvitationInvariantError(
        'a name only on a pending seller-owner or agent invitation',
      );
    }
    if (named && state.displayName === null) {
      throw new InvitationInvariantError('a seller-owner or agent invitation names its invitee');
    }
    if (
      agent !== (state.agentAccountId !== null) ||
      agent !== (state.handoverFailedAttempts !== null) ||
      (state.handoverCodeHmac !== null && !(agent && pending))
    ) {
      throw new InvitationInvariantError('the handover code columns belong to agent invitations');
    }
    if (agent && pending && state.handoverCodeHmac === null) {
      throw new InvitationInvariantError('a pending agent invitation holds its handover code');
    }
    if (agent && state.invitedByAccountId === null) {
      throw new InvitationInvariantError('an agent invitation records its inviter');
    }
    if (
      state.handoverCodeHmac !== null &&
      (state.handoverCodeHmac.length !== 32 ||
        (state.handoverFailedAttempts ?? 0) > HANDOVER_MAX_FAILED_ATTEMPTS)
    ) {
      throw new InvitationInvariantError('the handover code is a 32-byte HMAC, at most 5 failures');
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
      handoverCodeHmac:
        state.handoverCodeHmac === null ? null : Uint8Array.from(state.handoverCodeHmac),
    });
  }
}
