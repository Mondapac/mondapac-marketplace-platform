import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_IMPORT } from '../../contracts/permissions';
import type { ImportRowResult } from '../../domain/category-import';
import {
  planOf,
  prepareImport,
  readSnapshot,
  type CategoryImportDependencies,
  type CategoryImportFailure,
  type ImportCounts,
} from '../categories/category-import';
import { closedInput } from '../categories/category-editor';

export interface CategoryImportDryRunOutput {
  /** What the apply must name: the file it was made from and the tree it read. */
  readonly fileSha256: string;
  readonly treeVersion: number;
  readonly format: 'csv' | 'xlsx';
  readonly counts: ImportCounts;
  /** True when no row is an error and at least one row would write. */
  readonly clean: boolean;
  readonly rows: readonly ImportRowResult[];
}

/**
 * `category-tree.import-dry-run` (categories package C7a; plan decision 12): an admin uploads a
 * category tree file and is shown, per row, what applying it would do: create, update, unchanged,
 * or an error with a code. **Nothing is written.** The file is a base64 CSV or XLSX within the
 * Market's `maxCategoryImportBytes` and `maxCategoryImportRows`, read by the platform's file
 * readers (the XLSX in its isolated worker, formulas refused). Every cell's text passes the Market's
 * content filter and the claim-text check in its own locale, failing closed. Rule: the protected
 * key `catalog.category-tree.import` and the admin population, never an acting-as session.
 */
export class CategoryImportDryRun extends UseCase<
  { readonly data?: unknown },
  CategoryImportDryRunOutput,
  CategoryImportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-import-dry-run',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_IMPORT.key] },
  };

  readonly #logger = new Logger('CategoryImportDryRun');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryImportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly data?: unknown },
  ): Promise<Result<CategoryImportDryRunOutput, CategoryImportFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-import-dry-run',
      code: result.ok ? (result.value.clean ? 'clean' : 'has-errors') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: { readonly data?: unknown },
  ): Promise<Result<CategoryImportDryRunOutput, CategoryImportFailure>> {
    const body = closedInput(input, ['data']);
    if (!body.ok) return body;
    const prepared = await prepareImport(this.deps, context, body.value['data']);
    if (!prepared.ok) return prepared;
    const snapshot = await readSnapshot(this.deps, context.market, prepared.value.parsed);
    if (!snapshot.ok) return snapshot;
    const plan = planOf(snapshot.value, prepared.value.rules);
    return ok({
      fileSha256: prepared.value.sha256,
      treeVersion: snapshot.value.treeVersion,
      format: prepared.value.format,
      counts: plan.counts,
      clean: plan.counts.error === 0 && plan.operations.length > 0,
      rows: plan.results,
    });
  }
}
