import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { IMAGE_TAKEDOWN_REASONS, ProductImageTakenDown } from '../../domain/events';
import { parseAdminImageIds } from '../images/admin-image-input';
import type { ProductImage, ProductImageRepository } from '../ports/product-image.repository';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface ProductImageTakeDownInput {
  readonly productId: string;
  readonly imageId: string;
  /** One of {@link IMAGE_TAKEDOWN_REASONS}. */
  readonly reasonCode: string;
}

export interface ProductImageTakeDownOutput {
  readonly takenDown: true;
}

export type ProductImageTakeDownFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'image.not-found' }
  | ValidationFailure;

export interface ProductImageTakeDownDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/** The version a photo's takedown event carries: created (1), then taken down (2). */
const TAKEDOWN_AGGREGATE_VERSION = 2;

/**
 * `product-image.take-down` (catalog design 10.5; slice 13): a reviewer takes a product photo
 * down with a reason code. In one unit the photo moves from `clean` to `taken-down` (forward-only;
 * the database refuses any other move) and `catalog.image-taken-down.v1` goes to the outbox; after
 * the commit its files are deleted, best effort (the read routes already answer `image.not-found`
 * for it, and the sweep has no row to find: an undeleted file is an object without a row).
 * A revision that already holds the photo keeps its row (insert-only); the photo is never served
 * again and cannot join a new revision (the database refuses it). Taking down a photo that is
 * already down succeeds without a second event.
 *
 * Deviation from design 10.5: the key is `catalog.product.approve`, not `catalog.product.delete`
 * (not declared yet; identity's seed would change). Rule: that key and the admin population.
 */
export class ProductImageTakeDown extends UseCase<
  ProductImageTakeDownInput,
  ProductImageTakeDownOutput,
  ProductImageTakeDownFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.product-image-take-down',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('ProductImageTakeDown');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ProductImageTakeDownDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ProductImageTakeDownInput,
  ): Promise<Result<ProductImageTakeDownOutput, ProductImageTakeDownFailure>> {
    const result = await this.#takeDown(context, input);
    this.#logger.log({
      msg: 'catalog.product-image-take-down',
      code: result.ok ? 'taken-down' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #takeDown(
    context: CallContext,
    input: ProductImageTakeDownInput,
  ): Promise<Result<ProductImageTakeDownOutput, ProductImageTakeDownFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const ids = parseAdminImageIds(input, ['productId', 'imageId']);
    if (!ids.ok) return ids;
    const reason = input.reasonCode;
    if (
      typeof reason !== 'string' ||
      !(IMAGE_TAKEDOWN_REASONS as readonly string[]).includes(reason)
    ) {
      return invalid('reasonCode', 'unknown');
    }
    const productId = ids.value.productId as Id<'Product'>;
    const imageId = ids.value.imageId as Id<'ProductImage'>;
    const { deps } = this;
    const outcome = await deps.unitOfWork.run<
      { readonly image: ProductImage; readonly changed: boolean },
      { readonly code: 'image.not-found' }
    >(market, async () => {
      const image = await deps.images.find(market, productId, imageId);
      if (image === null) return err({ code: 'image.not-found' as const });
      if (image.state === 'taken-down') return ok({ image, changed: false });
      const now = deps.clock.now();
      const changed = await deps.images.takeDown(market, productId, imageId, {
        at: now,
        byAccountId: actor.accountId,
        reasonCode: reason,
      });
      if (changed) {
        await deps.outbox.append(context, [
          ProductImageTakenDown.record({
            aggregateId: imageId,
            aggregateVersion: TAKEDOWN_AGGREGATE_VERSION,
            occurredAt: now,
            payload: {
              productId,
              imageId,
              reasonCode: reason as (typeof IMAGE_TAKEDOWN_REASONS)[number],
            },
          }),
        ]);
      }
      return ok({ image, changed });
    });
    if (!outcome.ok) {
      return err(
        outcome.error.code === 'image.not-found' ? outcome.error : { code: 'access.unavailable' },
      );
    }
    if (outcome.value.changed) {
      await Promise.all(
        outcome.value.image.renditions.map((rendition) =>
          deps.objectStore.delete(rendition.objectKey).catch(() => undefined),
        ),
      );
    }
    return ok({ takenDown: true });
  }
}
