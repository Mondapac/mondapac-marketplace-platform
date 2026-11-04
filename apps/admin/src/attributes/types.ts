// Answers of the admin attribute reads (apps/api attribute-admin.dto.ts, attributes package A1).
// Names and labels are what an administrator or the seed typed per locale: rendered as plain text.

export const VIEW_PERMISSION = 'catalog.attribute.view';
export const EDIT_PERMISSION = 'catalog.attribute.edit';
export const RESTRUCTURE_PERMISSION = 'catalog.attribute.restructure';
export const BRANDS_READ_PERMISSION = 'catalog.brand.read';
export const ATTRIBUTES_PATH = '/catalog/attributes';
export const BRANDS_PATH = '/catalog/brands';
export const API_ATTRIBUTES = 'catalog/admin/attributes';
export const API_FEATURE_SETS = 'catalog/admin/feature-sets';
export const PAGE_SIZE = 50;

/** What a write answers (attributes A2): enough to read the attribute again. */
export interface AttributeWrite {
  readonly attribute: {
    readonly id: string;
    readonly code: string;
    readonly status: AttributeStatus;
    readonly version: number;
    readonly revisionNo: number;
  };
}

/** The types whose values are a list the admin keeps. */
export const CHOICE_TYPES: ReadonlySet<string> = new Set(['select', 'multi-select']);

export const DATA_TYPES = [
  'text',
  'long-text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'select',
  'multi-select',
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const STATUSES = ['active', 'draft', 'archived'] as const;
export type AttributeStatus = (typeof STATUSES)[number];

export type Localized = Readonly<Record<string, string>>;

export interface MarketLocales {
  readonly default: string;
  /** The default first. */
  readonly supported: readonly string[];
}

export interface AttributeSummary {
  readonly id: string;
  readonly code: string;
  readonly dataType: DataType;
  readonly localizable: boolean;
  readonly status: AttributeStatus;
  readonly names: Localized;
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly revisionNo: number;
  readonly missingLocales: readonly string[];
}

export interface AttributeRow extends AttributeSummary {
  readonly productCount: number;
  readonly featureSetCount: number;
}

export interface AttributePage {
  readonly items: readonly AttributeRow[];
  readonly nextAfterId: string | null;
  readonly total: number;
  readonly totalAll: number;
  readonly locales: MarketLocales;
  readonly featureSets: readonly { readonly id: string; readonly code: string }[];
  readonly truncated: boolean;
}

export interface AttributeOption {
  readonly code: string;
  readonly labels: Localized;
  readonly active: boolean;
  readonly position: number;
  readonly productCount: number;
  /** The value this one was merged into (attributes A8). */
  readonly mergedInto?: string | null;
}

export interface FeatureSetUse {
  readonly featureSetId: string;
  readonly featureSetCode: string;
  readonly featureSetStatus: string;
  readonly groupCode: string;
  readonly required: boolean;
  readonly isVariantOption: boolean;
}

export interface AttributeChange {
  readonly field: string;
  readonly before: string | number | boolean | null;
  readonly after: string | number | boolean | null;
}

export interface HistoryEntry {
  readonly revisionNo: number;
  readonly createdAt: string;
  readonly authorKind: 'seed' | 'admin';
  readonly authorAccountId: string | null;
  readonly changes: readonly AttributeChange[];
}

/** How the attribute shows and behaves (attributes A2). The internal note is admin-only. */
export interface AttributeDisplay {
  readonly helpText: Localized;
  readonly showOnProductPage: boolean;
  readonly searchable: boolean;
  readonly canBeFilter: boolean;
  readonly internalNote: string | null;
  readonly position: number;
}

export interface AttributeDetail extends AttributeSummary {
  readonly createdByKind: 'seed' | 'admin';
  readonly createdAt: string;
  readonly version: number;
  readonly bounds: { readonly maxLength?: number; readonly min?: number; readonly max?: number };
  readonly display: AttributeDisplay;
  readonly options: readonly AttributeOption[];
  readonly productCount: number;
  readonly usedIn: readonly FeatureSetUse[];
  readonly history: readonly HistoryEntry[];
  readonly historyTruncated: boolean;
  readonly locales: MarketLocales;
}

export interface FeatureSetRow {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly revisionNo: number;
  readonly groupCount: number;
  readonly attributeCount: number;
  readonly productCount: number;
}

export interface FeatureSetList {
  readonly items: readonly FeatureSetRow[];
  readonly truncated: boolean;
}

export interface FeatureSetAttribute {
  readonly code: string;
  readonly required: boolean;
  readonly isVariantOption: boolean;
  readonly attributeId: string | null;
  readonly names: Localized | null;
  readonly dataType: DataType | null;
  readonly status: string | null;
  readonly material: boolean | null;
}

export interface FeatureSetDetail {
  readonly id: string;
  readonly code: string;
  readonly status: string;
  readonly revisionNo: number;
  readonly createdAt: string;
  readonly groups: readonly {
    readonly groupCode: string;
    readonly attributes: readonly FeatureSetAttribute[];
  }[];
  readonly productCount: number;
  readonly locales: MarketLocales;
}

/** The page's tabs; Brands is a link to its own page. */
export const TABS = ['attributes', 'feature-sets', 'brands', 'waiting'] as const;
export type Tab = (typeof TABS)[number];

/** The sub-tabs of one attribute (plan 16). */
export const DETAIL_TABS = ['details', 'values', 'used-in', 'history'] as const;
export type DetailTab = (typeof DETAIL_TABS)[number];

/**
 * The English name of a locale's language ("Persian"), or the tag itself. The region shows only
 * when another of the Market's locales has the same language ("English (Australia)" next to
 * "English (United States)").
 */
export function languageName(locale: string, supported: readonly string[] = []): string {
  const base = locale.split('-')[0] ?? locale;
  const shared = supported.some((other) => other !== locale && other.split('-')[0] === base);
  try {
    return (
      new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' }).of(
        shared ? locale : base,
      ) ?? locale
    );
  } catch {
    return locale;
  }
}

/** Right-to-left scripts type and show right to left (plan 8). */
export function directionOf(locale: string): 'rtl' | 'ltr' {
  return /^(fa|ar|he|ur|ps|ckb|dv|yi)(-|$)/.test(locale) ? 'rtl' : 'ltr';
}

/** The text in this locale, else in the Market's default, else the code. */
export function textIn(
  text: Localized | null | undefined,
  locale: string,
  fallbackLocale: string,
  fallback: string,
): string {
  if (text === null || text === undefined) return fallback;
  return text[locale] ?? text[fallbackLocale] ?? fallback;
}

/** The requests to relax an attribute waiting for a second administrator (attributes A2). */
export const API_RELAXATIONS = 'catalog/admin/attribute-relaxations';

export type RelaxationKind = 'clear-material' | 'archive' | 'remove-from-family';

interface RelaxationAction {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface OpenRelaxation {
  readonly id: string;
  readonly version: number;
  readonly kind: RelaxationKind;
  readonly attribute: {
    readonly id: string;
    readonly code: string;
    readonly names: Localized;
    readonly version: number;
  };
  /** The reader's own request: they may withdraw it, not confirm it. */
  readonly mine: boolean;
  /** The requesting administrator; their display name waits for an identity read. */
  readonly requestedByAccountId: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly allowedActions: {
    readonly confirm: RelaxationAction;
    readonly cancel: RelaxationAction;
  };
}

export interface OpenRelaxationList {
  readonly requests: readonly OpenRelaxation[];
}

/** A count the server may have cut short: `atLeast` means the real number is this or more. */
export interface ImpactCount {
  readonly count: number;
  readonly atLeast: boolean;
}

/** What a merge or an archive reaches (attributes A8; `GET .../attributes/:id/impact`). */
export interface ImpactAnswer {
  readonly attribute: {
    readonly id: string;
    readonly code: string;
    readonly status: AttributeStatus;
    readonly version: number;
    readonly material: boolean;
    readonly isVariantOption: boolean;
    readonly dataType: string;
  };
  readonly impact: {
    readonly publishedProducts: ImpactCount;
    readonly drafts: ImpactCount;
    readonly featureSetCount: number;
    readonly featureSets: readonly {
      readonly id: string;
      readonly code: string;
      readonly names: Localized;
    }[];
    readonly categories: ImpactCount;
    readonly filters: ImpactCount;
    readonly liveVariantProducts: ImpactCount;
  };
}

export const API_ARCHIVE_REQUESTS = 'catalog/admin/attribute-archive-requests';
