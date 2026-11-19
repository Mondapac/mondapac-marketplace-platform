// The per-variant fields of the variants editor (variants V4): GTIN, shipping weight and box,
// and the photos a variant picks from the product gallery. Pure checks that mirror the API's
// (apps/api catalog domain variant-fields.ts and variant-gtin.ts) so a seller sees a problem
// before saving; the server stays the judge.

export const WEIGHT_GRAMS_MAX = 1_000_000;
export const DIMENSION_MM_MAX = 100_000;
export const VARIANT_IMAGES_MAX = 20;

export const SIZE_KEYS = ['weightGrams', 'lengthMm', 'widthMm', 'heightMm'] as const;
export type SizeKey = (typeof SIZE_KEYS)[number];

/** The key of each size field in the saved draft. */
export const DRAFT_KEY: Record<SizeKey, string> = {
  weightGrams: 'shippingWeightGrams',
  lengthMm: 'shippingLengthMm',
  widthMm: 'shippingWidthMm',
  heightMm: 'shippingHeightMm',
};

const LIMIT: Record<SizeKey, number> = {
  weightGrams: WEIGHT_GRAMS_MAX,
  lengthMm: DIMENSION_MM_MAX,
  widthMm: DIMENSION_MM_MAX,
  heightMm: DIMENSION_MM_MAX,
};

function checkDigitValid(digits: string): boolean {
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let index = 0; index < body.length; index += 1) {
    sum += Number(body[index]) * ((body.length - index) % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits.at(-1));
}

/** The digits of a typed GTIN (spaces and hyphens dropped), or `null` when it is not valid. */
export function gtinDigits(raw: string): string | null {
  const digits = raw.trim().replace(/[\s-]/g, '');
  if (!/^[0-9]+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return null;
  return checkDigitValid(digits) ? digits : null;
}

/** The same item typed as GTIN-12 or GTIN-13 is one value: 14 digits. */
export function gtinKey(raw: string): string | null {
  return gtinDigits(raw)?.padStart(14, '0') ?? null;
}

/** `invalid` for a typed GTIN that is not one; an empty text is fine (the field is optional). */
export function gtinProblem(raw: string): 'invalid' | null {
  return raw.trim() === '' || gtinDigits(raw) !== null ? null : 'invalid';
}

/** `invalid` when the text is not a whole number in range; an empty text is fine. */
export function sizeProblem(key: SizeKey, raw: string): 'invalid' | null {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^[0-9]+$/.test(text)) return 'invalid';
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= 1 && number <= LIMIT[key] ? null : 'invalid';
}

export interface VariantFieldValues {
  readonly gtin: string;
  readonly weightGrams: string;
  readonly lengthMm: string;
  readonly widthMm: string;
  readonly heightMm: string;
  readonly imageIds: readonly string[];
}

export type FieldProblems = Partial<
  Record<'gtin' | SizeKey | 'imageIds', 'invalid' | 'required' | 'duplicate' | 'too-many'>
>;

/**
 * Every problem of one variant's fields. A box has three sides: all three or none, so a half-set
 * size is `required` on the missing sides.
 */
export function problemsOf(
  values: VariantFieldValues,
  siblingGtins: readonly string[],
): FieldProblems {
  const problems: FieldProblems = {};
  const gtin = gtinProblem(values.gtin);
  if (gtin !== null) problems.gtin = gtin;
  else {
    const key = gtinKey(values.gtin);
    if (key !== null && siblingGtins.includes(key)) problems.gtin = 'duplicate';
  }
  for (const key of SIZE_KEYS) {
    const problem = sizeProblem(key, values[key]);
    if (problem !== null) problems[key] = problem;
  }
  const box = (['lengthMm', 'widthMm', 'heightMm'] as const).map((key) => values[key].trim());
  if (box.some((text) => text !== '') && box.some((text) => text === '')) {
    for (const key of ['lengthMm', 'widthMm', 'heightMm'] as const) {
      if (values[key].trim() === '') problems[key] = 'required';
    }
  }
  if (values.imageIds.length > VARIANT_IMAGES_MAX) problems.imageIds = 'too-many';
  return problems;
}

/** The problems of each row of a list, in order; a GTIN twin among the rows is `duplicate` on both. */
export function problemsOfRows(rows: readonly VariantFieldValues[]): FieldProblems[] {
  const keys = rows.map((row) => gtinKey(row.gtin));
  return rows.map((row, index) =>
    problemsOf(
      row,
      keys.flatMap((key, other) => (other !== index && key !== null ? [key] : [])),
    ),
  );
}

export const hasProblems = (list: readonly FieldProblems[]): boolean =>
  list.some((problems) => Object.keys(problems).length > 0);
