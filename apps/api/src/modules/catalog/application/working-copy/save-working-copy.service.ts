import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { rateVerdict, DRAFT_SAVE_LIMITS } from '../../domain/rate-limits';
import type { AuthorKind, ProductRefusal } from '../../domain/product';
import {
  WORKING_COPY_CONTENT_SCHEMA_VERSION,
  isStorableContent,
  type WorkingCopy,
} from '../../domain/working-copy';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';

export interface SaveWorkingCopyInput {
  readonly productId: Id<'Product'>;
  /** Opaque JSON object; its schema validation belongs to the submit. */
  readonly content: unknown;
  /** The draft's variant list in order: an id the server minted, or null for a new variant. */
  readonly variantIds: readonly (Id<'Variant'> | null)[];
}

export interface SaveWorkingCopyOutput {
  readonly variantIds: readonly Id<'Variant'>[];
}

export type SaveWorkingCopyFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'product.not-found' }
  | { readonly code: 'working-copy.invalid-content' }
  | { readonly code: 'conflict.stale' }
  | ProductRefusal;

export interface SaveWorkingCopyDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly policy: CatalogMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The working-copy save (catalog design 4.2, slice 4c-3): an internal service, not a use case.
 * The use cases of slices 6 and 7 (`own-product.save-draft`, `platform-product.save-draft`)
 * declare their access rule and call it, so it carries no access declaration of its own but
 * still derives everything about the caller from the {@link CallContext}:
 *
 * 1. the author is the actor's population (`seller` or `admin`; anything else is
 *    `access.denied`); the request names no seller, Market or author kind;
 * 2. the saves limit is reserved before any work (60 a minute, 1,000 a day per account); a store
 *    that cannot answer refuses with `access.unavailable`, never a pass;
 * 3. one read-write unit loads the product, refuses a product that is not the seller's own with
 *    the same `product.not-found` as a missing one, applies the variant half to the aggregate
 *    (retirements and mints, with their events), stores the draft and the product, and appends
 *    the events in the same unit; a lost race on the product is `conflict.stale`.
 *
 * Concurrent saves of the same draft are last-write-wins on `content`: the product version only
 * moves when the variant registry changes.
 */
export class SaveWorkingCopy {
  readonly #logger = new Logger('SaveWorkingCopy');

  constructor(private readonly deps: SaveWorkingCopyDependencies) {}

  async execute(
    context: CallContext,
    input: SaveWorkingCopyInput,
  ): Promise<Result<SaveWorkingCopyOutput, SaveWorkingCopyFailure>> {
    const author = authorOf(context);
    if (author === null) return err({ code: 'access.denied' });
    if (!isStorableContent(input.content)) return err({ code: 'working-copy.invalid-content' });
    const content = input.content;

    const throttled = await this.#reserve(context, author.accountId);
    if (throttled !== null) return err(throttled);

    const { market } = context;
    const { unitOfWork, products, workingCopies, outbox, clock, ids } = this.deps;
    let maxVariants: number;
    try {
      maxVariants = this.deps.policy.maxVariantsPerProduct(market);
    } catch {
      this.#logger.error({
        msg: 'catalog.save-working-copy.policy-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }

    try {
      const saved = await unitOfWork.run<SaveWorkingCopyOutput, SaveWorkingCopyFailure>(
        market,
        async () => {
          const product = await products.findById(market, input.productId);
          if (product === null) return err({ code: 'product.not-found' } as const);
          if (author.kind === 'seller' && product.state.ownerSellerId !== author.sellerId) {
            return err({ code: 'product.not-found' } as const);
          }
          const now = clock.now();
          const result = product.saveWorkingCopy({
            authorKind: author.kind,
            variantIds: input.variantIds,
            maxVariants,
            newId: () => ids.next<'Variant'>(),
            now,
          });
          if (!result.ok) return err(result.error);
          const previous = await workingCopies.find(market, product.state.id);
          const copy: WorkingCopy = {
            productId: product.state.id,
            content,
            contentSchemaVersion: WORKING_COPY_CONTENT_SCHEMA_VERSION,
            baseRevisionId: previous?.baseRevisionId ?? null,
            lastSavedAt: now,
            lastSavedByAccountId: author.accountId,
          };
          await workingCopies.save(market, copy);
          await products.save(market, product);
          await outbox.append(context, product.pendingEvents);
          return ok(result.value);
        },
      );
      this.#logger.log({
        msg: 'catalog.save-working-copy',
        code: saved.ok ? 'saved' : saved.error.code,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return saved;
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }

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
      const counters = DRAFT_SAVE_LIMITS.map((limit) => ({
        limit,
        keyHash: this.deps.counterKeys.keyOf(market, limit.kind, accountId),
      }));
      const now = this.deps.clock.now();
      const reserved = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.counters.reserve(market, counters, now)),
      );
      if (!reserved.ok) return { code: 'access.unavailable' };
      const verdict = rateVerdict(DRAFT_SAVE_LIMITS, reserved.value, now);
      if (verdict.allowed) return null;
      this.#logger.warn({
        msg: 'catalog.request-throttled',
        kinds: DRAFT_SAVE_LIMITS.map((limit) => limit.kind),
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

type Author =
  | { readonly kind: 'seller'; readonly accountId: Id<'Account'>; readonly sellerId: Id<'Seller'> }
  | { readonly kind: 'admin'; readonly accountId: Id<'Account'> };

/** The author kind from the actor's population; a seller actor without a seller id is nobody. */
function authorOf(context: CallContext): ({ kind: AuthorKind } & Author) | null {
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
