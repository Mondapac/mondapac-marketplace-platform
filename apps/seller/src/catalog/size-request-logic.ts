import { pickLabel, variantRowsOf } from './draft-content.ts';
import { axesOf } from './variant-grid.ts';
import type { ProductView } from './types.ts';

// The pure half of "Request a size" (variants V7): which axes a seller may ask a size on, and
// the requests as the seller's list shows them.

export const REQUEST_STATUSES = ['open', 'approved', 'mapped', 'declined'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface RequestAxis {
  readonly code: string;
  readonly name: string;
  readonly options: readonly { readonly code: string; readonly label: string }[];
}

/** One request of the seller (`GET catalog/seller/variant-requests` -> `items`). */
export interface SizeRequestItem {
  readonly id: string;
  readonly offerId: string;
  readonly productId: string;
  readonly productCode: string | null;
  readonly status: RequestStatus;
  readonly options: readonly {
    readonly attributeCode: string;
    readonly attributeName: string;
    readonly optionCode: string;
    readonly optionLabel: string;
  }[];
  readonly resolvedVariantId: string | null;
  /** The reviewer's words for a declined request. Plain text. */
  readonly declineReason: string | null;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

/** `GET catalog/seller/variant-requests`. */
export interface SizeRequestsView {
  readonly items: readonly SizeRequestItem[];
  readonly nextAfterId: string | null;
  readonly openCount: number;
  readonly maxOpen: number;
}

/** What the offer's variants page shows for sizes (null: the product takes no request). */
export interface SizeRequestsData {
  readonly axes: readonly RequestAxis[];
  /** The seller's requests for this offer. */
  readonly items: readonly SizeRequestItem[];
  readonly openCount: number;
  readonly maxOpen: number;
}

/**
 * The axes of a product (its published version, else its draft) with every option of the field.
 * The API checks that each option is active and that the combination is new; the form only
 * offers what the product's family has.
 */
export function requestAxesOf(product: ProductView, locale: string): RequestAxis[] {
  const content = product.published?.content ?? product.workingCopy?.content;
  const rows = variantRowsOf(content, product.variants);
  const codes = axesOf(content, rows, product.form.fields);
  const axes: RequestAxis[] = [];
  for (const code of codes) {
    const field = product.form.fields.find((item) => item.code === code);
    if (field === undefined || field.options.length === 0) continue;
    axes.push({
      code,
      name: pickLabel(field.names, locale, code),
      options: field.options.map((option) => ({
        code: option.code,
        label: pickLabel(option.labels, locale, option.code),
      })),
    });
  }
  return axes;
}

/** The message key (under `catalog.size-requests.error`) for a refused request. */
const BY_CODE: Readonly<Record<string, string>> = {
  'offer.not-found': 'not-found',
  'variant-request.option-unknown': 'option-unknown',
  'variant-request.variant-exists': 'variant-exists',
  'variant-request.already-open': 'already-open',
  'variant-request.limit-reached': 'limit-reached',
  'variant-request.daily-limit': 'daily-limit',
  'variant-request.options-invalid': 'option-unknown',
  'variant-request.product-unavailable': 'not-configurable',
  'variant-request.not-configurable': 'not-configurable',
  'access.seller-not-approved': 'not-eligible',
  'seller.not-eligible': 'not-eligible',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
};

export function requestProblemOf(failure: {
  readonly status: number;
  readonly code: string;
}): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.code === 'validation.failed') return 'invalid';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}
