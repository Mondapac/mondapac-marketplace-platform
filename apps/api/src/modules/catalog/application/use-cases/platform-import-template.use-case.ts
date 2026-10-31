import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_IMPORT_RUN } from '../../contracts/permissions';
import { IMPORT_COLUMNS, type ImportColumn } from '../../domain/platform-import/columns';
import { templateRows } from '../../domain/platform-import/columns';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { templateCsv } from '../platform-import/import-report';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { SheetWriter } from '../ports/sheet-writer';

export interface PlatformImportTemplateOutput {
  readonly columns: readonly Pick<ImportColumn, 'key' | 'header' | 'required'>[];
  /** The product type codes this Market offers and a flat file can carry. */
  readonly typesOffered: readonly string[];
  readonly limits: { readonly rows: number; readonly fileBytes: number };
  readonly filename: string;
  readonly csv: string;
  /** The same template as an `.xlsx` file (every cell text), standard base64. */
  readonly xlsxFilename: string;
  readonly xlsx: string;
}

export interface PlatformImportTemplateDependencies {
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
}

/**
 * `platform-import.template` (design 14a): the template as CSV and as XLSX and the column guide of
 * the page's first step, and the limits. Rule: the key `catalog.platform-import.run`. The example row names a
 * type the Market offers. No file is stored and nothing is read from a database.
 */
export class PlatformImportTemplate extends UseCase<
  Record<string, never>,
  PlatformImportTemplateOutput,
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-template',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_IMPORT_RUN.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportTemplateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<
    Result<
      PlatformImportTemplateOutput,
      { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' }
    >
  > {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    let types: readonly string[];
    try {
      types = this.deps.policy.productTypes(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const rows = templateRows(types.includes('simple') ? 'simple' : (types[0] ?? 'simple'));
    const parts: Uint8Array[] = [];
    try {
      for await (const chunk of this.deps.sheetWriter.xlsx('Products', asyncRows(rows))) {
        parts.push(chunk);
      }
    } catch {
      return err({ code: 'access.unavailable' });
    }
    return ok({
      columns: IMPORT_COLUMNS.map(({ key, header, required }) => ({ key, header, required })),
      typesOffered: types,
      limits: { rows: IMPORT_LIMITS.rows, fileBytes: IMPORT_LIMITS.fileBytes },
      filename: 'products-template.csv',
      csv: templateCsv(rows),
      xlsxFilename: 'products-template.xlsx',
      xlsx: Buffer.concat(parts).toString('base64'),
    });
  }
}

async function* asyncRows(rows: readonly (readonly string[])[]): AsyncGenerator<readonly string[]> {
  await Promise.resolve();
  for (const row of rows) yield row;
}
