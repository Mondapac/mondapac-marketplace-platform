import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import {
  ATTRIBUTE_LOAD_MAX,
  FEATURE_SET_LOAD_MAX,
  marketLocalesOf,
} from '../attributes/attribute-admin-views';
import {
  featureSetsTable,
  hasValues,
  tableOf,
  type Cell,
  type Table,
} from '../attribute-files/export-rows';
import { closedInput, invalid, type ValidationFailure } from '../brands/brand-views';
import type { AttributeAdminReader, CountedField } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import { csvChunks, textRows } from '../products/products-csv';

/** Rows one export may hold; more is refused whole (413) and the admin narrows with `missing`. */
export const ATTRIBUTE_EXPORT_MAX_ROWS = 20_000;
/** Rows written per chunk of the file. */
const CHUNK = 500;

export const ATTRIBUTE_EXPORT_KINDS = ['attributes', 'values', 'feature-sets'] as const;
export type AttributeExportKind = (typeof ATTRIBUTE_EXPORT_KINDS)[number];

export interface AttributeFilesExportInput {
  readonly kind?: unknown;
  readonly format?: unknown;
  readonly missing?: unknown;
}

export interface AttributeFilesExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type AttributeFilesExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'batch.too-large'; readonly max: number }
  | ValidationFailure;

export interface AttributeFilesExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

/**
 * `attribute-files.export` (attributes plan, package A9): the attributes, their values or the
 * feature sets of the request's Market as a CSV (the default) or XLSX file, with one column per
 * language of the Market (`name[en-AU]`, `name[fa-AU]`, ...) and the number of products that use
 * each row. `missing=<locale>` keeps only what has no text in that language, in the same columns,
 * so the file can be filled in and imported as it is (attributes: the name is missing; values:
 * an active value's label is missing; not allowed for feature sets). Rule: the key
 * `catalog.attribute.view` and the admin population. The text of the file is data: a cell that a
 * spreadsheet would run as a formula gets a leading quote in CSV and is a plain string in XLSX.
 * One read-only unit; a Market with more rows than {@link ATTRIBUTE_EXPORT_MAX_ROWS} is refused whole.
 */
export class AttributeFilesExport extends UseCase<
  AttributeFilesExportInput,
  AttributeFilesExportOutput,
  AttributeFilesExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-files-export',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  readonly #logger = new Logger('AttributeFilesExport');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeFilesExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeFilesExportInput,
  ): Promise<Result<AttributeFilesExportOutput, AttributeFilesExportFailure>> {
    const result = await this.#export(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-files-export',
      code: result.ok ? 'exported' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #export(
    context: CallContext,
    input: AttributeFilesExportInput,
  ): Promise<Result<AttributeFilesExportOutput, AttributeFilesExportFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, ['kind', 'format', 'missing']);
    if (!body.ok) return body;
    const kind = body.value['kind'];
    if (typeof kind !== 'string' || !(ATTRIBUTE_EXPORT_KINDS as readonly string[]).includes(kind)) {
      return invalid('kind', kind === undefined ? 'required' : 'unknown');
    }
    const exportKind = kind as AttributeExportKind;
    const format = body.value['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    const { market } = context;
    const { deps } = this;
    let locales: ReturnType<typeof marketLocalesOf>;
    try {
      locales = marketLocalesOf(deps.policy.locales(market));
    } catch {
      return err({ code: 'access.unavailable' });
    }
    let missing: string | null = null;
    const rawMissing = body.value['missing'];
    if (rawMissing !== undefined && rawMissing !== null && rawMissing !== '') {
      if (typeof rawMissing !== 'string' || !locales.supported.includes(rawMissing)) {
        return invalid('missing', 'unsupported');
      }
      if (kind === 'feature-sets') return invalid('missing', 'not-allowed');
      missing = rawMissing;
    }

    let table: Table;
    try {
      const read = await deps.unitOfWork.run(
        market,
        async () => ok(await this.#table(context, exportKind, locales.supported, missing)),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'access.unavailable' });
      table = read.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    if (table === TOO_LARGE || table.rows.length > ATTRIBUTE_EXPORT_MAX_ROWS) {
      return err({ code: 'batch.too-large', max: ATTRIBUTE_EXPORT_MAX_ROWS });
    }

    const day = deps.clock.now().toString().slice(0, 10);
    const name = `${kind}${missing === null ? '' : `-missing-${missing}`}-${day}`;
    const groups = groupsOf(table);
    if (format === 'xlsx') {
      return ok({
        filename: `${name}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx(sheetNameOf(exportKind), textRows(groups)),
      });
    }
    return ok({
      filename: `${name}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(groups),
    });
  }

  async #table(
    context: CallContext,
    kind: AttributeExportKind,
    locales: readonly string[],
    missing: string | null,
  ): Promise<Table> {
    const { market } = context;
    const reader = this.deps.attributeAdminReader;
    if (kind === 'feature-sets') {
      const featureSets = await reader.featureSets(market, FEATURE_SET_LOAD_MAX);
      if (featureSets.length >= FEATURE_SET_LOAD_MAX) return TOO_LARGE;
      const productCounts = await reader.featureSetProductCounts(
        market,
        featureSets.map((set) => set.id),
      );
      return featureSetsTable({ locales, featureSets, productCounts });
    }
    const definitions = await reader.definitions(market, ATTRIBUTE_LOAD_MAX);
    if (definitions.length >= ATTRIBUTE_LOAD_MAX) return TOO_LARGE;
    const fields: CountedField[] = definitions.map((d) => ({
      code: d.code,
      isVariantOption: d.revision.isVariantOption,
    }));
    const productCounts =
      kind === 'attributes'
        ? await reader.productCounts(market, fields)
        : new Map<string, number>();
    const valueCounts = new Map<string, number>();
    if (kind === 'values') {
      for (const definition of definitions.filter(hasValues)) {
        const counts = await reader.optionProductCounts(
          market,
          {
            code: definition.code,
            isVariantOption: definition.revision.isVariantOption,
            dataType: definition.dataType,
          },
          definition.revision.options.map((option) => option.code),
        );
        for (const [value, count] of counts) valueCounts.set(`${definition.code}:${value}`, count);
      }
    }
    return tableOf(kind, { locales, missing, definitions, productCounts, valueCounts });
  }
}

/** A marker for a read that hit its bound. */
const TOO_LARGE: Table = Object.freeze({ header: [], rows: [] });

const sheetNameOf = (kind: AttributeExportKind): string =>
  kind === 'attributes' ? 'Attributes' : kind === 'values' ? 'Values' : 'Feature sets';

/** The header, then the rows in chunks of {@link CHUNK}. */
async function* groupsOf(table: Table): AsyncGenerator<readonly (readonly Cell[])[]> {
  yield [table.header];
  for (let from = 0; from < table.rows.length; from += CHUNK) {
    // Lets the event loop run between chunks, so a client that left is noticed.
    await Promise.resolve();
    yield table.rows.slice(from, from + CHUNK);
  }
}
