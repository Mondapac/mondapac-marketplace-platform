import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result } from '@mondapac/shared-kernel';

/**
 * How long a request stays open (catalog design 8.2: 72 hours, the design's proposal). One value
 * for every Market today; it becomes a Market setting when a Market needs another. The database
 * refuses more than 168 hours (data design 3.21).
 */
export const RELAXATION_REQUEST_LIFETIME = Temporal.Duration.from({ hours: 72 });

/**
 * What a request relaxes. Only `clear-material` has a use case today (attributes A2); `archive`
 * of a published definition and `remove-from-family` arrive with the use cases that archive a
 * published definition and edit a family's members.
 */
export type RelaxationKind = 'clear-material' | 'archive' | 'remove-from-family';

export type RelaxationStatus = 'open' | 'confirmed' | 'cancelled' | 'expired';

export type RelaxationCancelReason = 'requester' | 'definition-changed';

export interface AttributeRelaxationRequestState {
  readonly id: Id<'AttributeRelaxationRequest'>;
  readonly marketId: MarketId;
  readonly definitionId: Id<'AttributeDefinition'>;
  /** The definition's version the requester saw; a confirm refuses if it changed. */
  readonly definitionVersion: number;
  readonly kind: RelaxationKind;
  readonly familyId: Id<'AttributeFamily'> | null;
  readonly status: RelaxationStatus;
  readonly requestedByAccountId: Id<'Account'>;
  readonly requestedAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
  readonly confirmedByAccountId: Id<'Account'> | null;
  readonly closedAt: Temporal.Instant | null;
  readonly cancelReason: RelaxationCancelReason | null;
  readonly version: number;
}

export type RelaxationRefusal =
  /** The request is no longer open (confirmed, cancelled or expired before). */
  | { readonly code: 'relaxation.closed' }
  /** Its time ran out; nothing changes, the requester may ask again. */
  | { readonly code: 'relaxation.expired' }
  /** The requester cannot confirm their own request (two-person rule, Hassan 2). */
  | { readonly code: 'relaxation.same-admin' }
  /** Only the requester cancels their request; another admin lets it expire or confirms it. */
  | { readonly code: 'relaxation.not-requester' };

/**
 * A two-admin request to relax a `material` attribute (catalog design 8.2; data design 3.21). One
 * admin asks; a different admin confirms before it expires. Its status moves once, out of `open`:
 * to `confirmed` (by another admin, in time), `cancelled` (by the requester, or because the
 * definition changed meanwhile) or `expired`. Each move raises `version` by one, and the store
 * writes it only from the version read, so of two racing moves exactly one wins.
 */
export class AttributeRelaxationRequest {
  readonly #state: AttributeRelaxationRequestState;

  private constructor(state: AttributeRelaxationRequestState) {
    this.#state = state;
  }

  get state(): AttributeRelaxationRequestState {
    return this.#state;
  }

  /** A new open request, expiring after {@link RELAXATION_REQUEST_LIFETIME}. */
  static open(input: {
    readonly id: Id<'AttributeRelaxationRequest'>;
    readonly marketId: MarketId;
    readonly definitionId: Id<'AttributeDefinition'>;
    readonly definitionVersion: number;
    readonly kind: RelaxationKind;
    readonly familyId?: Id<'AttributeFamily'> | null;
    readonly requestedByAccountId: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): AttributeRelaxationRequest {
    const familyId = input.familyId ?? null;
    if ((input.kind === 'remove-from-family') !== (familyId !== null)) {
      throw new Error(
        'AttributeRelaxationRequest: a family is named exactly for remove-from-family',
      );
    }
    return new AttributeRelaxationRequest({
      id: input.id,
      marketId: input.marketId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      kind: input.kind,
      familyId,
      status: 'open',
      requestedByAccountId: input.requestedByAccountId,
      requestedAt: input.now,
      expiresAt: input.now.add(RELAXATION_REQUEST_LIFETIME),
      confirmedByAccountId: null,
      closedAt: null,
      cancelReason: null,
      version: 1,
    });
  }

  static rehydrate(state: AttributeRelaxationRequestState): AttributeRelaxationRequest {
    return new AttributeRelaxationRequest(state);
  }

  /** Whether the request is open and its time has run out at `now`. */
  isExpiredAt(now: Temporal.Instant): boolean {
    return (
      this.#state.status === 'open' && Temporal.Instant.compare(now, this.#state.expiresAt) >= 0
    );
  }

  /**
   * Confirmed by a second admin. Refused when it is not open, when its time ran out (whatever the
   * expiry job has done: the clock decides), and when the confirmer is the requester.
   */
  confirm(
    by: Id<'Account'>,
    now: Temporal.Instant,
  ): Result<AttributeRelaxationRequest, RelaxationRefusal> {
    const current = this.#state;
    if (current.status !== 'open') return err({ code: 'relaxation.closed' });
    if (this.isExpiredAt(now)) return err({ code: 'relaxation.expired' });
    if (by === current.requestedByAccountId) return err({ code: 'relaxation.same-admin' });
    return ok(this.#close({ status: 'confirmed', confirmedByAccountId: by, closedAt: now }));
  }

  /** Cancelled by its requester while open. */
  cancel(
    by: Id<'Account'>,
    now: Temporal.Instant,
  ): Result<AttributeRelaxationRequest, RelaxationRefusal> {
    const current = this.#state;
    if (current.status !== 'open') return err({ code: 'relaxation.closed' });
    if (by !== current.requestedByAccountId) return err({ code: 'relaxation.not-requester' });
    return ok(this.#close({ status: 'cancelled', cancelReason: 'requester', closedAt: now }));
  }

  /**
   * Cancelled because the definition was revised (or archived) while it was open (Q-K14): the
   * request named a version that no longer exists, so it can never be confirmed.
   */
  cancelForChange(now: Temporal.Instant): Result<AttributeRelaxationRequest, RelaxationRefusal> {
    if (this.#state.status !== 'open') return err({ code: 'relaxation.closed' });
    return ok(
      this.#close({ status: 'cancelled', cancelReason: 'definition-changed', closedAt: now }),
    );
  }

  /** Expired: open and past its time. A request still in time is not expired. */
  expire(now: Temporal.Instant): Result<AttributeRelaxationRequest, RelaxationRefusal> {
    if (this.#state.status !== 'open') return err({ code: 'relaxation.closed' });
    if (!this.isExpiredAt(now)) return err({ code: 'relaxation.closed' });
    return ok(this.#close({ status: 'expired', closedAt: now }));
  }

  #close(change: {
    readonly status: Exclude<RelaxationStatus, 'open'>;
    readonly closedAt: Temporal.Instant;
    readonly confirmedByAccountId?: Id<'Account'>;
    readonly cancelReason?: RelaxationCancelReason;
  }): AttributeRelaxationRequest {
    return new AttributeRelaxationRequest({
      ...this.#state,
      status: change.status,
      closedAt: change.closedAt,
      confirmedByAccountId: change.confirmedByAccountId ?? null,
      cancelReason: change.cancelReason ?? null,
      version: this.#state.version + 1,
    });
  }
}
