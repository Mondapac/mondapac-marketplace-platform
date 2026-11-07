import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_IMPORT_RUN, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { fileLabelOf, MAX_ISSUES_PER_ROW } from '../../domain/import-jobs/import-job-core';
import { readImportFile, type FileRefusal } from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { SELLER_IMPORT_CHECK_LIMITS } from '../../domain/rate-limits';
import {
  mapSellerColumns,
  SELLER_IMPORT_MODES,
  type SellerColumnsRefusal,
  type SellerImportMode,
} from '../../domain/seller-import/columns';
import {
  attributeColumnCodes,
  checkSellerFile,
  countSellerRows,
  optionColumnCodes,
} from '../../domain/seller-import/row-check';
import type { SellerRowRecord } from '../../domain/seller-import/seller-import-job';
import { isActingAsSession } from '../acting-as';
import { reserveForAccount, type ReserveFailure } from '../platform-import/reserve';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { ImportFileParsers } from '../ports/import-file-parsers';
import type { ImportFileStore } from '../ports/import-file-store';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SellerImportFactsReader } from '../ports/seller-import-facts.reader';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import type { CheckEnvironmentDependencies } from '../platform-import/check-environment';
import {
  dropDiscardedSellerJobs,
  EMPTY_SELLER_PARTS,
  readSellerCheckEnvironment,
  sellerViewOf,
  VIEW_ERROR_LINES,
  VIEW_PREVIEW_ROWS,
  type SellerImportView,
} from '../seller-import/seller-import-support';

/** The request as the route passes it: the mode, the file name as sent (never echoed) and the file as base64. */
export interface OwnImportCheckInput {
  readonly mode: unknown;
  readonly fileName: unknown;
  readonly data: unknown;
}

export type OwnImportCheckFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.acting-as-refused' }
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'setting.product-creation-off' }
  | { readonly code: 'setting.sell-from-catalogue-off' }
  | ReserveFailure
  | FileRefusal
  | SellerColumnsRefusal
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnImportCheckDependencies extends CheckEnvironmentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerJobs: SellerImportRepository;
  readonly importFiles: ImportFileStore;
  readonly importParsers: ImportFileParsers;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly importFacts: SellerImportFactsReader;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** The base64 text of a file at the size limit, plus its padding. */
const MAX_BASE64_LENGTH = Math.ceil((IMPORT_LIMITS.fileBytes * 4) / 3) + 4;

/**
 * `own-import.check` (catalog design 14c): a seller uploads a file and it is read and checked.
 * **Nothing is saved but the check's own record**: no product, no Offer, no draft. Rule: the keys
 * `catalog.own-import.run` and `catalog.own-product.edit`, the seller population and a seller who
 * may sell; an acting-as session is refused. The seller is always the actor's.
 *
 * The order is the order of Hassan's limits: the request is typed; the mode is one of the two and
 * the Market allows it (`setting.product-creation-off`, `setting.sell-from-catalogue-off`); the size
 * of the text is checked before it is decoded; the seller's hourly and daily counts are spent
 * before the file is read; the bytes are sniffed and tokenised within the limits; the columns are
 * read (an unread column is listed, never read); then each group is checked against the Market's
 * facts and the seller's own Offers, which are read for the SKUs and product codes of the file only.
 * The file goes to object storage under a key built from ids, and the job and its rows are written
 * in one unit; the account's earlier unconfirmed checks are discarded in the same unit.
 */
export class OwnImportCheck extends UseCase<
  OwnImportCheckInput,
  SellerImportView,
  OwnImportCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-check',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_OWN_IMPORT_RUN.key, CATALOG_OWN_PRODUCT_EDIT.key],
    },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnImportCheck');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportCheckDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportCheckInput,
  ): Promise<Result<SellerImportView, OwnImportCheckFailure>> {
    const result = await this.#check(context, input);
    // Fixed fields only: never the file name, never a cell.
    this.#logger.log({
      msg: 'catalog.own-import-check',
      code: result.ok ? 'checked' : result.error.code,
      ...(result.ok ? { rows: result.value.rows, errors: result.value.errors } : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #check(
    context: CallContext,
    input: OwnImportCheckInput,
  ): Promise<Result<SellerImportView, OwnImportCheckFailure>> {
    const { actor, market } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (isActingAsSession(actor)) return err({ code: 'access.acting-as-refused' });
    const sellerId = actor.sellerId;
    const { deps } = this;
    const fail = (path: string, code: string): Result<never, OwnImportCheckFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    if (!(SELLER_IMPORT_MODES as readonly unknown[]).includes(input.mode)) {
      return fail('mode', 'enum');
    }
    const mode = input.mode as SellerImportMode;
    if (typeof input.data !== 'string' || input.data.length === 0) return fail('data', 'required');
    if (input.fileName !== undefined && typeof input.fileName !== 'string') {
      return fail('fileName', 'type');
    }

    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    try {
      if (mode === 'my-products' && !(await deps.policy.sellerCanCreateProduct(market))) {
        return err({ code: 'setting.product-creation-off' });
      }
      if (mode === 'sell-from-catalogue' && !(await deps.policy.sellFromCatalogue(market))) {
        return err({ code: 'setting.sell-from-catalogue-off' });
      }
    } catch {
      return err({ code: 'access.unavailable' });
    }
    // The size of the text first: nothing is decoded, hashed or parsed above the limit.
    if (input.data.length > MAX_BASE64_LENGTH) {
      return err({ code: 'file.too-large', maxBytes: IMPORT_LIMITS.fileBytes });
    }
    if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) return fail('data', 'format');

    const throttled = await reserveForAccount(deps, context, SELLER_IMPORT_CHECK_LIMITS, sellerId);
    if (throttled !== null) return err(throttled);

    const bytes = Buffer.from(input.data, 'base64');
    const table = await readImportFile(bytes, IMPORT_LIMITS, deps.importParsers);
    if (!table.ok) return table;

    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    const env = await readSellerCheckEnvironment(deps, market, allowed);
    if (!env.ok) return env;
    const columns = mapSellerColumns(table.value.header, mode, {
      optionCodes: optionColumnCodes(env.value),
      attributeCodes: attributeColumnCodes(env.value),
    });
    if (!columns.ok) return err(columns.error);
    const map = columns.value;

    const skuColumn = map.fixed.sku;
    const codeColumn = map.fixed.productCode;
    const skus = new Set<string>();
    const productCodes = new Set<string>();
    for (const row of table.value.rows) {
      const sku = skuColumn === undefined ? '' : (row.cells[skuColumn] ?? '').normalize('NFC').trim();
      if (sku !== '') skus.add(sku);
      const code =
        codeColumn === undefined ? '' : (row.cells[codeColumn] ?? '').normalize('NFC').trim();
      if (code !== '') productCodes.add(code);
    }
    let facts;
    try {
      const read = await deps.unitOfWork.run(
        market,
        async () =>
          ok(
            await deps.importFacts.load(market, sellerId, {
              skus: [...skus],
              productCodes: [...productCodes],
            }),
          ),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'access.unavailable' });
      facts = read.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }

    const groups = checkSellerFile(table.value.rows, map, env.value, facts);
    const counts = countSellerRows(groups);
    const records: SellerRowRecord[] = groups.flatMap((group) =>
      group.rows.map((row) => ({
        rowNumber: row.rowNumber,
        groupRow: row.groupRow,
        checkState: row.state,
        plan: row.plan,
        // The table keeps at most 12 problems of a row; errors first, so none is lost.
        issues: [...row.issues]
          .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'))
          .slice(0, MAX_ISSUES_PER_ROW),
        summary: row.summary,
        runState: row.state === 'error' ? ('skipped' as const) : ('pending' as const),
        runCode: null,
        productId: null,
        offerId: null,
        productCode: null,
      })),
    );
    records.sort((a, b) => a.rowNumber - b.rowNumber);

    // A workbook is opened once, here: what is stored is its table as plain CSV, so the worker's
    // turns never open the container again. A CSV is stored as it came.
    const storedBytes: Uint8Array = table.value.canonical ?? bytes;

    const id = deps.ids.next<'SellerImport'>();
    const fileKey = deps.importFiles.keyOf(market, id);
    const now = deps.clock.now();
    const job = {
      id,
      sellerId,
      startedByAccountId: actor.accountId,
      startedBySessionId: actor.sessionId,
      mode,
      format: table.value.format,
      fileLabel: fileLabelOf(input.fileName),
      fileKey,
      fileSha256: createHash('sha256').update(storedBytes).digest('hex'),
      fileBytes: storedBytes.length,
      totalRows: counts.rows,
      readyRows: counts.ready,
      errorRows: counts.errors,
      warningRows: counts.warnings,
      groupCount: counts.groups,
      ignoredColumns: map.ignored,
      createdAt: now,
      checkedAt: now,
    };

    try {
      await deps.importFiles.put(fileKey, Buffer.from(storedBytes));
    } catch {
      return err({ code: 'access.unavailable' });
    }
    let replaced: readonly { readonly id: Id<'SellerImport'>; readonly fileKey: string }[];
    try {
      const stored = await deps.unitOfWork.run(
        market,
        async () => {
          const discarded = await deps.sellerJobs.discardChecked(
            market,
            sellerId,
            actor.accountId,
            now,
          );
          await deps.sellerJobs.add(market, job, records);
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
    await dropDiscardedSellerJobs(deps, market, replaced, now);

    return ok(
      sellerViewOf(
        {
          ...job,
          state: 'checked',
          fileDeletedAt: null,
          skipErrors: null,
          toImport: null,
          createdRows: 0,
          updatedRows: 0,
          unchangedRows: 0,
          failedRows: 0,
          stopReason: null,
          notBefore: null,
          leaseUntil: null,
          version: 1,
          startedAt: null,
          finishedAt: null,
        },
        {
          ...EMPTY_SELLER_PARTS,
          errorRows: records.filter((row) => row.checkState === 'error').slice(0, VIEW_ERROR_LINES),
          previewRows: records
            .filter((row) => row.checkState === 'ready')
            .slice(0, VIEW_PREVIEW_ROWS),
        },
        now,
      ),
    );
  }
}
