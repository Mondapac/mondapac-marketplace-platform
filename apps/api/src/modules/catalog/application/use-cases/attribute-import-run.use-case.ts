import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_EDIT, CATALOG_ATTRIBUTE_IMPORT } from '../../contracts/permissions';
import { AttributeImportRanAudit } from '../../domain/audit';
import {
  prepareImport,
  type PrepareDependencies,
  type PrepareFailure,
} from '../attribute-files/import-prepare';
import type { AttributeFileKind } from '../attribute-files/file-layout';
import type { PlannedRow, Write } from '../attribute-files/import-plan';
import { importReport, type ReportFile, type ResultRow } from '../attribute-files/import-report';
import { VIEW_ROWS } from '../attribute-files/import-view';
import type { AttributeDefinitionCreate } from './attribute-definition-create.use-case';
import type { AttributeDefinitionEdit } from './attribute-definition-edit.use-case';

export interface AttributeImportRunInput {
  readonly data?: unknown;
  readonly fileName?: unknown;
  /** The `fileSha256` the check answered: the run applies only that file. */
  readonly fileSha256?: unknown;
  /** True to run although some rows are errors; they are skipped. */
  readonly skipErrors?: unknown;
}

export interface AttributeImportRunOutput {
  readonly kind: AttributeFileKind;
  readonly rows: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  /** Rows the check marked as errors and the run skipped. */
  readonly skipped: number;
  /** Rows the editor refused (claim word, stale, domain rule, a code taken meanwhile). */
  readonly failed: number;
  /** The failed and skipped rows first, at most {@link VIEW_ROWS}. */
  readonly results: readonly ResultRow[];
  readonly truncated: boolean;
  /** The result of every row as a CSV file, to download. */
  readonly report: ReportFile;
}

export type AttributeImportRunFailure =
  | PrepareFailure
  | { readonly code: 'import.file-changed' }
  | { readonly code: 'import.errors-not-skipped' }
  | { readonly code: 'import.nothing-to-import' };

export interface AttributeImportRunDependencies extends PrepareDependencies {
  readonly attributeCreate: AttributeDefinitionCreate;
  readonly attributeEdit: AttributeDefinitionEdit;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Refusal = { readonly code: string; readonly fields?: readonly { readonly path: string }[] };

/**
 * `attribute-import.run` (attributes plan, package A9): applies a checked file. The file is sent
 * again with the SHA-256 the check answered (`import.file-changed` otherwise) and read and planned
 * again against the attributes as they are now. Every row goes through the editor's own use cases,
 * `attribute-definition.create` and `attribute-definition.edit`, as the calling admin: the claim-text
 * check of every name, help text and label in every locale (fail closed for a locale the vocabulary
 * cannot read), the code being free, the version check and the domain rules all apply, and each
 * write has its own audit row. A refusal fails that attribute (all the rows of a values file that
 * belong to it) and the run goes on; nothing is rolled back, because each attribute is its own
 * revision. A file with error rows needs `skipErrors: true`. One more audit row,
 * `catalog.attribute-import.ran`, holds the counts. The answer carries the result of every row as
 * a CSV file. Rule: the keys `catalog.attribute.import` and `catalog.attribute.edit` (both
 * protected), the admin population, and never an acting-as session (the editor refuses it).
 */
export class AttributeImportRun extends UseCase<
  AttributeImportRunInput,
  AttributeImportRunOutput,
  AttributeImportRunFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-import-run',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_ATTRIBUTE_IMPORT.key, CATALOG_ATTRIBUTE_EDIT.key],
    },
  };

  readonly #logger = new Logger('AttributeImportRun');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeImportRunDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeImportRunInput,
  ): Promise<Result<AttributeImportRunOutput, AttributeImportRunFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-import-run',
      code: result.ok ? 'ran' : result.error.code,
      ...(result.ok
        ? {
            created: result.value.created,
            updated: result.value.updated,
            failed: result.value.failed,
          }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: AttributeImportRunInput,
  ): Promise<Result<AttributeImportRunOutput, AttributeImportRunFailure>> {
    if (typeof input !== 'object' || input === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'body', code: 'type' }] });
    }
    const fail = (path: string, code: string): Result<never, AttributeImportRunFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input.fileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.fileSha256)) {
      return fail('fileSha256', 'format');
    }
    if (input.skipErrors !== undefined && typeof input.skipErrors !== 'boolean') {
      return fail('skipErrors', 'type');
    }
    const skipErrors = input.skipErrors === true;
    const { deps } = this;
    const prepared = await prepareImport(deps, context, input);
    if (!prepared.ok) return prepared;
    const { kind, plan, fileSha256 } = prepared.value;
    if (fileSha256 !== input.fileSha256) return err({ code: 'import.file-changed' });
    const errors = plan.rows.filter((row) => row.action === 'error').length;
    if (errors > 0 && !skipErrors) return err({ code: 'import.errors-not-skipped' });
    if (plan.writes.length === 0) return err({ code: 'import.nothing-to-import' });

    // Row by row outcome; rows the plan did not write are filled in below.
    const actionOf = new Map(plan.rows.map((row) => [row.rowNumber, row.action]));
    const outcome = new Map<number, { result: ResultRow['result']; code: string | null }>();
    for (const write of plan.writes) {
      const answer = await this.#apply(context, write);
      if (answer === null) {
        for (const rowNumber of rowsOf(write)) {
          // A values file adds some values and renames others in one revision: the plan knows which.
          outcome.set(rowNumber, {
            result: actionOf.get(rowNumber) === 'create' ? 'created' : 'updated',
            code: null,
          });
        }
        continue;
      }
      // Nothing of a failed revision is applied. The rows the refusal points at carry its code;
      // the other rows of the same attribute say that the group was not applied.
      const hit = failedRows(write, answer);
      for (const rowNumber of rowsOf(write)) {
        outcome.set(rowNumber, {
          result: 'failed',
          code: hit.has(rowNumber) ? answer.code : 'import.group-not-applied',
        });
      }
    }

    const results: ResultRow[] = plan.rows.map((row: PlannedRow) => {
      const done = outcome.get(row.rowNumber);
      if (done !== undefined)
        return { rowNumber: row.rowNumber, key: row.key, result: done.result, code: done.code };
      if (row.action === 'error') {
        return {
          rowNumber: row.rowNumber,
          key: row.key,
          result: 'skipped' as const,
          code: row.issues.map((issue) => `${issue.column}:${issue.code}`).join('; '),
        };
      }
      return { rowNumber: row.rowNumber, key: row.key, result: 'unchanged' as const, code: null };
    });
    const count = (result: ResultRow['result']): number =>
      results.filter((r) => r.result === result).length;
    const summary = {
      created: count('created'),
      updated: count('updated'),
      unchanged: count('unchanged'),
      skipped: count('skipped'),
      failed: count('failed'),
    };

    const { market } = context;
    try {
      const recorded = await deps.unitOfWork.run(market, async () => {
        const targetId = deps.ids.next<'AttributeImport'>();
        await deps.audit.record(
          context,
          AttributeImportRanAudit.entry(targetId, {
            after: { kind, skipErrors, rows: results.length, ...summary },
          }),
        );
        return ok(undefined);
      });
      if (!recorded.ok) this.#auditLost(context);
    } catch {
      // The rows are applied and each has its own audit row; the run's row is the summary.
      this.#auditLost(context);
    }

    const worst = results.filter((r) => r.result === 'failed' || r.result === 'skipped');
    return ok({
      kind,
      rows: results.length,
      ...summary,
      results: worst.slice(0, VIEW_ROWS),
      truncated: worst.length > VIEW_ROWS,
      report: importReport(results, deps.clock.now().toString().slice(0, 10), kind),
    });
  }

  #auditLost(context: CallContext): void {
    this.#logger.error({
      msg: 'catalog.attribute-import-audit-lost',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }

  /** Runs one write through the editor; null when it was applied, else the refusal. */
  async #apply(context: CallContext, write: Write): Promise<Refusal | null> {
    try {
      const answer =
        write.kind === 'create'
          ? await this.deps.attributeCreate.execute(context, { ...write.input })
          : await this.deps.attributeEdit.execute(context, { ...write.input });
      return answer.ok ? null : answer.error;
    } catch {
      // A defect in one write never stops the others, and nothing of it reaches the answer.
      return { code: 'import.write-failed' };
    }
  }
}

const rowsOf = (write: Write): readonly number[] =>
  write.kind === 'create' ? [write.rowNumber] : write.rowNumbers;

/** The rows of a failed write that its refusal points at; all of them when it points at none. */
function failedRows(write: Write, refusal: Refusal): ReadonlySet<number> {
  if (write.kind === 'create') return new Set([write.rowNumber]);
  const hit = new Set<number>();
  const options = Array.isArray(write.input['options'])
    ? (write.input['options'] as readonly { code?: unknown }[])
    : [];
  for (const field of refusal.fields ?? []) {
    const byIndex = /^options\[(\d+)\]/.exec(field.path);
    const byCode = /^options\.([^.]+)/.exec(field.path);
    const index =
      byIndex !== null ? Number(byIndex[1]) : options.findIndex((o) => o.code === byCode?.[1]);
    const row = write.optionRows.get(index);
    if (row !== undefined) hit.add(row);
  }
  return hit.size > 0 ? hit : new Set(write.rowNumbers);
}
