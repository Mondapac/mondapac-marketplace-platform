// Answers and keys of the Market's Offer review policy routes (apps/api settings module; risk-based
// Offer approval). The panel follows what the API answers; it decides nothing.

export const OFFER_REVIEW_VIEW_PERMISSION = 'settings.offer-review.view';
export const OFFER_REVIEW_MANAGE_PERMISSION = 'settings.offer-review.manage';

export const OFFER_REVIEW_PATH = 'settings/admin/offer-review';

export const MODE_CODE = 'offer-review-mode';
export const PROBATION_CODE = 'offer-review-probation-offers';
export const REFERENCE_CODE = 'offer-review-reference-sellers';
export const BAND_CODE = 'offer-review-price-band';
export const SAMPLING_CODE = 'offer-review-sampling';
export const BADGES_CODE = 'offer-review-certificate-badges';

export const MODE_VALUES = ['risk-based', 'all', 'off'] as const;
export const BADGES_VALUES = ['review', 'automatic'] as const;

export type NumberCode =
  typeof PROBATION_CODE | typeof REFERENCE_CODE | typeof BAND_CODE | typeof SAMPLING_CODE;

/** The bounds the API checks; the page checks them first so a typo never leaves the page. */
export const NUMBER_BOUNDS: Readonly<Record<NumberCode, { min: number; max: number }>> = {
  [PROBATION_CODE]: { min: 0, max: 100 },
  [REFERENCE_CODE]: { min: 2, max: 20 },
  [BAND_CODE]: { min: 5, max: 200 },
  [SAMPLING_CODE]: { min: 0, max: 100 },
};

export const NUMBER_CODES = Object.keys(NUMBER_BOUNDS) as readonly NumberCode[];

export interface OfferReviewSetting {
  readonly code: string;
  readonly value: string;
  /** 0 while the default is in force, then 1, 2, ... per change. */
  readonly version: number;
  readonly updatedAt: string | null;
  /** Whether a change is reviewed in this Market (Admin Inbox > System requests). */
  readonly review?: { readonly reviewed: boolean; readonly risk: string };
}

export interface OfferReviewAnswer {
  readonly settings: readonly OfferReviewSetting[];
}

const DEFAULTS: Readonly<Record<string, string>> = {
  [MODE_CODE]: 'risk-based',
  [PROBATION_CODE]: '10',
  [REFERENCE_CODE]: '3',
  [BAND_CODE]: '50',
  [SAMPLING_CODE]: '5',
  [BADGES_CODE]: 'review',
};

/** One row of an answer, or its launch default when the API did not name it. */
export function settingOf(answer: OfferReviewAnswer, code: string): OfferReviewSetting {
  return (
    answer.settings.find((row) => row.code === code) ?? {
      code,
      value: DEFAULTS[code] ?? '',
      version: 0,
      updatedAt: null,
    }
  );
}

/** A whole number typed in the page, within its bounds, as the API stores it; null otherwise. */
export function numberValueOf(code: NumberCode, typed: string): string | null {
  const text = typed.trim();
  if (!/^(0|[1-9][0-9]{0,8})$/.test(text)) return null;
  const value = Number(text);
  const { min, max } = NUMBER_BOUNDS[code];
  return value >= min && value <= max ? text : null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The row's `review` flag when it is well formed; nothing otherwise (no note is then asked). */
function reviewOf(value: unknown): Pick<OfferReviewSetting, 'review'> | Record<string, never> {
  if (!isRecord(value) || typeof value['reviewed'] !== 'boolean') return {};
  return {
    review: {
      reviewed: value['reviewed'],
      risk: typeof value['risk'] === 'string' ? value['risk'] : '',
    },
  };
}

/** The settings answer checked: rows with a code, a text value and a whole version; else null. */
export function offerReviewAnswerOf(value: unknown): OfferReviewAnswer | null {
  if (!isRecord(value) || !Array.isArray(value['settings'])) return null;
  const rows: OfferReviewSetting[] = [];
  for (const row of value['settings'] as unknown[]) {
    if (
      !isRecord(row) ||
      typeof row['code'] !== 'string' ||
      typeof row['value'] !== 'string' ||
      !Number.isInteger(row['version'])
    ) {
      return null;
    }
    rows.push({
      code: row['code'],
      value: row['value'],
      version: row['version'] as number,
      updatedAt: typeof row['updatedAt'] === 'string' ? row['updatedAt'] : null,
      ...reviewOf(row['review']),
    });
  }
  return { settings: rows };
}
