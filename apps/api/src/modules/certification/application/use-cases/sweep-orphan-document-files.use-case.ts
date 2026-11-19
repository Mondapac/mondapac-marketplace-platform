import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ObjectStore } from '../../../../platform/storage/object-store';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { OrphanDocumentFilesRepository } from '../ports/orphan-document-files.repository';

/** How old a certificate file must be before the sweep may remove it without a row, in hours. */
export const ORPHAN_DOCUMENT_FILE_GRACE_HOURS = 48;
/** Objects one run lists per page, and how many pages one run reads at most. */
export const ORPHAN_DOCUMENT_FILE_PAGE = 1000;
export const ORPHAN_DOCUMENT_FILE_MAX_PAGES = 50;

export interface SweepOrphanDocumentFilesOutput {
  /** Files removed by this run. */
  readonly deleted: number;
  /** Certificate-shaped files seen and left: too young, named by a row, or not this Market's. */
  readonly kept: number;
  /** True when the run stopped at its page limit before the end of the listing. */
  readonly partial: boolean;
}

export type SweepOrphanDocumentFilesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface SweepOrphanDocumentFilesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: OrphanDocumentFilesRepository;
  readonly objectStore: ObjectStore;
  readonly clock: Clock;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `certification/<subject id>/<document id>`: the shape of a certificate file; nothing else matches. */
const DOCUMENT_KEY = new RegExp(`^certification/${UUID}/${UUID}$`);

/**
 * `certification.sweep-orphan-document-files` (file storage pilot F6c): removes encrypted certificate
 * files that no uploaded-document row names. An upload writes the file before its row commits, and
 * a removal deletes the row first and the file after the commit, so a crash in between leaves a file
 * nobody can reach. It lists the object store, looks only at keys shaped like certificate files and
 * older than {@link ORPHAN_DOCUMENT_FILE_GRACE_HOURS} hours, asks the repository which of them belong
 * to a subject of this Market and have no row, and deletes those. The files are encrypted and the
 * sweep never opens one. Other modules' files, other Markets' files and young files are never
 * touched. Rule `system`, per hosted Market from the worker. A run reads at most
 * {@link ORPHAN_DOCUMENT_FILE_MAX_PAGES} pages and reports `partial`.
 */
export class SweepOrphanDocumentFiles extends UseCase<
  Record<string, never>,
  SweepOrphanDocumentFilesOutput,
  SweepOrphanDocumentFilesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.sweep-orphan-document-files',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SweepOrphanDocumentFiles');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SweepOrphanDocumentFilesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SweepOrphanDocumentFilesOutput, SweepOrphanDocumentFilesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const cutoff = deps.clock.now().subtract({ hours: ORPHAN_DOCUMENT_FILE_GRACE_HOURS });
    let deleted = 0;
    let kept = 0;
    let after: string | null = null;
    let partial = false;
    try {
      for (let page = 0; ; page += 1) {
        if (page >= ORPHAN_DOCUMENT_FILE_MAX_PAGES) {
          partial = true;
          break;
        }
        const listed = await deps.objectStore.list('certification', {
          after,
          limit: ORPHAN_DOCUMENT_FILE_PAGE,
        });
        const shaped = listed.objects.filter((object) => DOCUMENT_KEY.test(object.key));
        const old = shaped.filter(
          (object) => object.lastModified.epochMilliseconds < cutoff.epochMilliseconds,
        );
        kept += shaped.length - old.length;
        if (old.length > 0) {
          const read = await deps.unitOfWork.run(
            market,
            async () =>
              ok(
                await deps.files.unreferencedObjectKeys(
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
      msg: 'certification.sweep-orphan-document-files',
      deleted,
      kept,
      partial,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ deleted, kept, partial });
  }
}
