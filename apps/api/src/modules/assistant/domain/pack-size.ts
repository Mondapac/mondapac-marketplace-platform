/**
 * Pack sizes for the basket planner (smart baskets design, section 1, step 2). A product name
 * such as "Basmati rice 2 kg" or "Cola 6 x 330 ml" is read into a measure in grams or millilitres;
 * a name with no readable size answers null, and the planner then asks the buyer instead of
 * guessing. Pure and deterministic: no model is involved.
 */

export const BASKET_UNITS = ['kg', 'g', 'l', 'ml', 'each'] as const;
export type BasketUnit = (typeof BASKET_UNITS)[number];

/** What a pack or a wish measures: a mass in grams, a volume in millilitres, or a count. */
export type Measure =
  | { readonly kind: 'mass'; readonly amount: number }
  | { readonly kind: 'volume'; readonly amount: number }
  | { readonly kind: 'count'; readonly amount: number };

const UNIT_FACTORS: Readonly<Record<string, { kind: 'mass' | 'volume'; factor: number }>> =
  Object.freeze({
    kg: { kind: 'mass', factor: 1000 },
    kgs: { kind: 'mass', factor: 1000 },
    kilo: { kind: 'mass', factor: 1000 },
    kilos: { kind: 'mass', factor: 1000 },
    کیلو: { kind: 'mass', factor: 1000 },
    کیلوگرم: { kind: 'mass', factor: 1000 },
    g: { kind: 'mass', factor: 1 },
    gr: { kind: 'mass', factor: 1 },
    gm: { kind: 'mass', factor: 1 },
    gram: { kind: 'mass', factor: 1 },
    grams: { kind: 'mass', factor: 1 },
    گرم: { kind: 'mass', factor: 1 },
    l: { kind: 'volume', factor: 1000 },
    lt: { kind: 'volume', factor: 1000 },
    ltr: { kind: 'volume', factor: 1000 },
    litre: { kind: 'volume', factor: 1000 },
    litres: { kind: 'volume', factor: 1000 },
    liter: { kind: 'volume', factor: 1000 },
    liters: { kind: 'volume', factor: 1000 },
    لیتر: { kind: 'volume', factor: 1000 },
    ml: { kind: 'volume', factor: 1 },
    میلی‌لیتر: { kind: 'volume', factor: 1 },
    میلی: { kind: 'volume', factor: 1 },
  });

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Letters and digits as one spelling: Persian forms of ye and kaf, Eastern digits, no marks. */
export function normaliseText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[۰-۹]/g, (digit) => String(PERSIAN_DIGITS.indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_DIGITS.indexOf(digit)))
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[‌‍]/g, ' ')
    .replace(/٫|،/g, ',')
    .toLowerCase();
}

const NUMBER = String.raw`(\d{1,6}(?:[.,]\d{1,3})?)`;
const UNIT = String.raw`([a-z؀-ۿ]+)`;
// "2 x 500 g", "6x330ml", "500 g x 2" (a multiplier up to 99) or a plain "500 g".
const MULTI_FIRST = new RegExp(String.raw`(?<![\d.,])(\d{1,2})\s*[x×]\s*${NUMBER}\s*${UNIT}`, 'u');
const MULTI_LAST = new RegExp(
  String.raw`(?<![\d.,])${NUMBER}\s*${UNIT}\s*[x×]\s*(\d{1,2})(?!\d)`,
  'u',
);
const SINGLE = new RegExp(String.raw`(?<![\d.,])${NUMBER}\s*${UNIT}`, 'gu');

const numberOf = (text: string): number => Number(text.replace(',', '.'));

const measureOf = (count: number, amountText: string, unitText: string): Measure | null => {
  const unit = UNIT_FACTORS[unitText];
  const amount = numberOf(amountText);
  if (unit === undefined || !Number.isFinite(amount) || amount <= 0) return null;
  const total = Math.round(amount * unit.factor * count);
  return total > 0 ? { kind: unit.kind, amount: total } : null;
};

/**
 * The size of one pack as its name states it, or null when the name has none or two different
 * sizes (then nothing is guessed). A multi-pack counts every unit in it.
 */
export function parsePackSize(name: string): Measure | null {
  const text = normaliseText(name);
  const first = MULTI_FIRST.exec(text);
  if (first !== null) return measureOf(Number(first[1]), first[2]!, first[3]!);
  const last = MULTI_LAST.exec(text);
  if (last !== null) return measureOf(Number(last[3]), last[1]!, last[2]!);
  const sizes = new Set<string>();
  let found: Measure | null = null;
  for (const match of text.matchAll(SINGLE)) {
    const measure = measureOf(1, match[1]!, match[2]!);
    if (measure === null) continue;
    sizes.add(`${measure.kind}:${measure.amount}`);
    found = measure;
  }
  return sizes.size === 1 ? found : null;
}

/** What the buyer asked for, as a measure: "2 kg" is 2000 g, "3" or "3 each" is a count of 3. */
export function wantedMeasure(quantity: number, unit: BasketUnit | null): Measure {
  switch (unit) {
    case 'kg':
      return { kind: 'mass', amount: Math.round(quantity * 1000) };
    case 'g':
      return { kind: 'mass', amount: Math.round(quantity) };
    case 'l':
      return { kind: 'volume', amount: Math.round(quantity * 1000) };
    case 'ml':
      return { kind: 'volume', amount: Math.round(quantity) };
    default:
      return { kind: 'count', amount: quantity };
  }
}
