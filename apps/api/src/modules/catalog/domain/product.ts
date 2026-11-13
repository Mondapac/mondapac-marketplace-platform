import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import {
  ProductPaused,
  ProductResumed,
  ProductRetired,
  ProductFamilyChanged,
  ProductRevisionChangesRequestedV2,
  type ProductChangeReason,
  ProductRevisionPublished,
  ProductRevisionSubmitted,
  ProductTypeChanged,
  ProductWithdrawn,
  EVENT_PRODUCT_TYPE_CODES,
  type EventProductTypeCode,
  VariantAdded,
  VariantRemoved,
} from './events';
import type { RevisionOutcome } from './product-revision-policy';
import type { ProductTypeCode, ProductTypeHandler, VariantModel } from './product-type-handler';
import { configurableProductType } from './product-types/configurable';
import { simpleProductType } from './product-types/simple';

export const PRODUCT_SCOPES = ['PLATFORM', 'SELLER'] as const;
export type ProductScope = (typeof PRODUCT_SCOPES)[number];

export const PRODUCT_STATUSES = [
  'draft',
  'discarded',
  'unpublished',
  'published',
  'matched',
  'withdrawn',
  'retired',
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const VARIANT_STATES = ['proposed', 'published', 'retired'] as const;
export type VariantState = (typeof VARIANT_STATES)[number];

/** Who writes content: a PLATFORM product accepts only an admin (CAT-43, AC 3). */
export type AuthorKind = 'seller' | 'admin';

/** CAT-43 and its mirror: a seller never writes PLATFORM content, an admin never a SELLER draft. */
function authorRefusal(scope: ProductScope, authorKind: AuthorKind): ProductRefusal | null {
  if (scope === 'PLATFORM' && authorKind !== 'admin')
    return { code: 'product.platform-admin-only' };
  if (scope === 'SELLER' && authorKind !== 'seller') return { code: 'product.seller-only' };
  return null;
}

/** The lower-case spelling event enums use for a scope. */
const eventScope = (scope: ProductScope): 'platform' | 'seller' =>
  scope === 'PLATFORM' ? 'platform' : 'seller';

/** A limit that is not a positive safe integer would switch the check off: refuse it loudly. */
function assertMaxVariants(maxVariants: number): void {
  if (!Number.isSafeInteger(maxVariants) || maxVariants < 1) {
    throw new RangeError('Product: maxVariants must be a positive integer');
  }
}

/** The statuses whose working copy can still be saved (4.1); the others are terminal. */
const EDITABLE_STATUSES: readonly ProductStatus[] = ['draft', 'unpublished', 'published'];

export interface VariantRecord {
  readonly id: Id<'Variant'>;
  /** 1, 2, 3 ... within the product in creation order; never reused, also after retirement (V2). */
  readonly variantNo: number;
  readonly state: VariantState;
  readonly createdAt: Temporal.Instant;
  readonly publishedAt: Temporal.Instant | null;
  readonly retiredAt: Temporal.Instant | null;
}

export interface ProductState {
  readonly id: Id<'Product'>;
  readonly marketId: MarketId;
  readonly scope: ProductScope;
  /** Set exactly when the scope is SELLER (data design 3.1 products_owner_check). */
  readonly ownerSellerId: Id<'Seller'> | null;
  /** The seller who created it; never changes, so the origin survives promotion. */
  readonly createdBySellerId: Id<'Seller'> | null;
  readonly typeCode: ProductTypeCode;
  readonly variantModel: VariantModel;
  readonly familyCode: string;
  /** Minted by the server from the Market sequence, never from input. */
  readonly productCode: string;
  readonly status: ProductStatus;
  readonly discardedAt: Temporal.Instant | null;
  /** Set exactly when the status is `withdrawn` (data design 3.1). */
  readonly withdrawnAt: Temporal.Instant | null;
  /** Set exactly when the status is `retired`. */
  readonly retiredAt: Temporal.Instant | null;
  /**
   * The reversible admin pause (design 4.1a): a mark, valid only on a `published` product, with
   * the admin who set it. Both or neither. Cleared by resume, retire and withdraw.
   */
  readonly pausedAt: Temporal.Instant | null;
  readonly pausedByAccountId: Id<'Account'> | null;
  readonly ownBrand: boolean;
  readonly lastChangedAt: Temporal.Instant;
  /** Optimistic version (P 10): every change, and one more per event beyond the first. */
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  /** Every variant ever minted for the product, in creation order; none is removed. */
  readonly variants: readonly VariantRecord[];
  /** The revision in force (data design 3.1); null until the first publication. */
  readonly publishedRevisionId: Id<'ProductRevision'> | null;
  /** The revision waiting for review; at most one (VER-01); distinct from the published one. */
  readonly pendingRevisionId: Id<'ProductRevision'> | null;
  /** Set exactly when `pendingRevisionId` is (the review queue's order). */
  readonly pendingSubmittedAt: Temporal.Instant | null;
}

/** An event a command records: its definition and payload. */
interface DomainEventRecord {
  readonly definition: {
    record(input: {
      aggregateId: Id;
      aggregateVersion: number;
      occurredAt: Temporal.Instant;
      payload: never;
    }): PendingEvent;
  };
  readonly payload: unknown;
}

/** A feature set code (the CHECK of `products.family_code`). */
const FAMILY_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * The type code an event names. The event vocabulary lists the two types core registers; a type
 * outside the list is a defect to fix with a new event version, never a silent pass.
 */
function eventTypeCode(typeCode: ProductTypeCode): EventProductTypeCode {
  if (!(EVENT_PRODUCT_TYPE_CODES as readonly string[]).includes(typeCode)) {
    throw new RangeError('Product: the event vocabulary does not list this product type');
  }
  return typeCode as EventProductTypeCode;
}

/** Why a command was refused: a stable code, never data. */
export type ProductRefusal =
  | { readonly code: 'product.scope-owner-mismatch' }
  | { readonly code: 'product.not-a-draft' }
  | { readonly code: 'product.not-editable' }
  | { readonly code: 'product.platform-admin-only' }
  | { readonly code: 'product.seller-only' }
  | { readonly code: 'variant.unknown' }
  | { readonly code: 'variant.fixed' }
  | { readonly code: 'variant.limit-reached'; readonly max: number }
  | { readonly code: 'variant.id-taken' }
  | { readonly code: 'variant.not-found' }
  | { readonly code: 'variant.not-proposed' }
  | { readonly code: 'variant.none' }
  | { readonly code: 'revision.pending-exists' }
  | { readonly code: 'revision.id-taken' }
  | { readonly code: 'revision.outcome-not-allowed' }
  | { readonly code: 'revision.base-changed' }
  | { readonly code: 'review.not-current-revision' }
  | { readonly code: 'product.no-published-revision' }
  | { readonly code: 'product.not-published' }
  | { readonly code: 'product.already-paused' }
  | { readonly code: 'product.not-paused' }
  | { readonly code: 'product.not-withdrawable' }
  | { readonly code: 'product.platform-only' }
  | { readonly code: 'product.family-invalid' }
  | { readonly code: 'product.not-simple' }
  | { readonly code: 'revision.revert-changes-type' };

/** `P` and eight digits: the case-sensitive, enumerable-but-meaningless code of data design 3.1. */
export function formatProductCode(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > 99_999_999) {
    throw new RangeError('formatProductCode: the sequence is outside 1 to 99999999');
  }
  return `P${String(sequence).padStart(8, '0')}`;
}

/**
 * A product of the catalog (catalog design 2.1, 4.1). Slice 1 holds identity, scope, owner,
 * type, code, lifecycle start and end (`draft`, `discarded`) and the variant registry (M-1): a
 * variant id is minted once, never reused, never revived, and a retirement is announced in the
 * unit that makes it. Revisions, pointers and the later statuses arrive with their slices.
 *
 * A change raises the version by one, plus one more per event beyond the first (Q-K3): one
 * version per event, in a fixed order, so the outbox's unique `(aggregate, version)` holds.
 */
export class Product {
  #state: ProductState;
  readonly #events: PendingEvent[] = [];
  readonly #persistedVersion: number | null;

  private constructor(state: ProductState, persistedVersion: number | null) {
    this.#state = Object.freeze(state);
    this.#persistedVersion = persistedVersion;
  }

  /**
   * A new draft. A Simple product (`variantModel` `single`) gets its one variant now, in state
   * `proposed`, and announces it; a Configurable one starts with none (its variants come with
   * the working copy, slice 4). `variantId` is required for `single` and ignored otherwise.
   */
  static create(input: {
    readonly id: Id<'Product'>;
    readonly marketId: MarketId;
    readonly scope: ProductScope;
    readonly sellerId: Id<'Seller'> | null;
    /** The registered handler of the type: its code and variant model travel together. */
    readonly handler: Pick<ProductTypeHandler, 'typeCode' | 'variantModel'>;
    readonly familyCode: string;
    readonly productCode: string;
    readonly variantId: Id<'Variant'> | null;
    readonly now: Temporal.Instant;
  }): Result<Product, ProductRefusal> {
    if ((input.scope === 'SELLER') !== (input.sellerId !== null)) {
      return err({ code: 'product.scope-owner-mismatch' });
    }
    const single = input.handler.variantModel === 'single';
    if (single && input.variantId === null) {
      throw new TypeError('Product.create: a Simple product needs its variant id');
    }
    const variants: VariantRecord[] =
      single && input.variantId !== null
        ? [
            {
              id: input.variantId,
              variantNo: 1,
              state: 'proposed',
              createdAt: input.now,
              publishedAt: null,
              retiredAt: null,
            },
          ]
        : [];
    const product = new Product(
      {
        id: input.id,
        marketId: input.marketId,
        scope: input.scope,
        ownerSellerId: input.sellerId,
        createdBySellerId: input.sellerId,
        typeCode: input.handler.typeCode,
        variantModel: input.handler.variantModel,
        familyCode: input.familyCode,
        productCode: input.productCode,
        status: 'draft',
        discardedAt: null,
        withdrawnAt: null,
        retiredAt: null,
        pausedAt: null,
        pausedByAccountId: null,
        ownBrand: false,
        lastChangedAt: input.now,
        version: 1,
        createdAt: input.now,
        variants,
        publishedRevisionId: null,
        pendingRevisionId: null,
        pendingSubmittedAt: null,
      },
      null,
    );
    product.#apply(input.now, {}, [{ definition: VariantAdded, variantId: variants[0]?.id }]);
    return ok(product);
  }

  /** A product read back from storage; records no event. */
  static restore(state: ProductState): Product {
    return new Product(state, state.version);
  }

  get state(): ProductState {
    return this.#state;
  }

  /** The version the row had when it was read, or null for a product not yet stored. */
  get persistedVersion(): number | null {
    return this.#persistedVersion;
  }

  /** Events recorded since the aggregate was built, in the order of their versions. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /** The variants that are not retired. */
  get liveVariants(): readonly VariantRecord[] {
    return this.#state.variants.filter((variant) => variant.state !== 'retired');
  }

  /**
   * Adds a `proposed` variant to a Configurable draft, up to `maxVariants` non-retired ones
   * (`maxVariantsPerProduct`, Market configuration). The id is minted by the caller.
   */
  addVariant(
    variantId: Id<'Variant'>,
    maxVariants: number,
    now: Temporal.Instant,
    authorKind: AuthorKind,
  ): Result<void, ProductRefusal> {
    assertMaxVariants(maxVariants);
    const refusal = authorRefusal(this.#state.scope, authorKind);
    if (refusal !== null) return err(refusal);
    if (!EDITABLE_STATUSES.includes(this.#state.status)) {
      return err({ code: 'product.not-editable' });
    }
    if (this.#state.variantModel === 'single') return err({ code: 'variant.fixed' });
    if (this.#state.variants.some((existing) => existing.id === variantId)) {
      return err({ code: 'variant.id-taken' });
    }
    if (this.liveVariants.length >= maxVariants)
      return err({ code: 'variant.limit-reached', max: maxVariants });
    // Every variant ever minted stays in the registry (M-1), so the next number is the highest
    // one plus one and a retired variant's number is never handed out again.
    const variantNo = this.#state.variants.reduce((top, v) => Math.max(top, v.variantNo), 0) + 1;
    const variant: VariantRecord = {
      id: variantId,
      variantNo,
      state: 'proposed',
      createdAt: now,
      publishedAt: null,
      retiredAt: null,
    };
    this.#apply(now, { variants: [...this.#state.variants, variant] }, [
      { definition: VariantAdded, variantId: variant.id },
    ]);
    return ok(undefined);
  }

  /**
   * Retires a variant that was never published, at a draft save (Ali B2): it may already carry a
   * price, so its removal is announced. While the product is Simple its one variant is retired only
   * by {@link discard} (after Add sizes it is an ordinary variant of a Configurable product); a
   * published variant is retired by a publish (slice 11).
   */
  removeProposedVariant(
    variantId: Id<'Variant'>,
    now: Temporal.Instant,
    authorKind: AuthorKind,
  ): Result<void, ProductRefusal> {
    const refusal = authorRefusal(this.#state.scope, authorKind);
    if (refusal !== null) return err(refusal);
    if (!EDITABLE_STATUSES.includes(this.#state.status)) {
      return err({ code: 'product.not-editable' });
    }
    if (this.#state.variantModel === 'single') return err({ code: 'variant.fixed' });
    const variant = this.#state.variants.find((candidate) => candidate.id === variantId);
    if (variant === undefined) return err({ code: 'variant.not-found' });
    if (variant.state !== 'proposed') return err({ code: 'variant.not-proposed' });
    this.#apply(now, { variants: this.#retire(this.#state.variants, [variant.id], now) }, [
      { definition: VariantRemoved, variantId: variant.id },
    ]);
    return ok(undefined);
  }

  /**
   * The variant half of a working-copy save (design 4.2, M-1, Ali B2, Hassan M3). `variantIds`
   * is the draft's variant list in order: an id the server minted before, or `null` for a new
   * variant. Every id must be a live variant of this product (`variant.unknown`, the same answer
   * for a foreign, retired or invented id), and the whole save is refused on the first fault. A
   * live `proposed` variant the draft leaves out is retired and announced in this unit; a
   * `published` one stays (its publish retires it). New variants are minted through `newId` and
   * checked against `maxVariants` after the retirements. A Simple product keeps its one fixed
   * variant. Returns the ids in the order of the list.
   */
  saveWorkingCopy(input: {
    readonly authorKind: AuthorKind;
    readonly variantIds: readonly (Id<'Variant'> | null)[];
    readonly maxVariants: number;
    readonly newId: () => Id<'Variant'>;
    readonly now: Temporal.Instant;
  }): Result<{ readonly variantIds: readonly Id<'Variant'>[] }, ProductRefusal> {
    assertMaxVariants(input.maxVariants);
    const state = this.#state;
    const refusal = authorRefusal(state.scope, input.authorKind);
    if (refusal !== null) return err(refusal);
    if (!EDITABLE_STATUSES.includes(state.status)) return err({ code: 'product.not-editable' });
    const live = this.liveVariants;
    const kept = new Set<Id<'Variant'>>();
    for (const id of input.variantIds) {
      if (id === null) continue;
      if (!live.some((variant) => variant.id === id) || kept.has(id)) {
        return err({ code: 'variant.unknown' });
      }
      kept.add(id);
    }
    if (state.variantModel === 'single') {
      if (input.variantIds.some((id) => id === null)) return err({ code: 'variant.fixed' });
      return ok({ variantIds: live.map((variant) => variant.id) });
    }
    const removed = live.filter((variant) => variant.state === 'proposed' && !kept.has(variant.id));
    const added = input.variantIds.filter((id) => id === null).length;
    if (live.length - removed.length + added > input.maxVariants) {
      return err({ code: 'variant.limit-reached', max: input.maxVariants });
    }
    const createdVariants: VariantRecord[] = [];
    // The registry keeps retired variants, so the highest number ever used plus one is never reused.
    let topNo = this.#state.variants.reduce((top, v) => Math.max(top, v.variantNo), 0);
    const resolved = input.variantIds.map((id) => {
      if (id !== null) return id;
      const minted = input.newId();
      topNo += 1;
      createdVariants.push({
        id: minted,
        variantNo: topNo,
        state: 'proposed',
        createdAt: input.now,
        publishedAt: null,
        retiredAt: null,
      });
      return minted;
    });
    if (removed.length > 0 || createdVariants.length > 0) {
      this.#apply(
        input.now,
        {
          variants: [
            ...this.#retire(
              state.variants,
              removed.map((variant) => variant.id),
              input.now,
            ),
            ...createdVariants,
          ],
        },
        [
          ...removed.map((variant) => ({ definition: VariantRemoved, variantId: variant.id })),
          ...createdVariants.map((variant) => ({
            definition: VariantAdded,
            variantId: variant.id,
          })),
        ],
      );
    }
    return ok({ variantIds: resolved });
  }

  /**
   * A submit of a frozen revision (catalog design 4.2 row 1, 4.3). `outcome` is the verdict of
   * `ProductRevisionPolicy.decideOutcome`: `pending` records the revision as the one waiting for
   * review (a first submit moves `draft` to `unpublished`); `published` makes it the published
   * revision at once. The revision's base must be the revision now published
   * (`revision.base-changed`), and an existing pending revision is superseded only when
   * `replacePending` says so (`revision.pending-exists`). The revision names the variants it
   * holds: all live, none repeated, within `maxVariants`, a Simple product's one variant exactly.
   */
  submitRevision(input: {
    readonly revisionId: Id<'ProductRevision'>;
    readonly baseRevisionId: Id<'ProductRevision'> | null;
    readonly outcome: RevisionOutcome;
    readonly authorKind: AuthorKind;
    /**
     * The feature set the revision was frozen under (resolved from its primary category). The
     * product takes it with the pointer move and raises `catalog.product-family-changed` when
     * it differs (CAT-10, decision ت۱۰).
     */
    readonly familyCode: string;
    readonly replacePending: boolean;
    readonly revisionVariantIds: readonly Id<'Variant'>[];
    readonly maxVariants: number;
    readonly now: Temporal.Instant;
  }): Result<{ readonly published: boolean }, ProductRefusal> {
    assertMaxVariants(input.maxVariants);
    const state = this.#state;
    const refusal = authorRefusal(state.scope, input.authorKind);
    if (refusal !== null) return err(refusal);
    if (!EDITABLE_STATUSES.includes(state.status)) return err({ code: 'product.not-editable' });
    if (input.outcome.outcome === 'published' && input.outcome.publishKind === 'admin-authored') {
      // Only an admin's own revision publishes as admin-authored (Hassan L1).
      if (input.authorKind !== 'admin') return err({ code: 'revision.outcome-not-allowed' });
    }
    if (input.baseRevisionId !== state.publishedRevisionId) {
      return err({ code: 'revision.base-changed' });
    }
    if (state.pendingRevisionId !== null && !input.replacePending) {
      return err({ code: 'revision.pending-exists' });
    }
    const variants = this.#checkRevisionVariants(input.revisionVariantIds, input.maxVariants);
    if (!variants.ok) return variants;
    if (!FAMILY_CODE.test(input.familyCode)) return err({ code: 'product.family-invalid' });
    const submitted = {
      definition: ProductRevisionSubmitted,
      payload: {
        productId: state.id,
        revisionId: input.revisionId,
        scope: eventScope(state.scope),
      },
    };
    const familyChanged = input.familyCode !== state.familyCode;
    const events: readonly DomainEventRecord[] = familyChanged
      ? [
          submitted,
          {
            definition: ProductFamilyChanged,
            payload: {
              productId: state.id,
              revisionId: input.revisionId,
              scope: eventScope(state.scope),
            },
          },
        ]
      : [submitted];
    if (input.outcome.outcome === 'pending') {
      this.#applyRecords(
        input.now,
        {
          status: state.status === 'draft' ? 'unpublished' : state.status,
          familyCode: input.familyCode,
          pendingRevisionId: input.revisionId,
          pendingSubmittedAt: input.now,
        },
        events,
      );
      return ok({ published: false });
    }
    // The revision was frozen from this row in this unit, so its type is the row's.
    this.#publish(
      input.revisionId,
      input.revisionVariantIds,
      state.typeCode,
      input.now,
      events,
      false,
      {
        familyCode: input.familyCode,
      },
    );
    return ok({ published: true });
  }

  /**
   * The reviewer's approval (catalog design 4.2 row 3; AC 29): the revision named must be the
   * pending one, else `review.not-current-revision` and nothing changes; its base must still be
   * the published revision (`revision.base-changed`, the seller rebases). Admin only.
   */
  approveRevision(input: {
    readonly revisionId: Id<'ProductRevision'>;
    readonly baseRevisionId: Id<'ProductRevision'> | null;
    /** The type the pending revision was frozen with (M-9), not the row's. */
    readonly revisionTypeCode: ProductTypeCode;
    readonly revisionVariantIds: readonly Id<'Variant'>[];
    readonly maxVariants: number;
    readonly now: Temporal.Instant;
  }): Result<void, ProductRefusal> {
    assertMaxVariants(input.maxVariants);
    const state = this.#state;
    if (state.scope !== 'SELLER') return err({ code: 'product.seller-only' });
    if (!EDITABLE_STATUSES.includes(state.status)) return err({ code: 'product.not-editable' });
    if (state.pendingRevisionId === null || state.pendingRevisionId !== input.revisionId) {
      return err({ code: 'review.not-current-revision' });
    }
    if (input.baseRevisionId !== state.publishedRevisionId) {
      return err({ code: 'revision.base-changed' });
    }
    const variants = this.#checkRevisionVariants(input.revisionVariantIds, input.maxVariants);
    if (!variants.ok) return variants;
    this.#publish(
      input.revisionId,
      input.revisionVariantIds,
      input.revisionTypeCode,
      input.now,
      [],
    );
    return ok(undefined);
  }

  /**
   * The reviewer sends the pending revision back (catalog design 4.2 row 5): the revision named
   * must be the pending one, else `review.not-current-revision`. The pending pointer clears; the
   * published revision, the status and the working copy stay. The reason is a code of the product
   * list (D2). Only a SELLER product has a review; the decision row is the store's.
   */
  requestRevisionChanges(input: {
    readonly revisionId: Id<'ProductRevision'>;
    readonly reasonCode: ProductChangeReason;
    /**
     * The feature set the product had before the pending revision: the published revision's, or
     * the Market default for a product never published. The family follows the accepted state
     * only (decision ت۷), so the product goes back to it.
     */
    readonly revertFamilyCode: string;
    readonly now: Temporal.Instant;
  }): Result<void, ProductRefusal> {
    const state = this.#state;
    if (state.scope !== 'SELLER') return err({ code: 'product.seller-only' });
    if (!EDITABLE_STATUSES.includes(state.status)) return err({ code: 'product.not-editable' });
    if (state.pendingRevisionId === null || state.pendingRevisionId !== input.revisionId) {
      return err({ code: 'review.not-current-revision' });
    }
    if (!FAMILY_CODE.test(input.revertFamilyCode)) return err({ code: 'product.family-invalid' });
    const reverted = input.revertFamilyCode !== state.familyCode;
    this.#applyRecords(
      input.now,
      {
        familyCode: input.revertFamilyCode,
        pendingRevisionId: null,
        pendingSubmittedAt: null,
      },
      [
        {
          definition: ProductRevisionChangesRequestedV2,
          payload: {
            productId: state.id,
            revisionId: input.revisionId,
            reasonCode: input.reasonCode,
            scope: eventScope(state.scope),
          },
        },
        ...(reverted
          ? [
              {
                definition: ProductFamilyChanged,
                payload: {
                  productId: state.id,
                  revisionId: input.revisionId,
                  scope: eventScope(state.scope),
                },
              },
            ]
          : []),
      ],
    );
    return ok(undefined);
  }

  /**
   * An admin's tax category override of a SELLER product (catalog design 4.3; AC 36): a revision
   * built from the published one, published at once. A pending seller revision stays pending and
   * is rebased by its seller. The variants are the ones the published revision holds.
   */
  publishTaxOverride(input: {
    readonly revisionId: Id<'ProductRevision'>;
    /** The revision the override content was built from; it must be the published one (Hassan L2). */
    readonly fromRevisionId: Id<'ProductRevision'>;
    /** The base revision's own type, which the override copies (catalog design 4.3, M-9). */
    readonly revisionTypeCode: ProductTypeCode;
    readonly now: Temporal.Instant;
  }): Result<void, ProductRefusal> {
    const state = this.#state;
    if (state.scope !== 'SELLER') return err({ code: 'product.seller-only' });
    if (state.status !== 'published' || state.publishedRevisionId === null) {
      return err({ code: 'product.no-published-revision' });
    }
    if (input.fromRevisionId !== state.publishedRevisionId) {
      return err({ code: 'revision.base-changed' });
    }
    if (
      input.revisionId === state.publishedRevisionId ||
      input.revisionId === state.pendingRevisionId
    ) {
      return err({ code: 'revision.id-taken' });
    }
    const held = this.liveVariants
      .filter((variant) => variant.state === 'published')
      .map((variant) => variant.id);
    this.#publish(input.revisionId, held, input.revisionTypeCode, input.now, [], true);
    return ok(undefined);
  }

  /** The variants a revision names: at least one, none repeated, all live, within the limit. */
  #checkRevisionVariants(
    ids: readonly Id<'Variant'>[],
    maxVariants: number,
  ): Result<void, ProductRefusal> {
    if (ids.length === 0) return err({ code: 'variant.none' });
    const live = this.liveVariants;
    const seen = new Set<Id<'Variant'>>();
    for (const id of ids) {
      if (seen.has(id) || !live.some((variant) => variant.id === id)) {
        return err({ code: 'variant.unknown' });
      }
      seen.add(id);
    }
    if (this.#state.variantModel === 'single' && ids.length !== live.length) {
      return err({ code: 'variant.unknown' });
    }
    if (ids.length > maxVariants) return err({ code: 'variant.limit-reached', max: maxVariants });
    return ok(undefined);
  }

  /**
   * Makes `revisionId` the published revision: a `proposed` variant it names becomes `published`,
   * a `published` one it leaves out is retired and announced (M-1), the pending pointer is cleared
   * unless `keepPending` (a tax override leaves a seller's pending revision alone; any other publish
   * supersedes or fulfils it), and the status becomes `published`. `before` are events
   * that come first (the submit event).
   */
  #publish(
    revisionId: Id<'ProductRevision'>,
    named: readonly Id<'Variant'>[],
    revisionTypeCode: ProductTypeCode,
    now: Temporal.Instant,
    before: readonly DomainEventRecord[],
    keepPending = false,
    extra: Partial<ProductState> = {},
  ): void {
    const state = this.#state;
    const dropped = state.variants.filter(
      (variant) => variant.state === 'published' && !named.includes(variant.id),
    );
    const variants = state.variants.map((variant) => {
      if (variant.state === 'proposed' && named.includes(variant.id)) {
        return { ...variant, state: 'published' as const, publishedAt: now };
      }
      return variant;
    });
    this.#applyRecords(
      now,
      {
        ...extra,
        status: 'published',
        publishedRevisionId: revisionId,
        ...(keepPending ? {} : { pendingRevisionId: null, pendingSubmittedAt: null }),
        variants: this.#retire(
          variants,
          dropped.map((variant) => variant.id),
          now,
        ),
      },
      [
        ...before,
        {
          definition: ProductRevisionPublished,
          payload: {
            productId: state.id,
            revisionId,
            previousRevisionId: state.publishedRevisionId,
            scope: eventScope(state.scope),
            typeCode: eventTypeCode(revisionTypeCode),
          },
        },
        ...dropped.map((variant) => ({
          definition: VariantRemoved,
          payload: { productId: state.id, variantId: variant.id },
        })),
      ],
    );
  }

  /**
   * The guards of Add sizes that only the aggregate can answer, in the order of design 4.2a: the
   * author rule (CAT-43), a product that has not ended, a Simple type (`product.not-simple`) and a
   * pending revision that `replacePending` does not allow. The use case asks it before it reads
   * anything else, so the first failure answers; {@link addSizes} asks it again.
   */
  checkAddSizes(input: {
    readonly authorKind: AuthorKind;
    readonly replacePending: boolean;
  }): Result<void, ProductRefusal> {
    const state = this.#state;
    const refusal = authorRefusal(state.scope, input.authorKind);
    if (refusal !== null) return err(refusal);
    if (!EDITABLE_STATUSES.includes(state.status)) return err({ code: 'product.not-editable' });
    if (
      state.typeCode !== simpleProductType.typeCode ||
      state.variantModel !== simpleProductType.variantModel
    ) {
      return err({ code: 'product.not-simple' });
    }
    if (state.pendingRevisionId !== null && !input.replacePending) {
      return err({ code: 'revision.pending-exists' });
    }
    return ok(undefined);
  }

  /**
   * Add sizes (catalog design 4.2a, 2.3 M-9; variants V9, CAT-10 change): a Simple product becomes
   * Configurable, once and never back. The type and the variant model change on the product row
   * and, through the foreign key, on its one variant, whose id, number, code, prices, stock and sell
   * units stay (they key on the variant id). Nothing is published: the next submit freezes a
   * Configurable revision.
   *
   * A pending revision (allowed by `replacePending`) is superseded: its pointer clears and, as a
   * reject does, the family goes back to `revertFamilyCode`, the published revision's feature set
   * or the Market default for a product never published. The working copy keeps the pending
   * content, so nothing is lost. Records `catalog.product-type-changed.v1`, then
   * `catalog.product-family-changed.v1` when the family went back. The use case writes the working
   * copy's axes and the variant's option values in the same unit.
   */
  addSizes(input: {
    readonly authorKind: AuthorKind;
    readonly replacePending: boolean;
    /** The feature set the product goes back to when a pending revision is superseded. */
    readonly revertFamilyCode: string;
    readonly now: Temporal.Instant;
  }): Result<
    {
      readonly variantId: Id<'Variant'>;
      readonly supersededRevisionId: Id<'ProductRevision'> | null;
    },
    ProductRefusal
  > {
    const checked = this.checkAddSizes(input);
    if (!checked.ok) return checked;
    const state = this.#state;
    const live = this.liveVariants;
    const variant = live[0];
    // A Simple product has exactly one variant and keeps it while it can be edited (M-9).
    if (live.length !== 1 || variant === undefined) {
      throw new Error('Product.addSizes: a Simple product must hold exactly one live variant');
    }
    const superseded = state.pendingRevisionId;
    if (superseded !== null && !FAMILY_CODE.test(input.revertFamilyCode)) {
      return err({ code: 'product.family-invalid' });
    }
    const familyReverted = superseded !== null && input.revertFamilyCode !== state.familyCode;
    this.#applyRecords(
      input.now,
      {
        typeCode: configurableProductType.typeCode,
        variantModel: configurableProductType.variantModel,
        ...(superseded === null
          ? {}
          : {
              familyCode: input.revertFamilyCode,
              pendingRevisionId: null,
              pendingSubmittedAt: null,
            }),
      },
      [
        {
          definition: ProductTypeChanged,
          payload: {
            productId: state.id,
            scope: eventScope(state.scope),
            fromTypeCode: 'simple',
            toTypeCode: 'configurable',
            variantId: variant.id,
            publishedRevisionId: state.publishedRevisionId,
          },
        },
        ...(familyReverted
          ? [
              {
                definition: ProductFamilyChanged,
                payload: {
                  productId: state.id,
                  revisionId: superseded,
                  scope: eventScope(state.scope),
                },
              },
            ]
          : []),
      ],
    );
    return ok({ variantId: variant.id, supersededRevisionId: superseded });
  }

  /**
   * `draft` to `discarded` (catalog design 4.1; terminal): the row stays, every non-retired
   * variant is retired and announced, one event each, in creation order. Only a draft that was
   * never submitted can be discarded.
   */
  discard(now: Temporal.Instant): Result<void, ProductRefusal> {
    if (this.#state.status !== 'draft') return err({ code: 'product.not-a-draft' });
    const live = this.liveVariants;
    this.#apply(
      now,
      {
        status: 'discarded',
        discardedAt: now,
        variants: this.#retire(
          this.#state.variants,
          live.map((variant) => variant.id),
          now,
        ),
      },
      live.map((variant) => ({ definition: VariantRemoved, variantId: variant.id })),
    );
    return ok(undefined);
  }

  /**
   * The seller's mark that the product carries their own brand (attributes A5, closing #552's
   * open point): it lets the seller propose a brand. SELLER products only, and not once the
   * product has ended (`discarded`, `withdrawn`, `retired`). Setting the value it already has
   * changes nothing and returns `false`; the caller writes only when this returns `true`.
   */
  setOwnBrand(input: {
    readonly ownBrand: boolean;
    readonly now: Temporal.Instant;
  }): Result<boolean, ProductRefusal> {
    const state = this.#state;
    if (state.scope !== 'SELLER') return err({ code: 'product.seller-only' });
    if (
      state.status === 'discarded' ||
      state.status === 'withdrawn' ||
      state.status === 'retired'
    ) {
      return err({ code: 'product.not-editable' });
    }
    if (state.ownBrand === input.ownBrand) return ok(false);
    this.#applyRecords(input.now, { ownBrand: input.ownBrand }, []);
    return ok(true);
  }

  /**
   * The admin pause (catalog design 4.1a): a `published` product that is not paused gets the mark
   * `pausedAt` with the admin's account id and `catalog.product-paused.v1`. The status stays
   * `published`; the use case adds the Offer cause `product-paused` in the same unit.
   */
  pause(input: {
    readonly accountId: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): Result<void, ProductRefusal> {
    const state = this.#state;
    if (state.status !== 'published') return err({ code: 'product.not-published' });
    if (state.pausedAt !== null) return err({ code: 'product.already-paused' });
    this.#applyRecords(input.now, { pausedAt: input.now, pausedByAccountId: input.accountId }, [
      { definition: ProductPaused, payload: { productId: state.id } },
    ]);
    return ok(undefined);
  }

  /** The admin resume (design 4.1a): the mark is cleared and `catalog.product-resumed.v1` recorded. */
  resume(input: { readonly now: Temporal.Instant }): Result<void, ProductRefusal> {
    const state = this.#state;
    if (state.pausedAt === null) return err({ code: 'product.not-paused' });
    this.#applyRecords(input.now, { pausedAt: null, pausedByAccountId: null }, [
      { definition: ProductResumed, payload: { productId: state.id } },
    ]);
    return ok(undefined);
  }

  /**
   * `unpublished` or `published` to `withdrawn` (design 4.1; terminal; SELLER products only; a
   * paused product can be withdrawn). The pending revision is set aside (its pointer clears, so
   * a reviewer with the page open gets `review.not-current-revision`), the pause mark clears and
   * `catalog.product-withdrawn.v1` is recorded. Revisions stay; the use case deletes the Offer.
   */
  withdraw(input: { readonly now: Temporal.Instant }): Result<void, ProductRefusal> {
    const state = this.#state;
    if (state.scope !== 'SELLER') return err({ code: 'product.seller-only' });
    if (state.status !== 'unpublished' && state.status !== 'published') {
      return err({ code: 'product.not-withdrawable' });
    }
    this.#applyRecords(
      input.now,
      {
        status: 'withdrawn',
        withdrawnAt: input.now,
        pausedAt: null,
        pausedByAccountId: null,
        pendingRevisionId: null,
        pendingSubmittedAt: null,
      },
      [{ definition: ProductWithdrawn, payload: { productId: state.id } }],
    );
    return ok(undefined);
  }

  /**
   * `published` to `retired` (design 4.1; CAT-48; terminal; PLATFORM products only; a paused
   * product can be retired). The pause mark clears and `catalog.product-retired.v1` is recorded;
   * the use case gives every Offer the cause `product-retired`.
   */
  retire(input: { readonly now: Temporal.Instant }): Result<void, ProductRefusal> {
    const state = this.#state;
    if (state.scope !== 'PLATFORM') return err({ code: 'product.platform-only' });
    if (state.status !== 'published') return err({ code: 'product.not-published' });
    this.#applyRecords(
      input.now,
      { status: 'retired', retiredAt: input.now, pausedAt: null, pausedByAccountId: null },
      [{ definition: ProductRetired, payload: { productId: state.id } }],
    );
    return ok(undefined);
  }

  #retire(
    variants: readonly VariantRecord[],
    ids: readonly Id<'Variant'>[],
    now: Temporal.Instant,
  ): readonly VariantRecord[] {
    return variants.map((variant) =>
      ids.includes(variant.id) ? { ...variant, state: 'retired', retiredAt: now } : variant,
    );
  }

  /**
   * Applies a change and records its events. The version rises by the number of events, or by
   * one when there is none (a stored product), and the n-th new event carries the n-th version,
   * so the outbox's unique `(aggregate, version)` holds (Q-K3). A new product starts at 1.
   */
  #apply(
    now: Temporal.Instant,
    changes: Partial<ProductState>,
    events: readonly {
      readonly definition: typeof VariantAdded | typeof VariantRemoved;
      readonly variantId: Id<'Variant'> | undefined;
    }[],
  ): void {
    this.#applyRecords(
      now,
      changes,
      events
        .filter((event) => event.variantId !== undefined)
        .map((event) => ({
          definition: event.definition,
          payload: { productId: this.#state.id, variantId: event.variantId as Id<'Variant'> },
        })),
    );
  }

  #applyRecords(
    now: Temporal.Instant,
    changes: Partial<ProductState>,
    records: readonly DomainEventRecord[],
  ): void {
    const base = this.#persistedVersion ?? 0;
    for (const record of records) {
      this.#events.push(
        record.definition.record({
          aggregateId: this.#state.id,
          aggregateVersion: base + this.#events.length + 1,
          occurredAt: now,
          payload: record.payload as never,
        }),
      );
    }
    const version =
      this.#events.length > 0
        ? base + this.#events.length
        : this.#persistedVersion === null
          ? 1
          : base + 1;
    this.#state = Object.freeze({ ...this.#state, ...changes, lastChangedAt: now, version });
  }
}

/**
 * The variant code of a product's variant: `{productCode}-{nn}` (e.g. MP-004127-02). The number is
 * zero-padded to two digits and grows beyond that only past 99. Read-only; derived, never stored.
 */
export function variantCodeOf(productCode: string, variantNo: number): string {
  return `${productCode}-${String(variantNo).padStart(2, '0')}`;
}

/**
 * The type guard of a revert (catalog design 4.2 row 6; M-9): a revert to an old revision whose
 * type is not the product's is refused, so a Configurable product never goes back to Simple
 * content. `revisionTypeCode` is the old revision's own `typeCode`, the product's the row's.
 *
 * TODO(revert use cases, design 4.2 row 6): `own-product.revert` and `platform-product.revert` do
 * not exist yet and nothing calls this. The first of them calls it before it writes anything and
 * answers `revision.revert-changes-type`; that code then joins the HTTP status maps
 * (`PLATFORM_PRODUCT_STATUS`) with a use-case test.
 */
export function revertTypeRefusal(
  productTypeCode: ProductTypeCode,
  revisionTypeCode: ProductTypeCode,
): ProductRefusal | null {
  return productTypeCode === revisionTypeCode ? null : { code: 'revision.revert-changes-type' };
}
