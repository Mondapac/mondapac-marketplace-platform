import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ProductTypeChangedAudit, scopeCode } from '../../domain/audit';
import type { Offer } from '../../domain/offer';
import type { AuthorKind, Product, ProductRefusal } from '../../domain/product';
import { ADD_SIZES_LIMITS, rateVerdict } from '../../domain/rate-limits';
import { configurableProductType } from '../../domain/product-types/configurable';
import { chooseAxes } from '../../domain/variant-axes';
import {
  WORKING_COPY_CONTENT_SCHEMA_VERSION,
  withSizes,
  workingContentOfRevision,
  type WorkingCopy,
} from '../../domain/working-copy';
import type { ProductFamilyResolver } from '../attributes/product-family-resolver';
import type {
  AllowedProductTypes,
  AllowedProductTypesReader,
} from '../ports/allowed-product-types.reader';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnOfferFinder } from '../ports/own-offer-finder';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { LIFECYCLE_TIMEOUT_MS, offersOfProduct, saveOffer } from './product-lifecycle';

/** The request, parsed: what the page read and chose. */
export interface AddSizesInput {
  readonly productId: Id<'Product'>;
  /** The product `version` the page read. */
  readonly version: number;
  /** The option attributes the product varies on (1 to `maxVariantAttributes`). */
  readonly axes: readonly string[];
  /** One option code per axis, for the product's one existing variant. */
  readonly optionValues: Readonly<Record<string, string>>;
  /** The page showed the warning that a pending revision is set aside. */
  readonly replacePending: boolean;
  /** PLATFORM only: the number of other sellers' Offers the confirm showed going off sale. */
  readonly offOfferCount: number | null;
}

export interface AddSizesOutput {
  readonly productId: Id<'Product'>;
  readonly variantId: Id<'Variant'>;
  /** The product version after the change. */
  readonly version: number;
  /** The Offers that went off sale for a type their seller may not sell (PLATFORM; else 0). */
  readonly offOfferCount: number;
  /** The pending revision that was set aside, or null. */
  readonly supersededRevisionId: Id<'ProductRevision'> | null;
}

export interface AddSizesImpact {
  readonly productId: Id<'Product'>;
  readonly version: number;
  /** The Offers of other sellers whose allowed types exclude `configurable`. */
  readonly offOfferCount: number;
}

export type AddSizesFailure =
  | ProductRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'product-type.not-allowed' }
  | { readonly code: 'revision.schema-unavailable' }
  | { readonly code: 'confirm.count-changed'; readonly currentCount: number }
  | { readonly code: 'conflict.stale' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface AddSizesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly offers: OfferRepository;
  readonly offerFinder: OwnOfferFinder;
  readonly attributes: AttributeRepository;
  readonly familyResolver: ProductFamilyResolver;
  readonly policy: CatalogMarketPolicy;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

type Author =
  | { readonly kind: 'seller'; readonly accountId: Id<'Account'>; readonly sellerId: Id<'Seller'> }
  | { readonly kind: 'admin'; readonly accountId: Id<'Account'> };

/** What the read before the unit learned: who to ask SEL-12 about. */
interface Prepared {
  readonly ownerSellerId: Id<'Seller'> | null;
  /** The sellers with a non-deleted Offer on a PLATFORM product, sorted. */
  readonly offerSellerIds: readonly Id<'Seller'>[];
}

const CONFIGURABLE = configurableProductType.typeCode;

/**
 * Add sizes (catalog design 4.2a, 2.3 M-9; variants V9; CAT-10 change): an internal service of
 * `own-product.add-sizes` and `platform-product.add-sizes`, which declare the access rule around
 * it. A Simple product becomes Configurable, once and never back; the guards answer in the order
 * of 4.2a, the first failure first:
 *
 * 1. the product is the actor's (seller) or a PLATFORM one (admin) and has not ended
 *    (`product.not-found`, `product.not-editable`); 2. it is Simple (`product.not-simple`);
 * 3. a pending revision needs `replacePending` (`revision.pending-exists`) (1 to 3 are the
 *    aggregate's `checkAddSizes`); 4. the Market lists `configurable` and, for a SELLER product,
 *    its owner may sell it (SEL-12, read before the unit, fail closed: `product-type.not-allowed`,
 *    `access.unavailable`); 5. the axes pass `chooseAxes` against the feature set the working
 *    copy's primary category holds now, and the option values are options of those axes
 *    (`validation.failed`); 6. PLATFORM: the Offers of other sellers who may not sell
 *    `configurable` number what the confirm showed (`confirm.count-changed`); 7. the version
 *    matches (`conflict.stale`).
 *
 * The attempt is counted first (20 per account per hour). The write is one unit, product row
 * first and the Offers after it (the lock order of every publish): the aggregate changes, the
 * working copy (made from the published revision when there is none) gets the axes and the
 * variant's option values, a superseded pending revision's tag set is cleared (SELLER), every
 * Offer of a seller who may not sell `configurable` gets the cause `type-not-allowed` (PLATFORM;
 * the sellers set is read again after the lock, a difference is `conflict.stale`), the events and
 * the audit row are written.
 */
export class AddSizes {
  readonly #logger = new Logger('AddSizes');

  constructor(private readonly deps: AddSizesDependencies) {}

  async execute(
    context: CallContext,
    input: AddSizesInput,
  ): Promise<Result<AddSizesOutput, AddSizesFailure>> {
    const result = await this.#execute(context, input);
    this.#logger.log({
      msg: 'catalog.add-sizes',
      code: result.ok ? 'changed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  /**
   * The Offers that would go off sale (design 4.2a, the admin confirm): the same read the command
   * makes before its unit, without the limit and without any write. PLATFORM products only.
   */
  async impact(
    context: CallContext,
    productId: Id<'Product'>,
  ): Promise<Result<AddSizesImpact, AddSizesFailure>> {
    const author = authorOf(context);
    if (author === null || author.kind !== 'admin') return err({ code: 'access.denied' });
    const { market } = context;
    const read = await this.deps.unitOfWork.run<
      { readonly product: Product; readonly prepared: Prepared },
      AddSizesFailure
    >(
      market,
      async () => {
        const product = await this.deps.products.findById(market, productId);
        if (product === null) return err({ code: 'product.not-found' as const });
        if (product.state.scope !== 'PLATFORM')
          return err({ code: 'product.seller-only' as const });
        return ok({ product, prepared: await this.#prepare(context, product) });
      },
      { readOnly: true },
    );
    if (!read.ok) return err(read.error);
    const notAllowed = await this.#sellersWithoutConfigurable(context, read.value.prepared);
    if (!notAllowed.ok) return notAllowed;
    const offers = await this.deps.unitOfWork.run(
      market,
      async () => ok(await offersOfProduct(this.deps.offers, market, productId)),
      { readOnly: true },
    );
    if (!offers.ok) return err({ code: 'access.unavailable' });
    return ok({
      productId,
      version: read.value.product.state.version,
      offOfferCount: offers.value.filter((offer) => notAllowed.value.has(offer.state.sellerId))
        .length,
    });
  }

  async #execute(
    context: CallContext,
    input: AddSizesInput,
  ): Promise<Result<AddSizesOutput, AddSizesFailure>> {
    const author = authorOf(context);
    if (author === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;

    const throttled = await this.#reserve(context, author.accountId);
    if (throttled !== null) return err(throttled);

    let maxAxes: number;
    let marketTypes: readonly string[];
    try {
      maxAxes = deps.policy.maxVariantAttributes(market);
      marketTypes = deps.policy.productTypes(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }

    // Guards 1 to 3 on a read-only snapshot, so a refusal answers before anything else is asked.
    const first = await deps.unitOfWork.run<
      { readonly product: Product; readonly prepared: Prepared },
      AddSizesFailure
    >(
      market,
      async () => {
        const product = await this.#load(market, input.productId, author);
        if (!product.ok) return product;
        const checked = product.value.checkAddSizes({
          authorKind: author.kind,
          replacePending: input.replacePending,
        });
        if (!checked.ok) return err(checked.error);
        return ok({
          product: product.value,
          prepared: await this.#prepare(context, product.value),
        });
      },
      { readOnly: true },
    );
    if (!first.ok) return first;

    // Guard 4: the Market lists the type; SEL-12 for the owner, read outside any unit.
    if (!marketTypes.includes(CONFIGURABLE)) return err({ code: 'product-type.not-allowed' });
    const { prepared } = first.value;
    if (prepared.ownerSellerId !== null) {
      const allowed = await deps.allowedTypes.allowedFor(context, prepared.ownerSellerId);
      if (allowed === null) return err({ code: 'access.unavailable' });
      if (!allows(allowed)) return err({ code: 'product-type.not-allowed' });
    }
    // PLATFORM: SEL-12 of every seller with an Offer, fail closed, before the unit.
    const notAllowed = await this.#sellersWithoutConfigurable(context, prepared);
    if (!notAllowed.ok) return notAllowed;

    try {
      return await deps.unitOfWork.run<AddSizesOutput, AddSizesFailure>(
        market,
        async () => {
          const loaded = await this.#load(market, input.productId, author);
          if (!loaded.ok) return loaded;
          const product = loaded.value;
          const checked = product.checkAddSizes({
            authorKind: author.kind,
            replacePending: input.replacePending,
          });
          if (!checked.ok) return err(checked.error);
          const state = product.state;
          const variantId = product.liveVariants[0]?.id;
          if (variantId === undefined) return err({ code: 'product.not-simple' as const });

          const copy = await deps.workingCopies.find(market, state.id);
          const publishedId = state.publishedRevisionId;
          const published =
            publishedId === null ? null : await deps.revisions.find(market, state.id, publishedId);
          if (publishedId !== null && published === null) return err({ code: 'conflict.stale' });
          const now = deps.clock.now();
          const base: Record<string, unknown> =
            copy !== null
              ? { ...copy.content }
              : published !== null
                ? workingContentOfRevision(published.content)
                : {};
          const content = withSizes(base, {
            variantId,
            axes: input.axes,
            optionValues: input.optionValues,
          });

          // Guard 5: the axes and the option values, against the feature set the working copy's
          // primary category holds now (as the freeze resolves it).
          const valid = await this.#checkAxes(market, product, content, input, maxAxes);
          if (!valid.ok) return valid;

          // Guard 6 (PLATFORM): lock the product, read the Offer sellers again, compare counts.
          let targets: readonly Offer[] = [];
          let platformOfferCount = 0;
          if (author.kind === 'admin') {
            if (!(await deps.products.lockAtVersion(market, state.id, state.version))) {
              return err({ code: 'conflict.stale' });
            }
            const offers = await offersOfProduct(deps.offers, market, state.id);
            const sellers = [...new Set(offers.map((offer) => offer.state.sellerId))].sort();
            if (!sameList(sellers, prepared.offerSellerIds)) return err({ code: 'conflict.stale' });
            platformOfferCount = offers.length;
            targets = offers.filter((offer) => notAllowed.value.has(offer.state.sellerId));
            if (targets.length !== input.offOfferCount) {
              return err({ code: 'confirm.count-changed', currentCount: targets.length });
            }
          }
          // Guard 7.
          if (state.version !== input.version) return err({ code: 'conflict.stale' });

          // The family goes back to the accepted state when a pending revision is set aside.
          let revertFamilyCode = deps.policy.defaultFamily(market);
          if (published !== null) {
            const code = await deps.attributes.familyCodeOfRevision(
              market,
              published.content.schemaRef.familyRevisionId,
            );
            if (code === null) return err({ code: 'conflict.stale' });
            revertFamilyCode = code;
          }
          const changed = product.addSizes({
            authorKind: author.kind,
            replacePending: input.replacePending,
            revertFamilyCode,
            now,
          });
          if (!changed.ok) return err(changed.error);
          const { supersededRevisionId } = changed.value;

          // The product row first, then its Offers (the lock order of every publish).
          await deps.products.save(market, product);
          const savedCopy: WorkingCopy = {
            productId: state.id,
            content,
            contentSchemaVersion: copy?.contentSchemaVersion ?? WORKING_COPY_CONTENT_SCHEMA_VERSION,
            baseRevisionId: copy !== null ? copy.baseRevisionId : publishedId,
            lastSavedAt: now,
            lastSavedByAccountId: author.accountId,
          };
          await deps.workingCopies.save(market, savedCopy);
          await deps.outbox.append(context, product.pendingEvents);

          let offerCount = platformOfferCount;
          if (author.kind === 'seller') {
            const offer = await deps.offerFinder.findOwnOnProduct(
              market,
              author.sellerId,
              state.id,
            );
            offerCount = offer === null ? 0 : 1;
            if (offer !== null && supersededRevisionId !== null && publishedId === null) {
              // A later submit with no requested tags clears the tag set of a never-published
              // product's pending revision (`own-product.submit`); so does setting it aside.
              const cleared = this.#clearPendingTags(offer, author, now);
              if (!cleared.ok) return cleared;
              await saveOffer(deps, context, offer, author.accountId);
            }
          } else {
            for (const offer of targets) {
              offer.changeCauses({ add: ['type-not-allowed'], now });
              await saveOffer(deps, context, offer, author.accountId);
            }
          }
          await deps.audit.record(
            context,
            ProductTypeChangedAudit.entry(state.id, {
              before: { typeCode: 'simple' },
              after: {
                typeCode: 'configurable',
                scope: scopeCode(state.scope),
                offerCount,
                offOfferCount: targets.length,
                axisCount: input.axes.length,
              },
            }),
          );
          return ok({
            productId: state.id,
            variantId,
            version: product.state.version,
            offOfferCount: targets.length,
            supersededRevisionId,
          });
        },
        author.kind === 'admin' ? { timeoutMs: LIFECYCLE_TIMEOUT_MS } : undefined,
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }

  /** The product, for this author only: another seller's, a PLATFORM one and a missing one are alike. */
  async #load(
    market: CallContext['market'],
    productId: Id<'Product'>,
    author: Author,
  ): Promise<Result<Product, AddSizesFailure>> {
    const product = await this.deps.products.findById(market, productId);
    if (product === null) return err({ code: 'product.not-found' });
    if (
      author.kind === 'seller' &&
      (product.state.scope !== 'SELLER' || product.state.ownerSellerId !== author.sellerId)
    ) {
      return err({ code: 'product.not-found' });
    }
    return ok(product);
  }

  /** Who SEL-12 must be asked about: the owner of a SELLER product, the Offer sellers of a PLATFORM one. */
  async #prepare(context: CallContext, product: Product): Promise<Prepared> {
    const { state } = product;
    if (state.scope === 'SELLER') {
      return { ownerSellerId: state.ownerSellerId, offerSellerIds: [] };
    }
    const offers = await offersOfProduct(this.deps.offers, context.market, state.id);
    return {
      ownerSellerId: null,
      offerSellerIds: [...new Set(offers.map((offer) => offer.state.sellerId))].sort(),
    };
  }

  /** The Offer sellers whose allowed types leave out `configurable`; an error refuses (fail closed). */
  async #sellersWithoutConfigurable(
    context: CallContext,
    prepared: Prepared,
  ): Promise<Result<ReadonlySet<Id<'Seller'>>, AddSizesFailure>> {
    const refused = new Set<Id<'Seller'>>();
    for (const sellerId of prepared.offerSellerIds) {
      const allowed = await this.deps.allowedTypes.allowedFor(context, sellerId);
      if (allowed === null) return err({ code: 'access.unavailable' });
      if (!allows(allowed)) refused.add(sellerId);
    }
    return ok(refused);
  }

  /** Guard 5. Issue codes are the freeze's (`variants.axes-*`, `variants.option-*`). */
  async #checkAxes(
    market: CallContext['market'],
    product: Product,
    content: Readonly<Record<string, unknown>>,
    input: AddSizesInput,
    maxAxes: number,
  ): Promise<Result<void, AddSizesFailure>> {
    const rawCategories = content['categoryIds'];
    const primaryCategoryId =
      Array.isArray(rawCategories) && typeof rawCategories[0] === 'string'
        ? rawCategories[0]
        : null;
    const resolved = await this.deps.familyResolver.resolve(market, primaryCategoryId);
    if (!resolved.ok) return err({ code: 'revision.schema-unavailable' });
    const schema = await this.deps.attributes.loadSchema(market, resolved.familyCode);
    if (schema === null) return err({ code: 'revision.schema-unavailable' });
    // The axes are not locked until a Configurable revision publishes (M-8).
    const chosen = chooseAxes(schema, input.axes, maxAxes, null);
    const moved = resolved.familyCode !== product.state.familyCode;
    const fields: { path: string; code: string }[] = [];
    const named = (code: string): string =>
      moved && (code === 'variants.axes-unknown' || code === 'variants.option-unknown')
        ? 'variants.option-not-in-family'
        : code;
    if (!chosen.ok) {
      fields.push(...chosen.issues.map((issue) => ({ path: issue.path, code: named(issue.code) })));
    } else {
      const maxVariants = this.deps.policy.maxVariantsPerProduct(market);
      const variants = configurableProductType.validateVariants(
        chosen.schema,
        [{ optionValues: input.optionValues }],
        maxVariants,
        maxAxes,
      );
      if (!variants.ok) {
        fields.push(
          ...variants.issues.map((issue) => ({
            path: issue.path === 'variants' ? 'variantAxes' : 'optionValues',
            code: named(issue.code),
          })),
        );
      }
    }
    return fields.length === 0 ? ok(undefined) : err({ code: 'validation.failed', fields });
  }

  /** Clears the `pending-publish` tags of the Offer when the pending revision is set aside. */
  #clearPendingTags(
    offer: Offer,
    author: Extract<Author, { kind: 'seller' }>,
    now: Temporal.Instant,
  ): Result<void, AddSizesFailure> {
    if (!offer.tags.some((tag) => tag.status === 'pending-publish')) return ok(undefined);
    const cleared = offer.dropPendingPublishTags({
      actor: { kind: 'seller', accountId: author.accountId },
      now,
    });
    // Nothing was asked, so only a tag in another state than `pending-publish` can refuse.
    return cleared.ok ? ok(undefined) : err({ code: 'conflict.stale' });
  }

  /** Counts the attempt (20 per account per hour); a store that cannot answer refuses. */
  async #reserve(
    context: CallContext,
    accountId: Id<'Account'>,
  ): Promise<
    | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
    | { readonly code: 'access.unavailable' }
    | null
  > {
    const { market } = context;
    try {
      const counters = ADD_SIZES_LIMITS.map((limit) => ({
        limit,
        keyHash: this.deps.counterKeys.keyOf(market, limit.kind, accountId),
      }));
      const now = this.deps.clock.now();
      const reserved = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.counters.reserve(market, counters, now)),
      );
      if (!reserved.ok) return { code: 'access.unavailable' };
      const verdict = rateVerdict(ADD_SIZES_LIMITS, reserved.value, now);
      if (verdict.allowed) return null;
      this.#logger.warn({
        msg: 'catalog.request-throttled',
        kinds: ADD_SIZES_LIMITS.map((limit) => limit.kind),
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
    } catch {
      this.#logger.error({
        msg: 'catalog.rate-counters-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { code: 'access.unavailable' };
    }
  }
}

/** The author kind from the actor's population; a seller actor without a seller id is nobody. */
function authorOf(context: CallContext): (Author & { readonly kind: AuthorKind }) | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated') return null;
  if (actor.population === 'seller') {
    return actor.sellerId === null
      ? null
      : { kind: 'seller', accountId: actor.accountId, sellerId: actor.sellerId };
  }
  if (actor.population === 'admin') return { kind: 'admin', accountId: actor.accountId };
  return null;
}

const allows = (allowed: AllowedProductTypes): boolean =>
  allowed === 'all' || allowed.has(CONFIGURABLE);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** A request id as the use cases take it; anything that is not an id is the same `product.not-found`. */
export function addSizesProductId(value: unknown): Id<'Product'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'Product'>(value);
  return parsed.ok ? parsed.value : null;
}

/** The closed request body of Add sizes, parsed; `platform` adds the confirmed Offer count. */
export function parseAddSizesRequest(
  raw: unknown,
  platform: boolean,
): Result<Omit<AddSizesInput, 'productId'>, AddSizesFailure> {
  const fail = (path: string, code: string): Result<never, AddSizesFailure> =>
    err({ code: 'validation.failed', fields: [{ path, code }] });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('body', 'type');
  const body = raw as Record<string, unknown>;
  const { version, axes, optionValues, replacePending, offOfferCount } = body;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return fail('version', 'range');
  }
  if (!Array.isArray(axes) || axes.length > MAX_REQUEST_ENTRIES) return fail('axes', 'type');
  if (!axes.every((code) => typeof code === 'string' && CODE.test(code)))
    return fail('axes', 'format');
  if (typeof optionValues !== 'object' || optionValues === null || Array.isArray(optionValues)) {
    return fail('optionValues', 'type');
  }
  const entries = Object.entries(optionValues);
  if (entries.length > MAX_REQUEST_ENTRIES) return fail('optionValues', 'too-many');
  if (
    !entries.every(
      ([code, value]) =>
        CODE.test(code) && !RESERVED.has(code) && typeof value === 'string' && CODE.test(value),
    )
  ) {
    return fail('optionValues', 'format');
  }
  if (typeof replacePending !== 'boolean') return fail('replacePending', 'type');
  let confirmed: number | null = null;
  if (platform) {
    if (
      typeof offOfferCount !== 'number' ||
      !Number.isSafeInteger(offOfferCount) ||
      offOfferCount < 0
    ) {
      return fail('offOfferCount', 'range');
    }
    confirmed = offOfferCount;
  } else if (offOfferCount !== undefined) {
    return fail('offOfferCount', 'unknown-field');
  }
  return ok({
    version,
    axes: axes as string[],
    optionValues: Object.fromEntries(entries as [string, string][]),
    replacePending,
    offOfferCount: confirmed,
  });
}

/** An attribute or option code as a request may carry it: bounded, no free text. */
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
/** More axes or values than any Market allows is refused before the Market's own limit speaks. */
const MAX_REQUEST_ENTRIES = 16;
