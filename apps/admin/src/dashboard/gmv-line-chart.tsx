'use client';

import { LineAreaChart, type LineAreaChartProps } from '@mondapac/ui';
import { kpiMajor } from './kpi-format.ts';

export type GmvLineChartProps = Omit<LineAreaChartProps, 'formatValue'> & {
  readonly currency: string;
  readonly locale: string;
};

/**
 * The GMV line chart with its money formatter built on the client: a server
 * component cannot pass functions to `LineAreaChart`, only data.
 */
export function GmvLineChart({ currency, locale, ...chart }: GmvLineChartProps) {
  return <LineAreaChart {...chart} formatValue={(v) => kpiMajor(v, currency, locale)} />;
}
