import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  ContentHash,
  Id,
  IdGenerator,
  Result,
} from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Product, ProductRefusal } from '../../domain/product';
import { classify, decideOutcome } from '../../domain/product-revision-policy';
import type { RevisionContent } from '../../domain/revision-content';
import { revisionTextsOf, summaryOf } from '../../domain/revision-texts';
import type { StoredRevision } from '../../domain/stored-revision';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import { refusalOf, type RefusedField } from '../working-copy/save-draft.service';
import type { FreezeRevision, FreezeRevisionFailure } from './freeze-revision.service';

export interface SubmitProductInput {
  readonly productId: Id<'Product'>;
  /** The client saw the warning that a pending revision is replaced (brief s4 d 1). */
  readonly replacePending: boolean;
  /**
   * The id the revision takes when it is stored, minted by the caller before its claim asks so
   * the queries name the frozen revision being submitted (design 5.1a point 1). Minted here when
   * absent.
   */
  readonly revisionId?: Id<'ProductRevision'>;
  /** A seller's claim asks of this submit (design 4.2 row 1, 5.1a); none for an admin. */
  readonly claims?: SubmitClaims;
}

/** The frozen revision being submitted, as the claim steps see it. */
export interface FrozenSubmission {
  readonly product: Product;
  readonly revisionId: Id<'ProductRevision'>;
  readonly content: RevisionContent;
}

/**
 * The claim steps of a seller's submit (design 4.2 row 1; 5.1a points 1, 4, 6): `ask` runs after
 * the claim-text check, outside any unit (it opens its own read-only unit and calls the facade);
 * `settle` runs in the write unit, after the content was frozen again and found equal, before
 * the product is stored. Either refuses the whole submit; `claim.inputs-changed` from `settle`
 * means a lost race, and the caller submits again.
 */
export interface SubmitClaims {
  ask(frozen: FrozenSubmission): Promise<Result<void, SubmitProductFailure>>;
  settle(frozen: FrozenSubmission): Promise<Result<void, SubmitProductFailure>>;
}

/** Per type the `ClaimReason` code of its first refused variant (CUX 3.7). */
type TagReasons = readonly { readonly typeCode: string; readonly reason: string }[];

export interface SubmitProductOutput {
  readonly revisionId: Id<'ProductRevision'>;
  readonly revisionNo: number;
  readonly published: boolean;
}

export type SubmitProductFailure =
  | FreezeRevisionFailure
  | ProductRefusal
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'working-copy.not-found' }
  | { readonly code: 'working-copy.invalid-content' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | { readonly code: 'offer.handling-missing' }
  | { readonly code: 'claim.requested-tag-not-allowed'; readonly tags: TagReasons }
  | { readonly code: 'claim.tags-would-be-lost'; readonly tags: TagReasons }
  | { readonly code: 'claim.check-unavailable' }
  | { readonly code: 'claim.inputs-changed' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface SubmitProductDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly freeze: FreezeRevision;
  readonly check: CheckClaimText;
  readonly policy: CatalogMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The submit of a product's working copy (catalog design 4.2 row 1; slice 6): an internal service
 * that `platform-product.submit` declares its access rule around (`own-product.submit` joins in
 * slice 7, with `sellingEligibility` and the owner's claim asks). Everything that decides what is
 * stored comes from stored state and Market configuration, never from the request.
 *
 * 1. Before the write unit, in a read-only unit (ADR-0025): load the product and its working copy,
 *    freeze them, and run the claim-text check over **every** text of the frozen content (not only
 *    what changed since the last save: the vocabulary can have grown). A text that matches, holds a
 *    hidden character or cannot be checked refuses the submit with the list of fields.
 * 2. In the write unit: load both again and freeze again; the frozen `contentHash` must equal the
 *    one that was checked, else `conflict.stale` (the draft changed in between). Then classify the
 *    revision against the published one, read `catalog.approval-required`, decide the outcome,
 *    store the revision and the product, and append the events, all in one unit. A lost race on
 *    the product or on the revision number is `conflict.stale`.
 *
 * The author is the actor's population: an admin submits PLATFORM products, a seller submits their
 * own SELLER products (`own-product.submit` adds eligibility and SEL-12 around this). A seller's
 * revision may wait for review (4.3). Images are refused by the revision store until slice 13.
 */
export class SubmitProduct {
  readonly #logger = new Logger('SubmitProduct');

  constructor(private readonly deps: SubmitProductDependencies) {}

  async execute(
    context: CallContext,
    input: SubmitProductInput,
  ): Promise<Result<SubmitProductOutput, SubmitProductFailure>> {
    const { actor } = context;
    // The author is the actor's population and nothing else (an admin or a seller with a seller id).
    const author: Author | null =
      actor.kind !== 'authenticated'
        ? null
        : actor.population === 'admin'
          ? { kind: 'admin' }
          : actor.population === 'seller' && actor.sellerId !== null
            ? { kind: 'seller', sellerId: actor.sellerId }
            : null;
    if (actor.kind !== 'authenticated' || author === null) {
      return err({ code: 'access.denied' });
    }
    const { market } = context;
    const { unitOfWork, products, revisions, freeze, check, policy } = this.deps;

    let locales: { readonly default: string; readonly supported: readonly string[] };
    let maxVariants: number;
    let sensitiveChanges: ReturnType<CatalogMarketPolicy['sensitiveChanges']>;
    try {
      locales = policy.locales(market);
      maxVariants = policy.maxVariantsPerProduct(market);
      sensitiveChanges = policy.sensitiveChanges(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }

    // 1. Freeze, in a read-only unit. The claim check below runs after this unit has closed:
    // units do not nest and the matcher opens its own (certification's note on #197).
    const first = await unitOfWork.run<
      {
        readonly product: Product;
        readonly content: RevisionContent;
        readonly contentHash: ContentHash;
      },
      SubmitProductFailure
    >(
      market,
      async () => {
        const loaded = await this.#load(context, input, author);
        if (!loaded.ok) return loaded;
        const frozen = await freeze.freeze(market, loaded.value.product, loaded.value.copy);
        if (!frozen.ok) return frozen;
        return ok({
          product: loaded.value.product,
          content: frozen.value.content,
          contentHash: frozen.value.contentHash,
        });
      },
      { readOnly: true },
    );
    if (!first.ok) return first;

    // Check every text of the frozen content, outside any unit.
    const texts = revisionTextsOf(first.value.content, locales.supported, locales.default);
    if (!texts.ok) return err(texts.error);
    const checked = await check.execute(
      context,
      texts.value.map(({ field, ref, locale, text }) => ({ field, ref, locale, text })),
    );
    if (!checked.ok) {
      return err(
        checked.error.code === 'validation.failed'
          ? { code: 'working-copy.invalid-content' as const }
          : checked.error.code === 'request.throttled'
            ? { code: 'access.unavailable' as const }
            : checked.error,
      );
    }
    // Anything that is not plainly clean refuses, so an unknown verdict can never pass.
    const refused = checked.value.flatMap((verdict) =>
      verdict.code === 'clean' ? [] : (refusalOf(verdict) ?? []),
    );
    if (checked.value.some((verdict) => verdict.code !== 'clean') && refused.length === 0) {
      return err({ code: 'working-copy.invalid-content' });
    }
    if (refused.length > 0) {
      this.#logger.warn({
        msg: 'catalog.submit-product.claim-text-refused',
        refusedFields: refused.length,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'claim-text.refused', fields: refused });
    }
    const checkedHash = first.value.contentHash;
    const revisionId = input.revisionId ?? this.deps.ids.next<'ProductRevision'>();

    // The seller's claim asks against the frozen revision, outside any unit (design 5.1a).
    if (input.claims !== undefined) {
      const asked = await input.claims.ask({
        product: first.value.product,
        revisionId,
        content: first.value.content,
      });
      if (!asked.ok) return asked;
    }

    // 2. Freeze again and store, in one unit.
    try {
      const stored = await unitOfWork.run<SubmitProductOutput, SubmitProductFailure>(
        market,
        async () => {
          const loaded = await this.#load(context, input, author);
          if (!loaded.ok) return loaded;
          const { product, copy } = loaded.value;
          const frozen = await freeze.freeze(market, product, copy);
          if (!frozen.ok) return frozen;
          if (frozen.value.contentHash !== checkedHash) return err({ code: 'conflict.stale' });
          const now = this.deps.clock.now();
          const publishedId = product.state.publishedRevisionId;
          const published =
            publishedId === null
              ? null
              : await revisions.find(market, product.state.id, publishedId);
          if (publishedId !== null && published === null) return err({ code: 'conflict.stale' });
          const classification = classify(
            published === null ? null : summaryOf(published.content),
            summaryOf(frozen.value.content),
            sensitiveChanges,
          );
          let approvalRequired: boolean;
          try {
            approvalRequired = await policy.approvalRequired(market);
          } catch {
            return err({ code: 'access.unavailable' });
          }
          let sensitiveRevisionPending = false;
          if (author.kind === 'seller' && product.state.pendingRevisionId !== null) {
            const pending = await revisions.find(
              market,
              product.state.id,
              product.state.pendingRevisionId,
            );
            if (pending === null) return err({ code: 'conflict.stale' });
            sensitiveRevisionPending = pending.sensitive;
          }
          const outcome = decideOutcome({
            classification,
            approvalRequired,
            sensitiveRevisionPending,
            author: author.kind === 'seller' ? 'seller' : 'admin-platform',
          });
          const revisionNo = await revisions.nextRevisionNo(market, product.state.id);
          const submitted = product.submitRevision({
            revisionId,
            baseRevisionId: publishedId,
            outcome,
            authorKind: author.kind,
            replacePending: input.replacePending,
            revisionVariantIds: frozen.value.content.variants.map(
              (variant) => variant.variantId as Id<'Variant'>,
            ),
            maxVariants,
            now,
          });
          if (!submitted.ok) return err(submitted.error);
          const revision: StoredRevision = {
            id: revisionId,
            productId: product.state.id,
            revisionNo,
            kind: 'submission',
            baseRevisionId: publishedId,
            revertedFromRevisionId: null,
            sensitive: outcome.sensitive,
            sensitiveReasons: outcome.reasons,
            contentHash: frozen.value.contentHash,
            authorKind: author.kind,
            authorAccountId: actor.accountId,
            actingAdminAccountId: null,
            submittedAt: now,
            content: frozen.value.content,
          };
          await revisions.add(market, revision);
          if (input.claims !== undefined) {
            const settled = await input.claims.settle({
              product,
              revisionId,
              content: frozen.value.content,
            });
            if (!settled.ok) return settled;
          }
          await products.save(market, product);
          await this.deps.outbox.append(context, product.pendingEvents);
          return ok({ revisionId, revisionNo, published: submitted.value.published });
        },
      );
      this.#logger.log({
        msg: 'catalog.submit-product',
        code: stored.ok ? (stored.value.published ? 'published' : 'pending') : stored.error.code,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return stored;
    } catch (error) {
      if (error instanceof StaleAggregateError) {
        this.#logger.warn({
          msg: 'catalog.submit-product.stale',
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return err({ code: 'conflict.stale' });
      }
      throw error;
    }
  }

  async #load(context: CallContext, input: SubmitProductInput, author: Author) {
    const { market } = context;
    const product = await this.deps.products.findById(market, input.productId);
    if (product === null) return err({ code: 'product.not-found' as const });
    if (author.kind === 'seller') {
      // A seller submits their own SELLER products; another seller's, a PLATFORM one and a
      // missing one answer alike, so the answer reveals nothing.
      if (product.state.scope !== 'SELLER' || product.state.ownerSellerId !== author.sellerId) {
        return err({ code: 'product.not-found' as const });
      }
    } else if (product.state.scope !== 'PLATFORM') {
      // An admin submits PLATFORM products only; the aggregate says so again at the submit.
      return err({ code: 'product.platform-admin-only' as const });
    }
    const copy = await this.deps.workingCopies.find(market, product.state.id);
    if (copy === null) return err({ code: 'working-copy.not-found' as const });
    return ok({ product, copy });
  }
}

type Author =
  { readonly kind: 'admin' } | { readonly kind: 'seller'; readonly sellerId: Id<'Seller'> };
