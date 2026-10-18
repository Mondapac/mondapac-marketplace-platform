import { formatMoney } from '../format/money.ts';
import type { PriceBand } from '../storefront/types.ts';

type Translate = (key: string, values?: Record<string, string>) => string;

/** "Under A$10", "A$10 to A$20" or "Over A$20". */
export function priceBandLabel(band: PriceBand, t: Translate, locale: string): string {
  const money = (m: NonNullable<PriceBand['below']>) => formatMoney(m, locale, { whole: true });
  if (band.below) return t('price-below', { price: money(band.below) });
  if (band.above) return t('price-above', { price: money(band.above) });
  return t('price-between', { from: money(band.from!), to: money(band.to!) });
}
