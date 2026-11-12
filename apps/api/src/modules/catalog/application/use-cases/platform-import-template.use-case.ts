import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_IMPORT_RUN } from '../../contracts/permissions';
import {
  ATTRIBUTE_COLUMNS_MAX,
  attributeColumn,
  IMPORT_COLUMNS,
  templateRows,
  type ImportColumn,
} from '../../domain/platform-import/columns';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ATTRIBUTE_LOAD_MAX } from '../attributes/attribute-admin-views';
import { templateCsv } from '../platform-import/import-report';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { SheetWriter } from '../ports/sheet-writer';

export interface PlatformImportTemplateInput {
  /** The code of a feature set: the template then has an `attr[<code>]` column for each of its attributes. */
  readonly featureSet?: string;
}

export type PlatformImportTemplateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'feature-set.unknown' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface PlatformImportTemplateOutput {
  readonly columns: readonly Pick<ImportColumn, 'key' | 'header' | 'required'>[];
  /** The product type codes this Market offers and a flat file can carry. */
  readonly typesOffered: readonly string[];
  readonly limits: { readonly rows: number; readonly fileBytes: number };
  /** The `attr[<code>]` columns added for the feature set asked for (none otherwise). */
  readonly attributeColumns: readonly string[];
  readonly filename: string;
  readonly csv: string;
  /** The same template as an `.xlsx` file (every cell text), standard base64. */
  readonly xlsxFilename: string;
  readonly xlsx: string;
}

export interface PlatformImportTemplateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
}

/**
 * `platform-import.template` (design 14a): the template as CSV and as XLSX and the column guide of
 * the page's first step, and the limits. Rule: the key `catalog.platform-import.run`. The example row names a
 * type the Market offers. No file is stored and nothing is read from a database.
 */
export class PlatformImportTemplate extends UseCase<
  PlatformImportTemplateInput,
  PlatformImportTemplateOutput,
  PlatformImportTemplateFailure
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
    input: PlatformImportTemplateInput,
  ): Promise<Result<PlatformImportTemplateOutput, PlatformImportTemplateFailure>> {
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
    let attributeCodes: readonly string[] = [];
    if (input?.featureSet !== undefined) {
      if (
        typeof input.featureSet !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.featureSet)
      ) {
        return err({
          code: 'validation.failed',
          fields: [{ path: 'featureSet', code: 'format' }],
        });
      }
      const found = await this.#attributesOf(context, input.featureSet);
      if (!found.ok) return found;
      attributeCodes = found.value;
    }
    const rows = templateRows(
      types.includes('simple') ? 'simple' : (types[0] ?? 'simple'),
      attributeCodes,
    );
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
      attributeColumns: attributeCodes.map(attributeColumn),
      filename: 'products-template.csv',
      csv: templateCsv(rows),
      xlsxFilename: 'products-template.xlsx',
      xlsx: Buffer.concat(parts).toString('base64'),
    });
  }

  /** The attribute codes of a feature set, in the order of its groups, at most the columns a file may carry. */
  async #attributesOf(
    context: CallContext,
    featureSet: string,
  ): Promise<Result<readonly string[], PlatformImportTemplateFailure>> {
    const { market } = context;
    let sets;
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () =>
          ok(await this.deps.attributeAdminReader.featureSets(market, ATTRIBUTE_LOAD_MAX)),
        { readOnly: true },
      );
      if (!read.ok || read.value.length >= ATTRIBUTE_LOAD_MAX) {
        return err({ code: 'access.unavailable' });
      }
      sets = read.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const set = sets.find((candidate) => candidate.code === featureSet);
    if (set === undefined) return err({ code: 'feature-set.unknown' });
    const codes: string[] = [];
    for (const group of set.groups) {
      for (const entry of group.attributes) {
        if (!codes.includes(entry.code) && codes.length < ATTRIBUTE_COLUMNS_MAX)
          codes.push(entry.code);
      }
    }
    return ok(codes);
  }
}

async function* asyncRows(rows: readonly (readonly string[])[]): AsyncGenerator<readonly string[]> {
  await Promise.resolve();
  for (const row of rows) yield row;
}
