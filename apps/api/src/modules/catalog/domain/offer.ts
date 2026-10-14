import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import {
  OfferChangesRequested,
  OfferCreated,
  OfferDeleted,
  OfferPublished,
  type OfferChangeReason,
} from './events';

export const OFFER_STATUSES = [
  'draft',
  'pending-first-publish',
  'changes-needed',
  'published',
  'deleted',
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

export const OFFER_HANDLINGS = ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'] as const;
export type OfferHandling = (typeof OFFER_HANDLINGS)[number];

/**
 * The stored causes that take a published Offer off sale (catalog design 2.3 M-5, 4.4). A cause
 * from another module (may-sell, price, stock) is never stored here.
 */
export const OFF_SALE_CAUSES = [
  'type-not-allowed',
  'product-retired',
  'product-not-listed',
  'tag-suspended',
  'description-claim-text',
] as const;
export type OffSaleCause = (typeof OFF_SALE_CAUSES)[number];

/** Why a command was refused: a stable code, never data. */
export type OfferRefusal =
  | { readonly code: 'offer.sku-invalid' }
  | { readonly code: 'offer.condition-invalid' }
  | { readonly code: 'offer.description-invalid' }
  | { readonly code: 'offer.not-editable' };

/** Why `setHandling` was refused. */
type OfferHandlingRefusal =
  { readonly code: 'offer.handling-invalid' } | { readonly code: 'offer.not-editable' };

/** Why a status transition (submit, approve, request changes, delete) was refused. */
export type OfferTransitionRefusal =
  | { readonly code: 'offer.not-submittable' }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'offer.not-pending-review' }
  | { readonly code: 'offer.already-deleted' };

/** The history row a change leaves (data design 3.14); field ids only, never values. */
export interface OfferPendingHistory {
  readonly changeKind:
    'edited' | 'submitted' | 'published' | 'publication-approved' | 'changes-requested' | 'deleted';
  readonly changedFields: readonly string[];
  readonly occurredAt: Temporal.Instant;
}

export interface OfferState {
  readonly id: Id<'Offer'>;
  readonly marketId: MarketId;
  /** The seller who owns the Offer; never changes (pricing's copy relies on it, PRC 2.3). */
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  /** One per Offer, unique per seller among non-deleted Offers (CAT-10). */
  readonly sellerSku: string;
  readonly conditionCode: string;
  /** Locale to text; claim-checked by the use case (catalog design 6). */
  readonly description: Readonly<Record<string, string>>;
  readonly handling: OfferHandling | null;
  readonly attestationRecordedAt: Temporal.Instant | null;
  readonly attestationAccountId: Id<'Account'> | null;
  readonly status: OfferStatus;
  readonly offSaleCauses: readonly OffSaleCause[];
  /** Stored: `published` and no cause (data design 3.13 `offers_listed_check`). */
  readonly listed: boolean;
  readonly submittedAt: Temporal.Instant | null;
  readonly firstPublishedAt: Temporal.Instant | null;
  readonly deletedAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

/** Listed means published with no off-sale cause; the product's own state is held by the transitions. */
export function isListed(state: Pick<OfferState, 'status' | 'offSaleCauses'>): boolean {
  return state.status === 'published' && state.offSaleCauses.length === 0;
}

/** Printable ASCII without whitespace, 1 to 64 characters (data design 3.13 `seller_sku`). */
const SKU_PATTERN = /^[!-~]{1,64}$/;
/** A vocabulary code (data design CA4). */
const CODE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** The most characters one locale of an Offer description may hold (Hassan L-2). */
export const MAX_DESCRIPTION_CHARS = 5000;
/** The most locales one Offer description may hold. */
export const MAX_DESCRIPTION_LOCALES = 20;

function sortedEntries(value: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function validDescription(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_DESCRIPTION_LOCALES &&
    entries.every(
      ([locale, text]) =>
        locale.length > 0 &&
        locale.length <= 35 &&
        typeof text === 'string' &&
        text.length <= MAX_DESCRIPTION_CHARS,
    )
  );
}

/**
 * An Offer: one seller's listing of one product (catalog design 2.1, 4.4). This part holds
 * creation and the stored shape; the transitions arrive with their use cases. A new Offer is a
 * `draft` with no handling, attestation or cause, so it is never listed.
 *
 * Version rule as `Product` (Q-K3): a change raises the version by one, plus one more per event
 * beyond the first, and the n-th new event carries the n-th version.
 */
export class Offer {
  #state: OfferState;
  readonly #events: PendingEvent[] = [];
  readonly #persistedVersion: number | null;
  #pendingHistory: OfferPendingHistory | null = null;

  private constructor(state: OfferState, persistedVersion: number | null) {
    this.#state = Object.freeze(state);
    this.#persistedVersion = persistedVersion;
  }

  /**
   * A new draft Offer. Handling, attestation and tags are never inputs here (brief s5, B1):
   * they are written only by their own commands of a seller actor.
   */
  static create(input: {
    readonly id: Id<'Offer'>;
    readonly marketId: MarketId;
    readonly sellerId: Id<'Seller'>;
    readonly productId: Id<'Product'>;
    readonly sellerSku: string;
    readonly conditionCode: string;
    readonly description: Readonly<Record<string, string>>;
    readonly now: Temporal.Instant;
  }): Result<Offer, OfferRefusal> {
    if (typeof input.sellerSku !== 'string' || !SKU_PATTERN.test(input.sellerSku)) {
      return err({ code: 'offer.sku-invalid' });
    }
    if (typeof input.conditionCode !== 'string' || !CODE_PATTERN.test(input.conditionCode)) {
      return err({ code: 'offer.condition-invalid' });
    }
    if (!validDescription(input.description)) return err({ code: 'offer.description-invalid' });
    const offer = new Offer(
      {
        id: input.id,
        marketId: input.marketId,
        sellerId: input.sellerId,
        productId: input.productId,
        sellerSku: input.sellerSku,
        conditionCode: input.conditionCode,
        description: Object.freeze({ ...input.description }),
        handling: null,
        attestationRecordedAt: null,
        attestationAccountId: null,
        status: 'draft',
        offSaleCauses: [],
        listed: false,
        submittedAt: null,
        firstPublishedAt: null,
        deletedAt: null,
        version: 1,
        createdAt: input.now,
      },
      null,
    );
    offer.#events.push(
      OfferCreated.record({
        aggregateId: input.id,
        aggregateVersion: 1,
        occurredAt: input.now,
        payload: { offerId: input.id, productId: input.productId, sellerId: input.sellerId },
      }),
    );
    return ok(offer);
  }

  /**
   * A seller's edit of the content fields (SKU, condition, description): a closed set with no
   * handling, attestation or tag (B1). Only an Offer that is not yet published may be edited
   * here: a `pending-first-publish` or `changes-needed` Offer returns to `draft` and leaves the
   * queue (design 4.4). A published Offer is refused until the tag re-asking of slice 8 exists
   * (fail closed: an edit must never skip `evaluateClaims`). Answers the field ids that changed;
   * an edit that changes nothing stores nothing and leaves the version alone.
   */
  edit(input: {
    readonly sellerSku: string;
    readonly conditionCode: string;
    readonly description: Readonly<Record<string, string>>;
    readonly now: Temporal.Instant;
  }): Result<readonly string[], OfferRefusal> {
    const state = this.#state;
    if (
      state.status !== 'draft' &&
      state.status !== 'changes-needed' &&
      state.status !== 'pending-first-publish'
    ) {
      return err({ code: 'offer.not-editable' });
    }
    if (typeof input.sellerSku !== 'string' || !SKU_PATTERN.test(input.sellerSku)) {
      return err({ code: 'offer.sku-invalid' });
    }
    if (typeof input.conditionCode !== 'string' || !CODE_PATTERN.test(input.conditionCode)) {
      return err({ code: 'offer.condition-invalid' });
    }
    if (!validDescription(input.description)) return err({ code: 'offer.description-invalid' });
    const changed: string[] = [];
    if (input.sellerSku !== state.sellerSku) changed.push('sellerSku');
    if (input.conditionCode !== state.conditionCode) changed.push('conditionCode');
    if (
      JSON.stringify(sortedEntries(input.description)) !==
      JSON.stringify(sortedEntries(state.description))
    ) {
      changed.push('description');
    }
    if (changed.length === 0 && state.status === 'draft') return ok([]);
    if (this.#pendingHistory !== null) throw new Error('edit: the Offer already has a change');
    this.#state = Object.freeze({
      ...state,
      sellerSku: input.sellerSku,
      conditionCode: input.conditionCode,
      description: Object.freeze({ ...input.description }),
      status: 'draft',
      submittedAt: null,
      version: state.version + 1,
    });
    this.#pendingHistory = { changeKind: 'edited', changedFields: changed, occurredAt: input.now };
    return ok(changed);
  }

  /**
   * The seller's record of how the Offer's goods are handled (`own-offer.set-handling`, design
   * 4.4, 8.2; B1: a command of its own, never part of `edit`). Allowed on an Offer that is not
   * yet published, with the same return to `draft` as `edit`. A published Offer is refused until
   * the tag re-asking of slice 8 exists (fail closed: a handling change must reach
   * `evaluateClaims`). Answers the changed field ids (`['handling']` or none); a draft that
   * already holds the value stores nothing and leaves the version alone.
   */
  setHandling(input: {
    readonly handling: OfferHandling;
    readonly now: Temporal.Instant;
  }): Result<readonly string[], OfferHandlingRefusal> {
    const state = this.#state;
    if (
      state.status !== 'draft' &&
      state.status !== 'changes-needed' &&
      state.status !== 'pending-first-publish'
    ) {
      return err({ code: 'offer.not-editable' });
    }
    if (!(OFFER_HANDLINGS as readonly unknown[]).includes(input.handling)) {
      return err({ code: 'offer.handling-invalid' });
    }
    const changed = input.handling !== state.handling;
    if (!changed && state.status === 'draft') return ok([]);
    if (this.#pendingHistory !== null)
      throw new Error('setHandling: the Offer already has a change');
    this.#state = Object.freeze({
      ...state,
      handling: input.handling,
      status: 'draft',
      submittedAt: null,
      version: state.version + 1,
    });
    this.#pendingHistory = {
      changeKind: 'edited',
      changedFields: changed ? ['handling'] : [],
      occurredAt: input.now,
    };
    return ok(changed ? ['handling'] : []);
  }

  /**
   * The seller's submit of a `draft` Offer (catalog design 4.4): handling must be present. The
   * Market's `approvalRequired`, read by the caller in the same unit, decides: on, the Offer waits
   * for review (`pending-first-publish`); off, it is `published` at once with `catalog.offer-
   * published.v1`. The claim-text control and the product checks are the use case's.
   */
  submit(input: {
    readonly approvalRequired: boolean;
    readonly now: Temporal.Instant;
  }): Result<{ readonly published: boolean }, OfferTransitionRefusal> {
    const state = this.#state;
    if (state.status !== 'draft') return err({ code: 'offer.not-submittable' });
    if (state.handling === null) return err({ code: 'offer.handling-missing' });
    this.#assertNoChange('submit');
    if (input.approvalRequired) {
      this.#state = Object.freeze({
        ...state,
        status: 'pending-first-publish',
        submittedAt: input.now,
        version: state.version + 1,
      });
      this.#pendingHistory = { changeKind: 'submitted', changedFields: [], occurredAt: input.now };
      return ok({ published: false });
    }
    this.#publish(input.now, 'published', { submittedAt: input.now });
    return ok({ published: true });
  }

  /** A reviewer's approval of an Offer waiting for its first publication (design 4.4). */
  approve(input: { readonly now: Temporal.Instant }): Result<void, OfferTransitionRefusal> {
    if (this.#state.status !== 'pending-first-publish') {
      return err({ code: 'offer.not-pending-review' });
    }
    this.#assertNoChange('approve');
    this.#publish(input.now, 'publication-approved', {});
    return ok(undefined);
  }

  /**
   * A reviewer asks the seller for changes (design 4.4): `pending-first-publish` to
   * `changes-needed`, with the reason as a code on the event. The seller's edit returns it to
   * `draft`.
   */
  requestChanges(input: {
    readonly reasonCode: OfferChangeReason;
    readonly now: Temporal.Instant;
  }): Result<void, OfferTransitionRefusal> {
    const state = this.#state;
    if (state.status !== 'pending-first-publish') {
      return err({ code: 'offer.not-pending-review' });
    }
    this.#assertNoChange('requestChanges');
    const version = state.version + 1;
    this.#state = Object.freeze({ ...state, status: 'changes-needed', version });
    this.#pendingHistory = {
      changeKind: 'changes-requested',
      changedFields: [],
      occurredAt: input.now,
    };
    this.#events.push(
      OfferChangesRequested.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: input.now,
        payload: {
          offerId: state.id,
          productId: state.productId,
          sellerId: state.sellerId,
          reasonCode: input.reasonCode,
        },
      }),
    );
    return ok(undefined);
  }

  /**
   * The seller's delete (OFR-06; terminal): any Offer that is not deleted becomes `deleted`, and
   * a listed one stops being listed. The row stays (Q-K2); the event tells pricing and inventory.
   */
  delete(input: { readonly now: Temporal.Instant }): Result<void, OfferTransitionRefusal> {
    const state = this.#state;
    if (state.status === 'deleted') return err({ code: 'offer.already-deleted' });
    this.#assertNoChange('delete');
    const version = state.version + 1;
    this.#state = Object.freeze({
      ...state,
      status: 'deleted',
      listed: false,
      deletedAt: input.now,
      version,
    });
    this.#pendingHistory = { changeKind: 'deleted', changedFields: [], occurredAt: input.now };
    this.#events.push(
      OfferDeleted.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: input.now,
        payload: { offerId: state.id, productId: state.productId, sellerId: state.sellerId },
      }),
    );
    return ok(undefined);
  }

  /** `published` with its first-publication stamp and the event; listed when no cause is stored. */
  #publish(
    now: Temporal.Instant,
    changeKind: 'published' | 'publication-approved',
    extra: { readonly submittedAt?: Temporal.Instant },
  ): void {
    const state = this.#state;
    const version = state.version + 1;
    this.#state = Object.freeze({
      ...state,
      ...extra,
      status: 'published',
      firstPublishedAt: now,
      listed: isListed({ status: 'published', offSaleCauses: state.offSaleCauses }),
      version,
    });
    this.#pendingHistory = { changeKind, changedFields: [], occurredAt: now };
    this.#events.push(
      OfferPublished.record({
        aggregateId: state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { offerId: state.id, productId: state.productId, sellerId: state.sellerId },
      }),
    );
  }

  #assertNoChange(command: string): void {
    if (this.#pendingHistory !== null)
      throw new Error(`${command}: the Offer already has a change`);
  }

  /** An Offer read back from storage; records no event. */
  static restore(state: OfferState): Offer {
    return new Offer(state, state.version);
  }

  get state(): OfferState {
    return this.#state;
  }

  /** The version the row had when it was read, or null for an Offer not yet stored. */
  get persistedVersion(): number | null {
    return this.#persistedVersion;
  }

  /** The history row to store with the change made since the Offer was read, or null. */
  get pendingHistory(): OfferPendingHistory | null {
    return this.#pendingHistory;
  }

  /** Events recorded since the aggregate was built, in the order of their versions. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }
}
