import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { LocalizedText } from '../../domain/attribute-definition';
import type { VariantDisplayStyle, VariantOptionOrder } from '../../domain/variant-type-settings';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  VariantAdminReader,
  VariantTypeFeatureSet,
  VariantTypeRecord,
} from '../ports/variant-admin.reader';

// The answers of the Variant types tab (variants V6), shared by its two reads.

export interface AdminVariantTypesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantAdminReader: VariantAdminReader;
  readonly policy: CatalogMarketPolicy;
}

/** Per supported locale: whether the type's name and every active option's label exist in it. */
export interface LanguageCompleteness {
  readonly locale: string;
  readonly nameMissing: boolean;
  /** Active options without a label in this locale. */
  readonly optionsMissing: number;
}

export interface VariantTypeSummary {
  readonly id: string;
  readonly code: string;
  readonly status: 'draft' | 'active';
  readonly names: LocalizedText;
  readonly displayStyle: VariantDisplayStyle;
  readonly optionOrder: VariantOptionOrder;
  /** Active options. */
  readonly options: number;
  readonly products: number;
  readonly liveVariants: number;
  readonly featureSets: readonly {
    readonly id: string;
    readonly code: string;
    readonly names: LocalizedText;
  }[];
  readonly languages: readonly LanguageCompleteness[];
}

export interface VariantTypeOptionView {
  readonly code: string;
  readonly labels: LocalizedText;
  readonly active: boolean;
  readonly position: number;
  /** `#RRGGBB`, or null when the option has no swatch colour. */
  readonly swatch: string | null;
  readonly products: number;
}

export interface VariantTypeDetail extends VariantTypeSummary {
  /** The options in the order buyers see them in the default locale (the setting applied). */
  readonly optionList: readonly VariantTypeOptionView[];
  readonly sellerHelp: LocalizedText;
  /** The version a settings write names; 0 while the type uses the defaults. */
  readonly settingsVersion: number;
}

export function languagesOf(
  record: VariantTypeRecord,
  locales: readonly string[],
): LanguageCompleteness[] {
  const active = record.options.filter((option) => option.active);
  return locales.map((locale) => ({
    locale,
    nameMissing: !record.names[locale],
    optionsMissing: active.filter((option) => !option.labels[locale]).length,
  }));
}

export function summaryOf(
  record: VariantTypeRecord,
  counts: { readonly products: number; readonly liveVariants: number } | undefined,
  featureSets: readonly VariantTypeFeatureSet[] | undefined,
  locales: readonly string[],
): VariantTypeSummary {
  return {
    id: record.id,
    code: record.code,
    status: record.status,
    names: record.names,
    displayStyle: record.settings.displayStyle,
    optionOrder: record.settings.optionOrder,
    options: record.options.filter((option) => option.active).length,
    products: counts?.products ?? 0,
    liveVariants: counts?.liveVariants ?? 0,
    featureSets: (featureSets ?? []).map((set) => ({
      id: set.id,
      code: set.code,
      names: set.names,
    })),
    languages: languagesOf(record, locales),
  };
}
