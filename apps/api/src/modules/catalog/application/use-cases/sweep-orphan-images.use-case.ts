import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  ORPHAN_IMAGE_GRACE_HOURS,
  ORPHAN_SWEEP_BATCH,
  ORPHAN_SWEEP_MAX_BATCHES,
} from '../images/image-limits';
import type { ProductImageRepository, UnattachedImage } from '../ports/product-image.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';

export interface SweepOrphanImagesOutput {
  /** Photos removed by this run. */
  readonly deleted: number;
  /** Photos left: a draft names them, or a revision took them while the sweep ran. */
  readonly kept: number;
}

export type SweepOrphanImagesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface SweepOrphanImagesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly images: ProductImageRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly objectStore: ObjectStore;
  readonly clock: Clock;
}

/**
 * `catalog.sweep-orphan-images` (catalog design 10.2, simplified path; slice 13): removes the
 * photos that were uploaded and never reached a revision. A clean photo older than
 * {@link ORPHAN_IMAGE_GRACE_HOURS} hours that no revision holds and that its product's working
 * copy does not name is deleted, row first (one unit per photo; the foreign key refuses a photo a
 * revision took in the meantime), then its files after the commit. Rule `system`, per hosted
 * Market from the worker. Safe to run twice and concurrently: a photo already gone is not found,
 * and a delete that finds nothing counts as kept. Photos in other states are never touched.
 * Files left without a row (a crash between the file write and the row) cannot be listed through
 * the object store port yet; they are the open half of the sweep.
 */
export class SweepOrphanImages extends UseCase<
  Record<string, never>,
  SweepOrphanImagesOutput,
  SweepOrphanImagesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.sweep-orphan-images',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SweepOrphanImages');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SweepOrphanImagesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SweepOrphanImagesOutput, SweepOrphanImagesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const createdBefore = deps.clock.now().subtract({ hours: ORPHAN_IMAGE_GRACE_HOURS });
    let deleted = 0;
    let kept = 0;
    let afterId: string | null = null;
    for (let batch = 0; batch < ORPHAN_SWEEP_MAX_BATCHES; batch += 1) {
      const page = await deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await deps.images.listUnattached(market, {
              createdBefore,
              afterId,
              limit: ORPHAN_SWEEP_BATCH,
            }),
          ),
        { readOnly: true },
      );
      if (!page.ok) return err({ code: 'access.unavailable' });
      for (const image of page.value) {
        const removed = await this.#remove(context, image);
        if (removed === 'deleted') deleted += 1;
        else kept += 1;
      }
      const last = page.value[page.value.length - 1];
      if (last === undefined || page.value.length < ORPHAN_SWEEP_BATCH) break;
      afterId = last.id;
    }
    this.#logger.log({
      msg: 'catalog.sweep-orphan-images',
      deleted,
      kept,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ deleted, kept });
  }

  async #remove(context: CallContext, image: UnattachedImage): Promise<'deleted' | 'kept'> {
    const { market } = context;
    const { deps } = this;
    const outcome = await deps.unitOfWork.run<boolean, { readonly code: 'kept' }>(
      market,
      async () => {
        const copy = await deps.workingCopies.find(market, image.productId);
        const named = copy?.content['imageIds'];
        if (Array.isArray(named) && named.includes(image.id)) return err({ code: 'kept' as const });
        const removed = await deps.images.deleteUnused(market, image.productId, image.id);
        return removed ? ok(true) : err({ code: 'kept' as const });
      },
    );
    if (!outcome.ok) return 'kept';
    await Promise.all(
      image.objectKeys.map((key) => deps.objectStore.delete(key).catch(() => undefined)),
    );
    return 'deleted';
  }
}
