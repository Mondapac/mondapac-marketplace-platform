import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_IMPORT_RUN } from '../../contracts/permissions';
import { IMPORT_COLUMNS, type ImportColumn } from '../../domain/platform-import/columns';
import { templateRows } from '../../domain/platform-import/columns';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { templateCsv } from '../platform-import/import-report';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface PlatformImportTemplateOutput {
  readonly columns: readonly Pick<ImportColumn, 'key' | 'header' | 'required'>[];
  /** The product type codes this Market offers and a flat file can carry. */
  readonly typesOffered: readonly string[];
  readonly limits: { readonly rows: number; readonly fileBytes: number };
  readonly filename: string;
  readonly csv: string;
}

export interface PlatformImportTemplateDependencies {
  readonly policy: CatalogMarketPolicy;
}

/**
 * `platform-import.template` (design 14a): the template CSV and the column guide of the page's
 * first step, and the limits. Rule: the key `catalog.platform-import.run`. The example row names a
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

  protected handle(
    context: CallContext,
  ): Promise<
    Result<
      PlatformImportTemplateOutput,
      { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' }
    >
  > {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    let types: readonly string[];
    try {
      types = this.deps.policy.productTypes(market);
    } catch {
      return Promise.resolve(err({ code: 'access.unavailable' }));
    }
    return Promise.resolve(
      ok({
        columns: IMPORT_COLUMNS.map(({ key, header, required }) => ({ key, header, required })),
        typesOffered: types,
        limits: { rows: IMPORT_LIMITS.rows, fileBytes: IMPORT_LIMITS.fileBytes },
        filename: 'products-template.csv',
        csv: templateCsv(
          templateRows(types.includes('simple') ? 'simple' : (types[0] ?? 'simple')),
        ),
      }),
    );
  }
}
