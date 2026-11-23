'use client';

import { LineAreaChart, compactNumber, type LineAreaChartProps } from '@mondapac/ui';
import { exponentOf, formatMinor } from '../../price/money.ts';

export type SalesLineChartProps = Omit<LineAreaChartProps, 'formatValue' | 'formatTick'> & {
  readonly currency: string;
  readonly locale: string;
};

/**
 * The sales line chart with its money formatters built on the client: a server
 * component cannot pass functions to `LineAreaChart`, only data.
 */
export function SalesLineChart({ currency, locale, ...chart }: SalesLineChartProps) {
  const exp = 10 ** exponentOf(currency);
  return (
    <LineAreaChart
      {...chart}
      formatValue={(v) => formatMinor(String(Math.round(v)), currency, locale)}
      formatTick={(v) => compactNumber(v / exp)}
    />
  );
}
