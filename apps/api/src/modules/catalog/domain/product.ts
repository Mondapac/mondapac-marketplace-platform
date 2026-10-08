import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Result, Temporal } from '@mondapac/shared-kernel';
import {
  ProductRevisionPublished,
  ProductRevisionSubmitted,
  VariantAdded,
  VariantRemoved,
} from './events';
import type { RevisionOutcome } from './product-revision-policy';
import type { ProductTypeCode, ProductTypeHandler, VariantModel } from './product-type-handler';

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
  | { readonly code: 'product.no-published-revision' };

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
    const variant: VariantRecord = {
      id: variantId,
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
   * price, so its removal is announced. A Simple product's variant is retired only by
   * {@link discard}; a published variant is retired by a publish (slice 11).
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
    const resolved = input.variantIds.map((id) => {
      if (id !== null) return id;
      const minted = input.newId();
      createdVariants.push({
        id: minted,
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
    const submitted = {
      definition: ProductRevisionSubmitted,
      payload: {
        productId: state.id,
        revisionId: input.revisionId,
        scope: eventScope(state.scope),
      },
    };
    if (input.outcome.outcome === 'pending') {
      this.#applyRecords(
        input.now,
        {
          status: state.status === 'draft' ? 'unpublished' : state.status,
          pendingRevisionId: input.revisionId,
          pendingSubmittedAt: input.now,
        },
        [submitted],
      );
      return ok({ published: false });
    }
    this.#publish(input.revisionId, input.revisionVariantIds, input.now, [submitted]);
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
    this.#publish(input.revisionId, input.revisionVariantIds, input.now, []);
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
    this.#publish(input.revisionId, held, input.now, [], true);
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
    now: Temporal.Instant,
    before: readonly { definition: typeof ProductRevisionSubmitted; payload: unknown }[],
    keepPending = false,
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
    records: readonly {
      readonly definition: {
        record(input: {
          aggregateId: Id;
          aggregateVersion: number;
          occurredAt: Temporal.Instant;
          payload: never;
        }): PendingEvent;
      };
      readonly payload: unknown;
    }[],
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
