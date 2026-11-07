// Answers of the platform product routes (apps/api platform-product.dto.ts). Instants are ISO 8601
// strings in UTC. The admin panel writes the default language only: the buyer languages are
// translated after publishing (john, 25 Oct and 31 Oct).

export const EDIT_PERMISSION = 'catalog.platform-product.edit';
export const BASE = 'catalog/admin/platform-products';
/** The bulk route; the form calls it with one id to turn a published product off or on. */
export const BULK = 'catalog/admin/products/bulk';
export const PAUSE_PERMISSION = 'catalog.product.pause';

export interface FormOption {
  readonly code: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** One field of the product family. */
export interface FormField {
  readonly code: string;
  readonly dataType: string;
  readonly localizable: boolean;
  readonly required: boolean;
  readonly isVariantOption: boolean;
  readonly bounds: { readonly maxLength?: number; readonly min?: number; readonly max?: number };
  readonly names: Readonly<Record<string, string>>;
  readonly options: readonly FormOption[];
}

export interface FormCategory {
  readonly categoryId: string;
  readonly parentId: string | null;
  readonly names: Readonly<Record<string, string>>;
}

export interface ProductForm {
  readonly taxCategoryCodes: readonly string[];
  readonly fields: readonly FormField[];
  readonly categories: readonly FormCategory[];
}

export interface Locales {
  readonly default: string;
  readonly supported: readonly string[];
}

/** `GET catalog/admin/platform-products/options`. */
export interface ProductOptions {
  readonly productTypes: readonly string[];
  readonly locales: Locales;
}

/** `POST catalog/admin/platform-products`. */
export interface ProductCreated {
  readonly productId: string;
  readonly productCode: string;
  readonly variantIds: readonly string[];
}

/** `GET catalog/admin/platform-products/:id`. */
export interface ProductView {
  readonly productId: string;
  readonly productCode: string;
  readonly typeCode: string;
  readonly familyCode: string;
  /** `single`: one fixed variant; `configurable`: variants defined by option values. */
  readonly variantModel: string;
  readonly status: string;
  /** When an admin paused the product (offers off sale); null when it is not paused. */
  readonly pausedAt: string | null;
  /** The offers on it (not deleted), every seller; read only. */
  readonly offers: { readonly sellerCount: number; readonly offerCount: number };
  readonly variants: readonly { readonly variantId: string; readonly state: string }[];
  readonly maxVariants: number;
  readonly lastChangedAt: string;
  readonly createdAt: string;
  readonly form: ProductForm;
  readonly locales: Locales;
  readonly workingCopy: {
    readonly content: Readonly<Record<string, unknown>>;
    readonly lastSavedAt: string;
    readonly baseRevisionId: string | null;
  } | null;
  readonly published: {
    readonly revisionId: string;
    readonly revisionNo: number;
    readonly submittedAt: string;
    readonly content: Readonly<Record<string, unknown>>;
  } | null;
}

/** `PUT catalog/admin/platform-products/:id/draft`. */
export interface DraftSaved {
  readonly variantIds: readonly string[];
  readonly refusedFields: readonly {
    readonly field: string;
    readonly ref: string | null;
    readonly locale: string;
    readonly code: string;
  }[];
}

/** `POST catalog/admin/platform-products/:id/submit`. */
export interface Submitted {
  readonly revisionId: string;
  readonly revisionNo: number;
  readonly published: boolean;
}

/** A code from the API as readable text (`dry-goods` to `Dry goods`). */
export function readable(code: string): string {
  const text = code.replace(/[-_]+/g, ' ').trim();
  return text === '' ? code : text.charAt(0).toUpperCase() + text.slice(1);
}

/** One photo of a platform product's library: `GET catalog/admin/platform-products/:id/images`. */
export interface ProductImage {
  readonly imageId: string;
  readonly width: number;
  readonly height: number;
  readonly createdAt: string;
}

/** `POST catalog/admin/products/bulk` with one product id. */
export interface BulkAnswer {
  readonly counts: { readonly done: number; readonly skipped: number; readonly failed: number };
  readonly results: readonly {
    readonly productId: string;
    readonly outcome: 'done' | 'skipped' | 'failed';
    readonly reason?: string;
  }[];
}
