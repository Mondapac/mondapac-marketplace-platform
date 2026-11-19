import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportColumns,
  parseExportFormat,
  parseExportIds,
  type ExportCell,
  type ExportFile,
  type SheetWriter,
} from '../../../../platform/list-export';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_READ } from '../../contracts/permissions';
import type { BrandState, BrandStatus } from '../../domain/brand';
import {
  BRAND_PAGE_DEFAULT,
  BRAND_PAGE_MAX,
  brandIdOf,
  closedInput,
  invalid,
  statusFilterOf,
  type ValidationFailure,
} from '../brands/brand-views';
import { readCatalogListInput } from '../lists/catalog-list-input';
import { BRAND_SORTS, type BrandReader } from '../ports/brand.reader';
import { BRAND_MAX_PAGE } from './brand-list.use-case';

export { EXPORT_FORMATS } from '../../../../platform/list-export';

/** Brands one export may hold; more is refused whole and the admin narrows the filter. */
export const BRAND_EXPORT_MAX_ROWS = LIST_EXPORT_MAX_ROWS;
/** The most selected brands one export names (`ids`), the bulk limit of the super lists. */
export const BRAND_EXPORT_MAX_IDS = 200;
/** The optional columns, in the order the column picker may name them. */
export const BRAND_EXPORT_COLUMNS = ['id', 'created', 'summary'] as const;
export type BrandExportColumn = (typeof BRAND_EXPORT_COLUMNS)[number];
/** Brands written per chunk while the file streams. */
const CHUNK = 500;

const OWN_KEYS = ['format', 'columns', 'ids'] as const;
const SELECTOR_KEYS = ['status', 'q', 'search', 'sort', 'direction'] as const;

export const BRAND_EXPORT_HEADERS: Readonly<
  Record<BrandExportColumn | 'name' | 'slug' | 'status' | 'origin' | 'updated', string>
> = Object.freeze({
  name: 'Brand',
  slug: 'Slug',
  status: 'Status',
  origin: 'Origin country',
  updated: 'Last changed',
  id: 'Brand id',
  created: 'Created',
  summary: 'Summary',
});

const STATUS_LABELS: Readonly<Record<BrandStatus, string>> = Object.freeze({
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
});

export interface BrandExportInput {
  readonly format?: unknown;
  /** Comma-separated optional columns, in the order shown. */
  readonly columns?: unknown;
  /** Comma-separated brand ids (the selected rows); without it the list's filter picks them. */
  readonly ids?: unknown;
  readonly [selectorKey: string]: unknown;
}

export type BrandExportOutput = ExportFile;

export type BrandExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'brand.not-found' }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ValidationFailure;

export interface BrandExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

/**
 * `brand.export` (catalog brand package, super list 8; the products export pattern): the brands of
 * the admin Brands list as a CSV (default) or XLSX file. Brand, slug, status, origin country and
 * last change are always there; `columns` adds `id`, `created`, `summary` in the order given. The
 * brands are the selected `ids` (at most {@link BRAND_EXPORT_MAX_IDS}, in the order given; an id
 * that is no brand refuses the whole request as `brand.not-found`) or every brand the list's
 * filter matches (`status`, `q` or its older name `search`, `sort`, `direction`; the same reading
 * as `brand.list`), at most {@link BRAND_EXPORT_MAX_ROWS} (more is `batch.too-large` with the
 * total). Rule: the key `catalog.brand.read` and the admin population, as the list. One read-only
 * unit before the first byte; CSV text cells a spreadsheet would run as a formula get a leading
 * quote, XLSX cells are all string values (the shared export writer).
 */
export class BrandExport extends UseCase<BrandExportInput, BrandExportOutput, BrandExportFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-export',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_READ.key] },
  };

  readonly #logger = new Logger('BrandExport');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandExportInput,
  ): Promise<Result<BrandExportOutput, BrandExportFailure>> {
    const result = await this.#export(context, input);
    this.#logger.log({
      msg: 'catalog.brand-export',
      code: result.ok ? 'exported' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #export(
    context: CallContext,
    input: BrandExportInput,
  ): Promise<Result<BrandExportOutput, BrandExportFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, [...OWN_KEYS, ...SELECTOR_KEYS]);
    if (!body.ok) return body;
    const format = parseExportFormat(body.value['format']);
    if (!format.ok) return format;
    const columns = parseExportColumns(body.value['columns'], BRAND_EXPORT_COLUMNS);
    if (!columns.ok) return columns;
    // The filter is read even when ids pick the brands, so a malformed one is never ignored.
    const status = statusFilterOf(body.value['status']);
    if (!status.ok) return status;
    const read = readCatalogListInput(
      Object.fromEntries(
        SELECTOR_KEYS.filter((key) => key !== 'status' && body.value[key] !== undefined).map(
          (key) => [key, body.value[key]],
        ),
      ),
      {
        sorts: BRAND_SORTS,
        defaultSort: 'name',
        defaultDirection: (sort) => (sort === 'name' ? 'asc' : 'desc'),
        pageDefault: BRAND_PAGE_DEFAULT,
        pageMax: BRAND_PAGE_MAX,
        maxPage: BRAND_MAX_PAGE,
        cursorIdOf: () => null,
      },
    );
    if (!read.ok) return read;
    if (read.value.mode !== 'page') return invalid('query', 'type');
    const { paged, q } = read.value;

    const rawIds = body.value['ids'];
    let ids: readonly Id<'Brand'>[] | null = null;
    if (rawIds !== undefined && rawIds !== '') {
      if (typeof rawIds !== 'string') return invalid('ids', 'type');
      const listed = parseExportIds(rawIds, BRAND_EXPORT_MAX_IDS, (part) => {
        const parsed = brandIdOf(part, 'ids');
        return parsed.ok ? parsed.value : null;
      });
      if (!listed.ok) return listed;
      ids = listed.value;
    }

    const { deps } = this;
    const { market } = context;
    const filter = { status: status.value, search: q };
    const unit = await deps.unitOfWork.run(
      market,
      async (): Promise<Result<{ rows: readonly BrandState[]; total: number }, never>> => {
        if (ids !== null) {
          const found = await deps.brandReader.byIds(market, ids);
          const byId = new Map(found.map((row) => [row.id as string, row]));
          const rows = ids.flatMap((id) => {
            const row = byId.get(id);
            return row === undefined ? [] : [row];
          });
          return ok({ rows, total: rows.length });
        }
        const rows = await deps.brandReader.page(market, {
          ...filter,
          sort: paged.sort,
          direction: paged.direction,
          offset: 0,
          limit: BRAND_EXPORT_MAX_ROWS + 1,
        });
        const total =
          rows.length > BRAND_EXPORT_MAX_ROWS
            ? await deps.brandReader.count(market, filter)
            : rows.length;
        return ok({ rows, total });
      },
      { readOnly: true },
    );
    if (!unit.ok) return err({ code: 'access.unavailable' });
    if (ids !== null && unit.value.rows.length !== ids.length) {
      return err({ code: 'brand.not-found' });
    }
    const size = checkExportSize(unit.value.rows.length, unit.value.total);
    if (!size.ok) return size;

    return ok(
      buildExportFile({
        format: format.value,
        baseName: 'brands',
        sheetName: 'Brands',
        day: deps.clock.now().toString().slice(0, 10),
        groups: groupsOf(unit.value.rows, columns.value),
        sheetWriter: deps.sheetWriter,
      }),
    );
  }
}

/** The rows of the file, the header group first, then one group per {@link CHUNK} brands. */
function* rowGroups(
  rows: readonly BrandState[],
  columns: readonly BrandExportColumn[],
): Generator<readonly (readonly ExportCell[])[]> {
  yield [
    [
      BRAND_EXPORT_HEADERS.name,
      BRAND_EXPORT_HEADERS.slug,
      BRAND_EXPORT_HEADERS.status,
      BRAND_EXPORT_HEADERS.origin,
      BRAND_EXPORT_HEADERS.updated,
      ...columns.map((column) => BRAND_EXPORT_HEADERS[column]),
    ],
  ];
  for (let start = 0; start < rows.length; start += CHUNK) {
    yield rows
      .slice(start, start + CHUNK)
      .map((row) => [
        row.name,
        row.slug,
        STATUS_LABELS[row.status],
        row.originCountry ?? '',
        row.updatedAt.toString(),
        ...columns.map((column) => cellOf(column, row)),
      ]);
  }
}

/** The groups as the export writer reads them: one chunk of the file per group, lazily. */
function groupsOf(
  rows: readonly BrandState[],
  columns: readonly BrandExportColumn[],
): AsyncIterable<readonly (readonly ExportCell[])[]> {
  return {
    [Symbol.asyncIterator]: () => {
      const groups = rowGroups(rows, columns);
      return {
        next: () => Promise.resolve(groups.next()),
        return: () => Promise.resolve(groups.return(undefined)),
      };
    },
  };
}

function cellOf(column: BrandExportColumn, row: BrandState): ExportCell {
  switch (column) {
    case 'id':
      return row.id;
    case 'created':
      return row.createdAt.toString();
    case 'summary':
      return row.summary ?? '';
  }
}
