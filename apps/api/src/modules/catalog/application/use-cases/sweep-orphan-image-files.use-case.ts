import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  ORPHAN_FILE_SWEEP_MAX_PAGES,
  ORPHAN_FILE_SWEEP_PAGE,
  ORPHAN_IMAGE_GRACE_HOURS,
} from '../images/image-limits';
import type { ProductImageRepository } from '../ports/product-image.repository';

export interface SweepOrphanImageFilesOutput {
  /** Files removed by this run. */
  readonly deleted: number;
  /** Photo-shaped files seen and left: too young, named by a row, or not this Market's. */
  readonly kept: number;
  /** True when the run stopped at its page limit before the end of the listing. */
  readonly partial: boolean;
}

export type SweepOrphanImageFilesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface SweepOrphanImageFilesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly images: ProductImageRepository;
  readonly objectStore: ObjectStore;
  readonly clock: Clock;
}

/** `<product id>/<image id>/<size>`: the shape catalog gives its photo files; nothing else matches. */
const PHOTO_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(thumb|medium|large)$/;

/**
 * `catalog.sweep-orphan-image-files` (file storage pilot F6): removes photo files that no photo
 * row names, the half of the orphan sweep that `SweepOrphanImages` could not do (a crash between
 * the file write and the row leaves a file without a row). It lists the object store, looks only
 * at keys shaped like photo files and older than {@link ORPHAN_IMAGE_GRACE_HOURS} hours, asks the
 * repository which of them belong to a product of this Market and have no row, and deletes those.
 * Anything else (another module's files, other Markets' files, young files) is never touched. Rule
 * `system`, per hosted Market from the worker. Safe to run twice: a file already gone is not
 * listed. A run reads at most {@link ORPHAN_FILE_SWEEP_MAX_PAGES} pages and reports `partial`.
 */
export class SweepOrphanImageFiles extends UseCase<
  Record<string, never>,
  SweepOrphanImageFilesOutput,
  SweepOrphanImageFilesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.sweep-orphan-image-files',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SweepOrphanImageFiles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SweepOrphanImageFilesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SweepOrphanImageFilesOutput, SweepOrphanImageFilesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const youngerThan = deps.clock.now().subtract({ hours: ORPHAN_IMAGE_GRACE_HOURS });
    let deleted = 0;
    let kept = 0;
    let after: string | null = null;
    let partial = false;
    try {
      for (let page = 0; ; page += 1) {
        if (page >= ORPHAN_FILE_SWEEP_MAX_PAGES) {
          partial = true;
          break;
        }
        const listed = await deps.objectStore.list('', { after, limit: ORPHAN_FILE_SWEEP_PAGE });
        const photos = listed.objects.filter((object) => PHOTO_KEY.test(object.key));
        const old = photos.filter(
          (object) => object.lastModified.epochMilliseconds < youngerThan.epochMilliseconds,
        );
        kept += photos.length - old.length;
        if (old.length > 0) {
          const read = await deps.unitOfWork.run(
            market,
            async () =>
              ok(
                await deps.images.unreferencedObjectKeys(
                  market,
                  old.map((o) => o.key),
                ),
              ),
            { readOnly: true },
          );
          if (!read.ok) return err({ code: 'access.unavailable' });
          for (const key of read.value) {
            await deps.objectStore.delete(key);
            deleted += 1;
          }
          kept += old.length - read.value.length;
        }
        if (listed.next === null) break;
        after = listed.next;
      }
    } catch {
      return err({ code: 'access.unavailable' });
    }
    this.#logger.log({
      msg: 'catalog.sweep-orphan-image-files',
      deleted,
      kept,
      partial,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ deleted, kept, partial });
  }
}
