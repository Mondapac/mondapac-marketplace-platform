import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market's commission settings (Market config `commissionPayouts`). */
export interface CommissionSettings {
  /** The Market rate in basis points (AU 1500). */
  readonly defaultRateBps: number;
  /**
   * The tax rate taken out of a tax-inclusive line before commission, in basis points (AU GST
   * 1000), until the tax module gives the exact tax of each line (package 9).
   */
  readonly provisionalTaxRateBps: number;
  readonly currency: string;
}

export interface CommissionPolicy {
  /** Null when the Market has no commission settings: rates are unavailable (fail closed). */
  settings(market: MarketContext): CommissionSettings | null;
}

export const COMMISSION_POLICY = Symbol('COMMISSION_POLICY');
