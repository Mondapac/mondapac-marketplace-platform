import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { StoreImageRepository } from '../ports/store-image.repository';
import {
  ORPHAN_STORE_FILE_GRACE_HOURS,
  ORPHAN_STORE_FILE_MAX_PAGES,
  ORPHAN_STORE_FILE_PAGE,
} from '../store-profile/store-image-objects';

export interface SweepOrphanStoreImageFilesOutput {
  /** Files removed by this run. */
  readonly deleted: number;
  /** Store-image-shaped files seen and left: too young, named by a row, or not this Market's. */
  readonly kept: number;
  /** True when the run stopped at its page limit before the end of the listing. */
  readonly partial: boolean;
}

export type SweepOrphanStoreImageFilesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface SweepOrphanStoreImageFilesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly storeImages: StoreImageRepository;
  readonly objectStore: ObjectStore;
  readonly clock: Clock;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<seller id>/store-images/<image id>/<size>`: the shape of a store image file; nothing else matches. */
const STORE_IMAGE_KEY = new RegExp(`^${UUID}/store-images/${UUID}/[a-z]+$`);

/**
 * `sellers.sweep-orphan-store-image-files` (file storage pilot F6b): removes store logo and banner
 * files that no row names. A replace deletes the old row first and its files after the commit, and a
 * crash in between (or between a file write and its row) leaves files nobody can reach. It lists the
 * object store, looks only at keys shaped like store image files and older than
 * {@link ORPHAN_STORE_FILE_GRACE_HOURS} hours, asks the repository which of them belong to a seller
 * of this Market and have no rendition row, and deletes those. Other modules' files, other Markets'
 * files and young files are never touched. Rule `system`, per hosted Market from the worker. A run
 * reads at most {@link ORPHAN_STORE_FILE_MAX_PAGES} pages and reports `partial`.
 */
export class SweepOrphanStoreImageFiles extends UseCase<
  Record<string, never>,
  SweepOrphanStoreImageFilesOutput,
  SweepOrphanStoreImageFilesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.sweep-orphan-store-image-files',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SweepOrphanStoreImageFiles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SweepOrphanStoreImageFilesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SweepOrphanStoreImageFilesOutput, SweepOrphanStoreImageFilesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const cutoff = deps.clock.now().subtract({ hours: ORPHAN_STORE_FILE_GRACE_HOURS });
    let deleted = 0;
    let kept = 0;
    let after: string | null = null;
    let partial = false;
    try {
      for (let page = 0; ; page += 1) {
        if (page >= ORPHAN_STORE_FILE_MAX_PAGES) {
          partial = true;
          break;
        }
        const listed = await deps.objectStore.list('', { after, limit: ORPHAN_STORE_FILE_PAGE });
        const shaped = listed.objects.filter((object) => STORE_IMAGE_KEY.test(object.key));
        const old = shaped.filter(
          (object) => object.lastModified.epochMilliseconds < cutoff.epochMilliseconds,
        );
        kept += shaped.length - old.length;
        if (old.length > 0) {
          const read = await deps.unitOfWork.run(
            market,
            async () =>
              ok(
                await deps.storeImages.unreferencedObjectKeys(
                  market,
                  old.map((object) => object.key),
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
      msg: 'sellers.sweep-orphan-store-image-files',
      deleted,
      kept,
      partial,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ deleted, kept, partial });
  }
}
