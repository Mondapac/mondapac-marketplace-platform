import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_IMPORT } from '../../contracts/permissions';
import {
  applyImport,
  planOf,
  prepareImport,
  readSnapshot,
  type CategoryImportDependencies,
  type CategoryImportFailure,
  type ImportCounts,
} from '../categories/category-import';
import { closedInput, invalid, versionOf } from '../categories/category-editor';

export interface CategoryImportApplyInput {
  readonly [key: string]: unknown;
}

export interface CategoryImportApplyOutput {
  readonly fileSha256: string;
  /** `category_trees.version` after the import (unchanged when nothing was written). */
  readonly treeVersion: number;
  readonly counts: ImportCounts;
  readonly written: boolean;
}

const KEYS = ['data', 'fileSha256', 'treeVersion'] as const;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * `category-tree.import-apply` (categories package C7a; plan decision 12): applies a category tree
 * file that has a clean dry run. The request carries the file again with the SHA-256 and the tree
 * version the dry run answered: a different file is `import.file-changed`, a tree that changed
 * since is `conflict.stale`. The file is checked as in the dry run, the plan is made again under the
 * structural lock, and a file with any error row writes nothing (`import.has-errors`). Rows are
 * written in one unit with one tree version raise, each through the editor's own create and
 * edit-details functions (so each category has its own revision, audit entry and event), plus one
 * `catalog.category-tree.imported` audit entry with counts and the file hash (as the target id).
 * Create and update only: no move, merge, archive, show or hide. Rule: the protected key
 * `catalog.category-tree.import`, never an acting-as session.
 */
export class CategoryImportApply extends UseCase<
  CategoryImportApplyInput,
  CategoryImportApplyOutput,
  CategoryImportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-import-apply',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_IMPORT.key] },
  };

  readonly #logger = new Logger('CategoryImportApply');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryImportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryImportApplyInput,
  ): Promise<Result<CategoryImportApplyOutput, CategoryImportFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-import-apply',
      code: result.ok ? (result.value.written ? 'applied' : 'nothing-to-write') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryImportApplyInput,
  ): Promise<Result<CategoryImportApplyOutput, CategoryImportFailure>> {
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const hash = body.value['fileSha256'];
    if (typeof hash !== 'string' || !SHA256.test(hash)) return invalid('fileSha256', 'format');
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;

    const prepared = await prepareImport(this.deps, context, body.value['data']);
    if (!prepared.ok) return prepared;
    if (prepared.value.sha256 !== hash) return err({ code: 'import.file-changed' });
    const snapshot = await readSnapshot(this.deps, context.market, prepared.value.parsed);
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.treeVersion !== treeVersion.value) return err({ code: 'conflict.stale' });
    const plan = planOf(snapshot.value, prepared.value.rules);
    if (plan.counts.error > 0) {
      return err({ code: 'import.has-errors', errors: plan.counts.error });
    }
    if (plan.operations.length === 0) {
      return ok({
        fileSha256: hash,
        treeVersion: snapshot.value.treeVersion,
        counts: plan.counts,
        written: false,
      });
    }
    const applied = await applyImport(
      this.deps,
      context,
      prepared.value,
      snapshot.value,
      treeVersion.value,
    );
    if (!applied.ok) return applied;
    return ok({
      fileSha256: hash,
      treeVersion: applied.value.treeVersion,
      counts: applied.value.counts,
      written: true,
    });
  }
}
