import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import {
  SELLER_COLUMNS,
  SELLER_IMPORT_MODES,
  type SellerImportMode,
} from '../../domain/seller-import/columns';
import type {
  SellerImportJob,
  SellerRowRecord,
} from '../../domain/seller-import/seller-import-job';
import { isActingAsSession } from '../acting-as';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import type { SheetWriter } from '../ports/sheet-writer';
import {
  sellerErrorReportCsv,
  sellerFullReportCsv,
  sellerTemplateCsv,
  sellerTemplateRows,
} from '../seller-import/seller-import-report';
import {
  loadSellerView,
  sellerImportIdOf,
  type SellerImportCommonFailure,
  type SellerImportView,
} from '../seller-import/seller-import-support';

// The reads of the seller import (catalog design 14c). They need `catalog.own-product.view`, the
// seller population and a seller who may be signed in; an acting-as session is refused. Every read
// is scoped to the actor's seller: another seller's job answers the byte-identical
// `import.not-found` of an unknown id.

function sellerOf(context: CallContext) {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

const VIEW_KEYS = [CATALOG_OWN_PRODUCT_VIEW.key] as const;

export interface OwnImportReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerJobs: SellerImportRepository;
  readonly clock: Clock;
}

export interface OwnImportReadInput {
  /** The import to read, or null for the seller's latest (what the page opens on). */
  readonly importId: unknown;
}

/**
 * `own-import.read` (design 14c): the state of an import for the page, which also answers the
 * progress poll and, with no id, the seller's latest import or `null` (`own-import.current`).
 */
export class OwnImportRead extends UseCase<
  OwnImportReadInput,
  SellerImportView | null,
  SellerImportCommonFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-read',
    rule: { kind: 'permissions', allOf: VIEW_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportReadInput,
  ): Promise<Result<SellerImportView | null, SellerImportCommonFailure>> {
    const { market } = context;
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const wanted = input?.importId ?? null;
    const id = wanted === null ? null : sellerImportIdOf(wanted);
    if (wanted !== null && id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { sellerJobs, clock } = this.deps;
    const read = await this.deps.unitOfWork.run<SellerImportView | null, SellerImportCommonFailure>(
      market,
      async () => {
        const job =
          id === null
            ? await sellerJobs.latestOf(market, sellerId)
            : await sellerJobs.find(market, sellerId, id);
        if (job === null) return id === null ? ok(null) : err({ code: 'import.not-found' } as const);
        return ok(await loadSellerView(sellerJobs, market, job, clock.now()));
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return read.error.code === 'import.not-found' ? read : err({ code: 'access.unavailable' });
    }
    return read;
  }
}

export interface OwnImportReportInput {
  readonly importId: unknown;
  readonly kind: unknown;
}

export interface OwnImportReportOutput {
  readonly filename: string;
  readonly contentType: 'text/csv; charset=utf-8';
  readonly body: string;
}

export type OwnImportReportFailure =
  SellerImportCommonFailure | { readonly code: 'import.report-unavailable' };

const REPORT_PAGE = 500;

/**
 * `own-import.report` (design 14c): the two CSV reports of a job. `errors` is the check's error
 * report, from the check on; `full` is the run's report, once the run finished or stopped. Each
 * cell a spreadsheet would run as a formula is written with a leading quote; the download name is
 * built from the date, never from the upload's name.
 */
export class OwnImportReport extends UseCase<
  OwnImportReportInput,
  OwnImportReportOutput,
  OwnImportReportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-report',
    rule: { kind: 'permissions', allOf: VIEW_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportReportInput,
  ): Promise<Result<OwnImportReportOutput, OwnImportReportFailure>> {
    const { market } = context;
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const id = sellerImportIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    if (input.kind !== 'errors' && input.kind !== 'full') {
      return err({ code: 'validation.failed', fields: [{ path: 'kind', code: 'enum' }] });
    }
    const kind = input.kind;
    const { sellerJobs } = this.deps;
    const read = await this.deps.unitOfWork.run<
      { job: SellerImportJob; rows: SellerRowRecord[] },
      OwnImportReportFailure
    >(
      market,
      async () => {
        const job = await sellerJobs.find(market, sellerId, id);
        if (job === null) return err({ code: 'import.not-found' } as const);
        if (kind === 'full' && job.state !== 'finished' && job.state !== 'stopped') {
          return err({ code: 'import.report-unavailable' } as const);
        }
        if (kind === 'errors' && job.state === 'discarded') {
          return err({ code: 'import.report-unavailable' } as const);
        }
        const rows: SellerRowRecord[] = [];
        for (let offset = 0; ; offset += REPORT_PAGE) {
          const page = await sellerJobs.rows(
            market,
            id,
            kind === 'errors' ? { checkState: 'error' } : {},
            { offset, limit: REPORT_PAGE },
          );
          rows.push(...page);
          if (page.length < REPORT_PAGE || rows.length >= IMPORT_LIMITS.rows) break;
        }
        return ok({ job, rows });
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return read.error.code === 'import.not-found' ||
        read.error.code === 'import.report-unavailable'
        ? read
        : err({ code: 'access.unavailable' });
    }
    const date = this.deps.clock.now().toString().slice(0, 10);
    return ok({
      filename: kind === 'errors' ? `import-errors-${date}.csv` : `import-report-${date}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body:
        kind === 'errors'
          ? sellerErrorReportCsv(read.value.rows)
          : sellerFullReportCsv(read.value.job, read.value.rows),
    });
  }
}

export interface OwnImportTemplateOutput {
  readonly modes: readonly {
    readonly mode: SellerImportMode;
    readonly columns: readonly {
      readonly key: string;
      readonly header: string;
      readonly required: boolean;
    }[];
    readonly filename: string;
    readonly csv: string;
    readonly xlsxFilename: string;
    /** The same template as an `.xlsx` file (every cell text), standard base64. */
    readonly xlsx: string;
  }[];
  readonly typesOffered: readonly string[];
  readonly limits: { readonly rows: number; readonly fileBytes: number };
}

export interface OwnImportTemplateDependencies {
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
}

/**
 * `own-import.template` (design 14c): the template of each mode as CSV and as XLSX, the column
 * guide and the limits. No file is stored and nothing is read from a database.
 */
export class OwnImportTemplate extends UseCase<
  Record<string, never>,
  OwnImportTemplateOutput,
  SellerImportCommonFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-template',
    rule: { kind: 'permissions', allOf: VIEW_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportTemplateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OwnImportTemplateOutput, SellerImportCommonFailure>> {
    const { market } = context;
    if (sellerOf(context) === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    let types: readonly string[];
    try {
      types = this.deps.policy.productTypes(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const example = types.includes('simple') ? 'simple' : (types[0] ?? 'simple');
    const modes: OwnImportTemplateOutput['modes'][number][] = [];
    for (const mode of SELLER_IMPORT_MODES) {
      const rows = sellerTemplateRows(mode, example);
      const parts: Uint8Array[] = [];
      try {
        for await (const chunk of this.deps.sheetWriter.xlsx('Products', asyncRows(rows))) {
          parts.push(chunk);
        }
      } catch {
        return err({ code: 'access.unavailable' });
      }
      modes.push({
        mode,
        columns: SELLER_COLUMNS.filter((column) => column.modes.includes(mode)).map((column) => ({
          key: column.key,
          header: column.header,
          required: column.requiredIn.includes(mode),
        })),
        filename: `${mode}-template.csv`,
        csv: sellerTemplateCsv(rows),
        xlsxFilename: `${mode}-template.xlsx`,
        xlsx: Buffer.concat(parts).toString('base64'),
      });
    }
    return ok({
      modes,
      typesOffered: types,
      limits: { rows: IMPORT_LIMITS.rows, fileBytes: IMPORT_LIMITS.fileBytes },
    });
  }
}

async function* asyncRows(rows: readonly (readonly string[])[]): AsyncGenerator<readonly string[]> {
  await Promise.resolve();
  for (const row of rows) yield row;
}
