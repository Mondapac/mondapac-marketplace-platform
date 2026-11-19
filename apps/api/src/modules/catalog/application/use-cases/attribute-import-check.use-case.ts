import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_EDIT, CATALOG_ATTRIBUTE_IMPORT } from '../../contracts/permissions';
import {
  prepareImport,
  type PrepareDependencies,
  type PrepareFailure,
} from '../attribute-files/import-prepare';
import { checkViewOf, type ImportCheckView } from '../attribute-files/import-view';

export interface AttributeImportCheckInput {
  readonly data?: unknown;
  readonly fileName?: unknown;
}

export type AttributeImportCheckFailure = PrepareFailure;

/**
 * `attribute-import.check` (attributes plan, package A9): an admin uploads a CSV or XLSX file of
 * attributes or of attribute values and sees what it would do, row by row: create, update, no
 * change or an error with the column and a code. **Nothing is saved**: no file, no job, no
 * attribute. The claim-text check and the rules the editor applies when it saves run when the
 * import runs, not here. Rule: the keys `catalog.attribute.import` and `catalog.attribute.edit`
 * (both protected) and the admin population. The limits are the platform import's: 10 MiB, 5,000
 * rows, 64 columns, 10,000 characters a cell, and 20 uploads an hour per admin.
 */
export class AttributeImportCheck extends UseCase<
  AttributeImportCheckInput,
  ImportCheckView,
  AttributeImportCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-import-check',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_ATTRIBUTE_IMPORT.key, CATALOG_ATTRIBUTE_EDIT.key],
    },
  };

  readonly #logger = new Logger('AttributeImportCheck');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PrepareDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeImportCheckInput,
  ): Promise<Result<ImportCheckView, AttributeImportCheckFailure>> {
    const prepared = await prepareImport(this.deps, context, input);
    // Fixed fields only: never the file name, never a cell.
    this.#logger.log({
      msg: 'catalog.attribute-import-check',
      code: prepared.ok ? 'checked' : prepared.error.code,
      ...(prepared.ok ? { rows: prepared.value.plan.rows.length } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return prepared.ok ? ok(checkViewOf(prepared.value)) : err(prepared.error);
  }
}
