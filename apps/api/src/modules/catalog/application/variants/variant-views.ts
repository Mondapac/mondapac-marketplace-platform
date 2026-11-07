import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { LocalizedText } from '../../domain/attribute-definition';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { VariantAdminReader, VariantIssue, VariantRow } from '../ports/variant-admin.reader';
import { issuesOf } from './variant-admin.shared';

// One row of the Variants tab (variants V6), shared by the list and the export.

export interface AdminVariantsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantAdminReader: VariantAdminReader;
  readonly policy: CatalogMarketPolicy;
}

/** One row of the Variants tab. */
export interface AdminVariantView {
  readonly productId: string;
  readonly productCode: string;
  readonly productName: string | null;
  readonly productScope: 'PLATFORM' | 'SELLER';
  /** `live`, or `paused` while the admin pause holds the product off sale. */
  readonly status: 'live' | 'paused';
  readonly variantId: string;
  readonly variantNo: number;
  readonly variantCode: string;
  /** The label in the default locale, or null when it has none. */
  readonly label: string | null;
  readonly labels: LocalizedText;
  readonly gtin: string | null;
  readonly sellers: number;
  readonly issues: readonly VariantIssue[];
  readonly missingLocales: readonly string[];
}

export function viewOf(row: VariantRow, locale: string): AdminVariantView {
  return {
    productId: row.productId,
    productCode: row.productCode,
    productName: row.productName,
    productScope: row.productScope,
    status: row.productPaused ? 'paused' : 'live',
    variantId: row.variantId,
    variantNo: row.variantNo,
    variantCode: row.variantCode,
    label: row.labels[locale] ?? null,
    labels: row.labels,
    gtin: row.gtin,
    sellers: row.sellers,
    issues: issuesOf(row),
    missingLocales: row.missingLocales,
  };
}
