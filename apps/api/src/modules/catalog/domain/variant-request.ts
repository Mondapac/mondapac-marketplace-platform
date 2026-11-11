import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import { noticeRetryAt } from './certificate-expiry-notice';
import { isSuggestionText, tidySuggestionText } from './attribute-value-suggestion';
import { optionKeyOf } from './revision-freeze';

// A seller's request for a new variant (size) on a PLATFORM product they sell (variants plan,
// package V7; decision tn14). Born `open`, it moves once: an admin approves it (the variant was
// added to the product's draft), maps it to a variant the product already has, or declines it
// with a reason. Then one mail tells the seller; the notice has its own small state so a failed
// send is tried again without touching the decision.
//
//   open --approve--> approved        notice: none --decide--> pending --> sent | skipped | failed
//        --map------> mapped
//        --decline--> declined

export const VARIANT_REQUEST_REASON_MAX = 300;
/** How many requests one seller may have waiting for a decision at once. */
export const MAX_OPEN_VARIANT_REQUESTS_PER_SELLER = 10;
/** How many requests one seller may make in any 24 hours. */
export const MAX_VARIANT_REQUESTS_PER_DAY = 20;

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export type VariantRequestStatus = 'open' | 'approved' | 'mapped' | 'declined';
export type VariantRequestNoticeState = 'none' | 'pending' | 'sent' | 'skipped' | 'failed';

export interface VariantRequestState {
  readonly id: Id<'VariantRequest'>;
  readonly marketId: MarketId;
  readonly sellerId: Id<'Seller'>;
  readonly offerId: Id<'Offer'>;
  readonly productId: Id<'Product'>;
  /** Variant attribute code to option code. */
  readonly optionValues: Readonly<Record<string, string>>;
  /** The canonical string of the option values, as a revision builds it. */
  readonly optionKey: string;
  readonly status: VariantRequestStatus;
  /** The variant created (approved) or chosen (mapped). */
  readonly resolvedVariantId: Id<'Variant'> | null;
  /** The reviewer's words to the seller (declined). */
  readonly declineReason: string | null;
  readonly decidedByAccountId: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly noticeState: VariantRequestNoticeState;
  readonly noticeAttempts: number;
  readonly noticeNextAttemptAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export type VariantRequestRefusal =
  | { readonly code: 'variant-request.options-invalid' }
  | { readonly code: 'variant-request.reason-invalid' }
  | { readonly code: 'variant-request.variant-invalid' }
  /** The request was decided before. */
  | { readonly code: 'variant-request.not-open' };

/** Option values the request may hold: one or two axes, each an attribute code and an option code. */
export function areRequestOptionValues(values: unknown): values is Record<string, string> {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) return false;
  const entries = Object.entries(values);
  return (
    entries.length >= 1 &&
    entries.length <= 2 &&
    entries.every(
      ([axis, option]) => CODE.test(axis) && typeof option === 'string' && CODE.test(option),
    )
  );
}

export class VariantRequest {
  readonly #state: VariantRequestState;

  private constructor(state: VariantRequestState) {
    this.#state = state;
  }

  get state(): VariantRequestState {
    return this.#state;
  }

  /** A new open request. */
  static open(input: {
    readonly id: Id<'VariantRequest'>;
    readonly marketId: MarketId;
    readonly sellerId: Id<'Seller'>;
    readonly offerId: Id<'Offer'>;
    readonly productId: Id<'Product'>;
    readonly optionValues: Readonly<Record<string, string>>;
    readonly now: Temporal.Instant;
  }): Result<VariantRequest, VariantRequestRefusal> {
    if (!areRequestOptionValues(input.optionValues)) {
      return err({ code: 'variant-request.options-invalid' });
    }
    return ok(
      new VariantRequest({
        id: input.id,
        marketId: input.marketId,
        sellerId: input.sellerId,
        offerId: input.offerId,
        productId: input.productId,
        optionValues: { ...input.optionValues },
        optionKey: optionKeyOf(input.optionValues),
        status: 'open',
        resolvedVariantId: null,
        declineReason: null,
        decidedByAccountId: null,
        decidedAt: null,
        noticeState: 'none',
        noticeAttempts: 0,
        noticeNextAttemptAt: null,
        version: 1,
        createdAt: input.now,
      }),
    );
  }

  static rehydrate(state: VariantRequestState): VariantRequest {
    return new VariantRequest(state);
  }

  /** Approved: the admin added the variant `variantId` to the product's draft. */
  approve(input: {
    readonly accountId: Id<'Account'>;
    readonly variantId: Id<'Variant'>;
    readonly now: Temporal.Instant;
  }): Result<VariantRequest, VariantRequestRefusal> {
    return this.#decide('approved', input.accountId, input.variantId, null, input.now);
  }

  /** Mapped: the admin pointed it at the variant the product already has. */
  map(input: {
    readonly accountId: Id<'Account'>;
    readonly variantId: Id<'Variant'>;
    readonly now: Temporal.Instant;
  }): Result<VariantRequest, VariantRequestRefusal> {
    return this.#decide('mapped', input.accountId, input.variantId, null, input.now);
  }

  /** Declined, with the words the seller will read. */
  decline(input: {
    readonly accountId: Id<'Account'>;
    readonly reason: string;
    readonly now: Temporal.Instant;
  }): Result<VariantRequest, VariantRequestRefusal> {
    const reason = tidySuggestionText(input.reason);
    if (!isSuggestionText(reason, VARIANT_REQUEST_REASON_MAX)) {
      return err({ code: 'variant-request.reason-invalid' });
    }
    return this.#decide('declined', input.accountId, null, reason, input.now);
  }

  #decide(
    status: 'approved' | 'mapped' | 'declined',
    accountId: Id<'Account'>,
    variantId: Id<'Variant'> | null,
    declineReason: string | null,
    now: Temporal.Instant,
  ): Result<VariantRequest, VariantRequestRefusal> {
    const current = this.#state;
    if (current.status !== 'open') return err({ code: 'variant-request.not-open' });
    if (status !== 'declined' && variantId === null) {
      return err({ code: 'variant-request.variant-invalid' });
    }
    return ok(
      new VariantRequest({
        ...current,
        status,
        resolvedVariantId: variantId,
        declineReason,
        decidedByAccountId: accountId,
        decidedAt: now,
        noticeState: 'pending',
        noticeAttempts: 0,
        noticeNextAttemptAt: now,
        version: current.version + 1,
      }),
    );
  }

  /** The notice was sent. Only a pending notice moves. */
  noticeSent(): VariantRequest | null {
    return this.#settled('sent', this.#state.noticeAttempts + 1);
  }

  /** The notice has nobody to go to (no usable address): settled without a mail. */
  noticeSkipped(): VariantRequest | null {
    return this.#settled('skipped', this.#state.noticeAttempts);
  }

  /** A send failed: tried again later, or given up as `failed` once the attempts are used up. */
  noticeFailedAt(now: Temporal.Instant): VariantRequest | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    const retry = noticeRetryAt(current.noticeAttempts, now);
    const attempts = current.noticeAttempts + 1;
    if (retry === null) return this.#settled('failed', attempts);
    return new VariantRequest({
      ...current,
      noticeAttempts: attempts,
      noticeNextAttemptAt: retry,
      version: current.version + 1,
    });
  }

  #settled(state: 'sent' | 'skipped' | 'failed', attempts: number): VariantRequest | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    return new VariantRequest({
      ...current,
      noticeState: state,
      noticeAttempts: attempts,
      noticeNextAttemptAt: null,
      version: current.version + 1,
    });
  }
}
