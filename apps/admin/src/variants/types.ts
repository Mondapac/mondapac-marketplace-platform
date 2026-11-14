// The admin Catalogue > Variants page (variants V6): the API's shapes and the page's constants.

export const VIEW_PERMISSION = 'catalog.variant.view';
/** Protected; the settings edit also needs `catalog.attribute.edit`. */
export const TYPE_EDIT_PERMISSION = 'catalog.variant-type.edit';
export const ATTRIBUTE_EDIT_PERMISSION = 'catalog.attribute.edit';
export const ATTRIBUTE_VIEW_PERMISSION = 'catalog.attribute.view';

export const VARIANTS_PATH = '/catalog/variants';
export const ATTRIBUTES_PATH = '/catalog/attributes';
export const API_VARIANT_TYPES = 'catalog/admin/variant-types';
export const API_VARIANTS = 'catalog/admin/variants';
/** Answers the size requests of sellers (variants V7). */
export const REVIEW_PERMISSION = 'catalog.variant-request.review';
export const API_REQUESTS = 'catalog/admin/variant-requests';

/** The tabs; Waiting for you (V7) is shown to an admin who may decide size requests. */
export const TABS = ['types', 'variants', 'waiting'] as const;
export type Tab = (typeof TABS)[number];

export type Localized = Readonly<Record<string, string>>;

export const DISPLAY_STYLES = ['buttons', 'swatches', 'dropdown'] as const;
export type DisplayStyle = (typeof DISPLAY_STYLES)[number];
export const OPTION_ORDERS = ['manual', 'alphabetical', 'by-size'] as const;
export type OptionOrder = (typeof OPTION_ORDERS)[number];

/** The ready-made issue filters catalog answers ("Out of stock everywhere" is inventory's). */
export const ISSUES = [
  'no-seller-selling',
  'missing-gtin',
  'duplicate-gtin',
  'no-image',
  'missing-language',
] as const;
export type Issue = (typeof ISSUES)[number];

export interface LanguageCompleteness {
  readonly locale: string;
  readonly nameMissing: boolean;
  readonly optionsMissing: number;
}

export interface VariantTypeSummary {
  readonly id: string;
  readonly code: string;
  readonly status: 'draft' | 'active';
  readonly names: Localized;
  readonly displayStyle: DisplayStyle;
  readonly optionOrder: OptionOrder;
  readonly options: number;
  readonly products: number;
  readonly liveVariants: number;
  readonly featureSets: readonly {
    readonly id: string;
    readonly code: string;
    readonly names: Localized;
  }[];
  readonly languages: readonly LanguageCompleteness[];
}

export interface VariantTypeOption {
  readonly code: string;
  readonly labels: Localized;
  readonly active: boolean;
  readonly position: number;
  readonly swatch: string | null;
  readonly products: number;
}

export interface VariantTypeDetail extends VariantTypeSummary {
  readonly optionList: readonly VariantTypeOption[];
  readonly sellerHelp: Localized;
  readonly settingsVersion: number;
}

export interface VariantRow {
  readonly productId: string;
  readonly productCode: string;
  readonly productName: string | null;
  readonly productScope: 'PLATFORM' | 'SELLER';
  readonly status: 'live' | 'paused';
  readonly variantId: string;
  readonly variantNo: number;
  readonly variantCode: string;
  readonly label: string | null;
  readonly labels: Localized;
  readonly gtin: string | null;
  readonly sellers: number;
  readonly issues: readonly Issue[];
  readonly missingLocales: readonly string[];
}

export interface VariantPage {
  readonly items: readonly VariantRow[];
  readonly nextAfter: string | null;
}

export interface IssueCounts {
  readonly counts: Readonly<Record<Issue, number>>;
}

/** The locales of the Market, as the variant types report them (the default first). */
export function localesOf(types: readonly VariantTypeSummary[]): readonly string[] {
  return types[0]?.languages.map((language) => language.locale) ?? [];
}

/** A type's name in this locale, else the first name it has, else its code. */
export function nameOf(type: { readonly names: Localized; readonly code: string }, locale: string) {
  return type.names[locale] ?? Object.values(type.names)[0] ?? type.code;
}

/** "9 300633 01234 5" from 14 digits with a leading 0 dropped (GTIN-13 shown as printed). */
export function gtinText(gtin: string): string {
  const digits = gtin.startsWith('0') ? gtin.slice(1) : gtin;
  return digits.length === 13
    ? `${digits.slice(0, 1)} ${digits.slice(1, 7)} ${digits.slice(7, 12)} ${digits.slice(12)}`
    : digits;
}

/** `#RRGGBB` from a colour as typed (`a1b2c3`, `#A1B2C3`), or null. */
export function colourOf(raw: string): string | null {
  const text = raw.trim().replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(text) ? `#${text}` : null;
}

// Size requests (variants V7): a seller asked for a size a platform product does not have.

export interface RequestOption {
  readonly attributeCode: string;
  readonly attributeName: string;
  readonly optionCode: string;
  readonly optionLabel: string;
}

export interface RequestItem {
  readonly id: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly createdAt: string;
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly offerId: string;
  readonly productId: string;
  readonly productCode: string | null;
  readonly options: readonly RequestOption[];
  readonly existing: readonly {
    readonly variantId: string;
    readonly variantNo: number;
    readonly options: readonly RequestOption[];
  }[];
  /** The product already has it: map, do not approve. */
  readonly alreadyExists: boolean;
}

export interface RequestList {
  readonly items: readonly RequestItem[];
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
}

export interface RequestDecided {
  readonly request: {
    readonly id: string;
    readonly status: 'approved' | 'mapped' | 'declined';
    readonly version: number;
    readonly resolvedVariantId: string | null;
  };
}

/** `Size: L, Colour: Red` */
export const describeOptions = (options: readonly RequestOption[]): string =>
  options.map((option) => `${option.attributeName}: ${option.optionLabel}`).join(', ');
