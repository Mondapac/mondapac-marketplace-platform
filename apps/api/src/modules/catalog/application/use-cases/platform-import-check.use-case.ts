import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_PLATFORM_PRODUCT_EDIT,
} from '../../contracts/permissions';
import { mapColumns, type ColumnsRefusal } from '../../domain/platform-import/columns';
import { readImportFile, type FileRefusal } from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import {
  fileLabelOf,
  MAX_ISSUES_PER_ROW,
  type ImportRowRecord,
} from '../../domain/platform-import/platform-import-job';
import {
  checkRow,
  countRows,
  markDuplicates,
  type CheckedRow,
} from '../../domain/platform-import/row-check';
import { PLATFORM_IMPORT_CHECK_LIMITS } from '../../domain/rate-limits';
import {
  readCheckEnvironment,
  type CheckEnvironmentDependencies,
} from '../platform-import/check-environment';
import {
  viewOf,
  VIEW_ERROR_LINES,
  VIEW_PREVIEW_ROWS,
  type ImportView,
} from '../platform-import/import-view';
import { reserveForAccount, type ReserveFailure } from '../platform-import/reserve';
import { dropDiscardedJobs } from '../platform-import/common';
import type { ImportFileParsers } from '../ports/import-file-parsers';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';

/** The request as the route passes it: the file name as sent (shown cleaned, never echoed) and the file as base64. */
export interface PlatformImportCheckInput {
  readonly fileName: unknown;
  readonly data: unknown;
}

export type PlatformImportCheckFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | ReserveFailure
  | FileRefusal
  | ColumnsRefusal
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface PlatformImportCheckDependencies extends CheckEnvironmentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: PlatformImportRepository;
  readonly importFiles: ImportFileStore;
  readonly importParsers: ImportFileParsers;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The base64 text of a file at the size limit, plus its padding. */
const MAX_BASE64_LENGTH = Math.ceil((IMPORT_LIMITS.fileBytes * 4) / 3) + 4;

/**
 * `platform-import.check` (catalog design 14a; handoff "Import products" steps 1 and 2): an admin
 * uploads a file of PLATFORM products and it is read and checked. **Nothing is saved but the check's
 * own record**: no product, no draft. Rule: the keys `catalog.platform-import.run` and
 * `catalog.platform-product.edit` (every row later goes through the use cases that need the second).
 *
 * The order is the order of Hassan's limits: the request is typed; the size of the text is
 * checked before it is decoded; the admin's hourly and daily counts are spent before the file is read; the
 * bytes are sniffed and tokenised within the limits (10 MiB, 5,000 rows, 10,000 characters a cell);
 * the columns are read; then each row is checked against the Market's categories, types and
 * attribute schema, and rows with the same title and brand are marked. The file goes to object
 * storage under a key built from ids, and the job and its rows are written in one unit; the admin's
 * earlier unconfirmed checks are discarded in the same unit. The file name is shown cleaned, never
 * echoed as sent, and never part of a path. Claim-text is not checked here (it is rate-limited per
 * account); it is checked, per row, by the save of each product at run time.
 */
export class PlatformImportCheck extends UseCase<
  PlatformImportCheckInput,
  ImportView,
  PlatformImportCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-check',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_PLATFORM_IMPORT_RUN.key, CATALOG_PLATFORM_PRODUCT_EDIT.key],
    },
  };

  readonly #logger = new Logger('PlatformImportCheck');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportCheckDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformImportCheckInput,
  ): Promise<Result<ImportView, PlatformImportCheckFailure>> {
    const result = await this.#check(context, input);
    // Fixed fields only: never the file name, never a cell.
    this.#logger.log({
      msg: 'catalog.platform-import-check',
      code: result.ok ? 'checked' : result.error.code,
      ...(result.ok ? { rows: result.value.rows, errors: result.value.errors } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #check(
    context: CallContext,
    input: PlatformImportCheckInput,
  ): Promise<Result<ImportView, PlatformImportCheckFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fail = (path: string, code: string): Result<never, PlatformImportCheckFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    if (typeof input.data !== 'string' || input.data.length === 0) return fail('data', 'required');
    if (input.fileName !== undefined && typeof input.fileName !== 'string') {
      return fail('fileName', 'type');
    }
    // The size of the text first: nothing is decoded, hashed or parsed above the limit.
    if (input.data.length > MAX_BASE64_LENGTH) {
      return err({ code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes });
    }
    if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) return fail('data', 'format');

    const { deps } = this;
    const throttled = await reserveForAccount(
      deps,
      context,
      PLATFORM_IMPORT_CHECK_LIMITS,
      actor.accountId,
    );
    if (throttled !== null) return err(throttled);

    const bytes = Buffer.from(input.data, 'base64');
    const table = await readImportFile(bytes, IMPORT_LIMITS, deps.importParsers);
    if (!table.ok) return table;
    const columns = mapColumns(table.value.header);
    if (!columns.ok) return err(columns.error);

    const env = await readCheckEnvironment(deps, market);
    if (!env.ok) return env;
    const checked: CheckedRow[] = markDuplicates(
      table.value.rows.map((row) => checkRow(row, columns.value.map, env.value)),
    );
    const counts = countRows(checked);
    const records: ImportRowRecord[] = checked.map((row) => ({
      rowNumber: row.rowNumber,
      checkState: row.state,
      // The table keeps at most 12 problems of a row; errors first, so none is lost.
      issues: [...row.issues]
        .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
        .slice(0, MAX_ISSUES_PER_ROW),
      summary: row.summary,
      runState: row.state === 'error' ? 'skipped' : 'pending',
      runCode: null,
      productId: null,
      productCode: null,
    }));

    const id = deps.ids.next<'PlatformImport'>();
    const fileKey = deps.importFiles.keyOf(market, id);
    const now = deps.clock.now();
    const job = {
      id,
      startedByAccountId: actor.accountId,
      startedBySessionId: actor.sessionId,
      format: table.value.format,
      fileLabel: fileLabelOf(input.fileName),
      fileKey,
      fileSha256: createHash('sha256').update(bytes).digest('hex'),
      fileBytes: bytes.length,
      totalRows: counts.rows,
      readyRows: counts.ready,
      errorRows: counts.errors,
      warningRows: counts.warnings,
      ignoredColumns: columns.value.ignored,
      createdAt: now,
      checkedAt: now,
    };

    try {
      await deps.importFiles.put(fileKey, bytes);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    let replaced: readonly { readonly id: Id<'PlatformImport'>; readonly fileKey: string }[];
    try {
      const stored = await deps.unitOfWork.run(
        market,
        async () => {
          const discarded = await deps.importJobs.discardChecked(market, actor.accountId, now);
          await deps.importJobs.add(market, job, records);
          return ok(discarded);
        },
        { timeoutMs: 30_000 },
      );
      if (!stored.ok) throw new Error('unit failed');
      replaced = stored.value;
    } catch {
      await deps.importFiles.delete(fileKey).catch(() => undefined);
      return err({ code: 'access.unavailable' });
    }
    // The admin's earlier unconfirmed checks go now, file, job and rows; the purge job is the net
    // for any that stay.
    await dropDiscardedJobs(deps, market, replaced, now);

    return ok(
      viewOf(
        {
          ...job,
          state: 'checked',
          fileDeletedAt: null,
          startAs: null,
          skipErrors: null,
          toImport: null,
          addedRows: 0,
          failedRows: 0,
          stopReason: null,
          notBefore: null,
          leaseUntil: null,
          version: 1,
          startedAt: null,
          finishedAt: null,
        },
        {
          errorRows: records.filter((row) => row.checkState === 'error').slice(0, VIEW_ERROR_LINES),
          failedRows: [],
          previewRows: records
            .filter((row) => row.checkState === 'ready')
            .slice(0, VIEW_PREVIEW_ROWS),
        },
      ),
    );
  }
}
