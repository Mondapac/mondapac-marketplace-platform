import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';

import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import {
  SELLER_COLUMNS,
  SELLER_IMPORT_MODES,
  type SellerImportMode,
} from '../../domain/seller-import/columns';

import { isActingAsSession } from '../acting-as';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

import type { SheetWriter } from '../ports/sheet-writer';
import { sellerTemplateCsv, sellerTemplateRows } from '../seller-import/seller-import-report';
import { type SellerImportCommonFailure } from '../seller-import/seller-import-support';

// The reads of the seller import (catalog design 14c). They need `catalog.own-product.view`, the
// seller population and a seller who may be signed in; an acting-as session is refused. Every read
// is scoped to the actor's seller: another seller's job answers the byte-identical
// `import.not-found` of an unknown id.

function sellerOf(context: CallContext) {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

const VIEW_KEYS = [CATALOG_OWN_PRODUCT_VIEW.key] as const;

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
