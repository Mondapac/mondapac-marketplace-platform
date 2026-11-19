import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { REVIEWS_MODERATION_QUEUE } from '../../contracts/permissions';
import {
  exportModerationRows,
  type ModerationExportInput,
  type ModerationListDependencies,
  type ModerationListFailure,
} from '../moderation-list-flow';

/** `reviews.export-moderation-reviews` (super list 18): the moderation list as CSV or XLSX. */
export class ExportModerationReviews extends UseCase<
  ModerationExportInput,
  ExportFile,
  ModerationListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.export-moderation-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_MODERATION_QUEUE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ModerationListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: ModerationExportInput) {
    return exportModerationRows(this.deps, context, input);
  }
}
