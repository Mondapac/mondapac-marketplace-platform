// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarList, Funnel } from './bar-list.tsx';
import { compactNumber, labelIndexes, niceTicks, niceTicksRange } from './chart-scale.ts';
import { ChartEmpty, ChartError, ChartSkeleton } from './chart-states.tsx';
import { assignColorKeys } from './chart-palette.ts';
import { DonutChart, MIN_ARC, arcWidths, sliceSegments } from './donut-chart.tsx';
import { ShareBar, type ShareBarItem } from './share-bar.tsx';
import { StackedBarChart, stackSeries } from './stacked-bar-chart.tsx';
import { fitFontSize, splitTop, strideIndexes, truncateText } from './chart-scale.ts';
import { StatCard } from './dashboard.tsx';
import { LineAreaChart } from './line-chart.tsx';
import { PeriodSelector } from './period-selector.tsx';

afterEach(cleanup);

const labels = { viewAsTable: 'View as table', viewAsChart: 'View as chart', dateColumn: 'Day' };
const money = (v: number) => `A$${v}`;
const pts = [10, 20, 15, 40].map((value, i) => ({ label: `D${i + 1}`, value }));
const prev = [8, 12, 18, 20].map((value, i) => ({ label: `P${i + 1}`, value }));

describe('chart scale', () => {
  it('ticks start at zero and reach the maximum', () => {
    const t = niceTicks(37);
    expect(t[0]).toBe(0);
    expect(t[t.length - 1]!).toBeGreaterThanOrEqual(37);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
  it('keeps first and last label and never exceeds the cap', () => {
    const idx = labelIndexes(30, 5);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(29);
    expect(idx.length).toBeLessThanOrEqual(5);
    expect(labelIndexes(3, 5)).toEqual([0, 1, 2]);
  });
  it('covers negative values and degenerate input', () => {
    const t = niceTicksRange(-50, 10);
    expect(t[0]).toBeLessThanOrEqual(-50);
    expect(t[t.length - 1]!).toBeGreaterThanOrEqual(10);
    expect(t).toContain(0);
    expect(niceTicksRange(0, 0)).toEqual([0, 1]);
    expect(niceTicksRange(Number.NaN, Number.NaN)).toEqual([0, 1]);
  });
  it('formats compact figures', () => {
    expect(compactNumber(1200)).toBe('1.2k');
    expect(compactNumber(3_400_000)).toBe('3.4M');
    expect(compactNumber(12)).toBe('12');
  });
});

describe('StatCard delta and sparkline', () => {
  const base = {
    icon: 'store',
    label: 'GMV',
    value: 'A$1',
    scope: 'incl. GST',
    href: '/x',
  } as const;
  it('colours by better or worse, not by direction, and says so in words', () => {
    const html = renderToStaticMarkup(
      <StatCard
        {...base}
        delta={{
          value: '+4.0%',
          direction: 'up',
          sentiment: 'bad',
          comparedWith: 'vs previous 30 days',
        }}
      />,
    );
    expect(html).toContain('text-critical-fg');
    expect(html).toContain('+4.0%');
    expect(html).toContain('worse');
  });
  it('shows n/a without an arrow or a judgement', () => {
    const html = renderToStaticMarkup(
      <StatCard
        {...base}
        delta={{
          value: 'n/a',
          direction: 'flat',
          sentiment: 'neutral',
          comparedWith: 'vs previous 7 days',
        }}
      />,
    );
    expect(html).toContain('n/a');
    expect(html).not.toContain('▲');
    expect(html).not.toContain('worse');
  });
  it('draws a decorative sparkline and supports the info tone', () => {
    const html = renderToStaticMarkup(<StatCard {...base} tone="info" sparkline={[1, 3, 2, 5]} />);
    expect(html).toContain('data-sparkline');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('text-info-fg');
  });
  it('shows no delta or sparkline when the read failed', () => {
    const html = renderToStaticMarkup(
      <StatCard
        {...base}
        error="Could not load"
        sparkline={[1, 2]}
        delta={{ value: '+1%', direction: 'up', sentiment: 'good', comparedWith: 'x' }}
      />,
    );
    expect(html).not.toContain('data-sparkline');
    expect(html).not.toContain('+1%');
  });
});

describe('LineAreaChart', () => {
  const chart = (compare = true) => (
    <LineAreaChart
      title="GMV"
      points={pts}
      {...(compare ? { compare: prev, compareLabel: 'Previous period' } : {})}
      seriesLabel="This period"
      formatValue={money}
      labels={labels}
    />
  );
  it('draws the current line and a dashed compare line with a legend', () => {
    const { container } = render(chart());
    expect(screen.getByRole('img', { name: 'GMV' })).toBeTruthy();
    expect(container.querySelector('path[stroke-dasharray]')).not.toBeNull();
    expect(screen.getByText('Previous period')).toBeTruthy();
  });
  it('switches to a table with the same figures and back', () => {
    render(chart());
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    expect(screen.getByRole('table', { name: 'GMV' })).toBeTruthy();
    expect(screen.getByText('A$40')).toBeTruthy();
    expect(screen.getByText('A$20', { selector: 'td.text-fg-secondary' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View as chart' }));
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('reads a point with arrow keys and clears it on Escape', () => {
    render(chart(false));
    const svg = screen.getByRole('img', { name: 'GMV' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toContain('D1');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toContain('A$20');
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(screen.getByRole('status').textContent).toBe('');
  });
  it('keeps negative values and an overlong compare series inside the plot', () => {
    const { container } = render(
      <LineAreaChart
        title="Net"
        points={[
          { label: 'a', value: -50 },
          { label: 'b', value: 10 },
        ]}
        compare={[
          { label: 'p1', value: 5 },
          { label: 'p2', value: 6 },
          { label: 'p3', value: 7 },
        ]}
        compareLabel="Prev"
        seriesLabel="Now"
        formatValue={money}
        labels={labels}
      />,
    );
    const d = [...container.querySelectorAll('svg[data-chart] path[fill="none"]')]
      .map((p) => p.getAttribute('d') ?? '')
      .join(' ');
    expect(d).not.toContain('NaN');
    const xs = [...d.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
    expect(Math.max(...xs)).toBeLessThanOrEqual(640);
    const ys = [...d.matchAll(/,([\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(240 - 22);
  });
  it('survives empty data and non-finite values', () => {
    const { container } = render(
      <LineAreaChart title="E" points={[]} seriesLabel="s" formatValue={money} labels={labels} />,
    );
    const svg = screen.getByRole('img', { name: 'E' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toBe('');
    cleanup();
    const r = render(
      <LineAreaChart
        title="N"
        points={[
          { label: 'a', value: Number.NaN },
          { label: 'b', value: 3 },
        ]}
        seriesLabel="s"
        formatValue={money}
        labels={labels}
      />,
    );
    expect(r.container.innerHTML).not.toContain('NaN');
    expect(container).toBeTruthy();
  });
  it('keeps measuring after the table is shown and hidden', () => {
    const observed: Element[] = [];
    class RO {
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
      unobserve() {}
    }
    vi.stubGlobal('ResizeObserver', RO);
    render(chart(false));
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    fireEvent.click(screen.getByRole('button', { name: 'View as chart' }));
    vi.unstubAllGlobals();
    expect(observed.length).toBe(2);
    expect(observed[1]!.isConnected).toBe(true);
  });
  it('prints axis text at a real 12 px', () => {
    const { container } = render(chart(false));
    const sizes = [...container.querySelectorAll('svg[data-chart] text')].map((t) =>
      t.getAttribute('font-size'),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(new Set(sizes)).toEqual(new Set(['12']));
  });
});

describe('BarList and Funnel', () => {
  it('prints every figure and scales bars to the largest', () => {
    const { container } = render(
      <BarList
        label="Top categories"
        items={[
          { id: 'a', label: 'Meat', value: 100, display: 'A$100' },
          { id: 'b', label: 'Bakery', value: 50, display: 'A$50', detail: '12 orders', href: '/b' },
        ]}
      />,
    );
    expect(screen.getByText('A$100')).toBeTruthy();
    expect(screen.getByText('12 orders')).toBeTruthy();
    expect(container.querySelectorAll<HTMLElement>('li span[style]')[1]!.style.width).toBe('50%');
    expect(container.querySelector('a[href="/b"]')).not.toBeNull();
  });
  it('ignores a non-finite value when scaling', () => {
    const { container } = render(
      <BarList
        label="x"
        items={[
          { id: 'a', label: 'A', value: Number.NaN, display: '?' },
          { id: 'b', label: 'B', value: 5, display: '5' },
        ]}
      />,
    );
    expect(container.querySelectorAll<HTMLElement>('li span[style]')[1]!.style.width).toBe('100%');
  });
  it('shows each funnel step as a share of the first', () => {
    render(
      <Funnel
        label="Order flow"
        steps={[
          { id: 'p', label: 'Paid', value: 200, display: '200' },
          { id: 's', label: 'Shipped', value: 150, display: '150' },
        ]}
      />,
    );
    expect(screen.getByText('75%')).toBeTruthy();
  });
});

describe('PeriodSelector', () => {
  it('is a radio group that reports the chosen period', () => {
    const onChange = vi.fn();
    render(
      <PeriodSelector
        label="Period"
        value="30d"
        onChange={onChange}
        note="vs previous 30 days"
        options={[
          { id: 'today', label: 'Today' },
          { id: '30d', label: '30 days' },
        ]}
      />,
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '30 days' }).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Today' }));
    expect(onChange).toHaveBeenCalledWith('today');
    expect(screen.getByRole('group', { name: 'Period' })).toBeTruthy();
  });
});

describe('chart states', () => {
  it('says empty and error in words, with a retry', () => {
    const retry = vi.fn();
    render(
      <>
        <ChartEmpty message="No sales in this period" />
        <ChartError message="Could not load the chart" retryLabel="Try again" onRetry={retry} />
        <ChartSkeleton />
      </>,
    );
    expect(screen.getByText('No sales in this period')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });
});

const dLabels = {
  viewAsTable: 'View as table',
  viewAsChart: 'View as chart',
  categoryColumn: 'Category',
  valueColumn: 'Sales',
  shareColumn: 'Share',
};
type Seg = {
  id: string;
  label: string;
  value: number;
  colorKey?: 'cat-1' | 'cat-2' | 'cat-3' | 'cat-4' | 'cat-5' | 'status-success' | 'status-danger';
};
const cats = (n: number): Seg[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `c${i + 1}`,
    label: `Cat ${i + 1}`,
    value: (n - i) * 10,
  }));
const donut = (segments: Seg[], extra: Record<string, unknown> = {}) => (
  <DonutChart
    title="Sales by category"
    segments={segments}
    formatValue={money}
    otherLabel="Other"
    totalLabel="Total"
    labels={dLabels}
    {...extra}
  />
);

describe('chart helpers', () => {
  it('splitTop ranks by size, keeps input order on ties and ignores non-positive or non-finite values', () => {
    const r = splitTop([5, 0, Number.NaN, 9, 5, -3, 7], 3);
    expect(r.top).toEqual([3, 6, 0]);
    expect(r.rest).toEqual([4]);
  });
  it('assigns requested colours first, then free slots in order, then Other; duplicates fall back', () => {
    expect(assignColorKeys(['cat-3', undefined, undefined])).toEqual(['cat-3', 'cat-1', 'cat-2']);
    expect(assignColorKeys(['cat-1', 'cat-1'])).toEqual(['cat-1', 'cat-2']);
    expect(assignColorKeys(['cat-other', undefined])).toEqual(['cat-1', 'cat-2']);
    expect(assignColorKeys(Array(7).fill(undefined)).slice(5)).toEqual(['cat-other', 'cat-other']);
    expect(assignColorKeys(['status-danger', undefined])).toEqual(['status-danger', 'cat-1']);
  });
  it('strides x labels evenly and fits text', () => {
    expect(strideIndexes(14, 30, 64)).toEqual([0, 3, 6, 9, 12]);
    expect(strideIndexes(3, 200)).toEqual([0, 1, 2]);
    expect(fitFontSize('A$12,345,678', 100, 20)).toBeLessThan(20);
    expect(fitFontSize('A$1', 100, 20)).toBe(20);
    expect(truncateText('A very long category name', 10)).toBe('A very lo…');
  });
  it('gives a tiny slice at least 2 degrees and keeps the circle whole', () => {
    const w = arcWidths([0.9995, 0.0005]);
    expect(w[1]).toBeGreaterThanOrEqual(MIN_ARC - 1e-9);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(Math.PI * 2);
  });
});

describe('DonutChart', () => {
  it('draws one focusable segment per category with a label that says value and share', () => {
    const { container } = render(donut(cats(3)));
    expect(container.querySelectorAll('[data-segment]')).toHaveLength(3);
    expect(screen.getByRole('img', { name: 'Cat 1: A$30, 50%' })).toBeTruthy();
    expect(container.querySelector('.stroke-chart-cat-1')).not.toBeNull();
    expect(container.querySelector('.stroke-chart-cat-3')).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Sales by category' })).toBeTruthy();
  });
  it('keeps a category colour when ranks swap (colorKey)', () => {
    const colourOf = (c: HTMLElement, id: string) =>
      c.querySelector(`[data-segment="${id}"] path`)?.getAttribute('class');
    const a = render(
      donut([
        { id: 'x', label: 'X', value: 10, colorKey: 'cat-4' },
        { id: 'y', label: 'Y', value: 5, colorKey: 'cat-2' },
      ]),
    );
    const before = [colourOf(a.container, 'x'), colourOf(a.container, 'y')];
    a.unmount();
    const b = render(
      donut([
        { id: 'x', label: 'X', value: 5, colorKey: 'cat-4' },
        { id: 'y', label: 'Y', value: 10, colorKey: 'cat-2' },
      ]),
    );
    expect([colourOf(b.container, 'x'), colourOf(b.container, 'y')]).toEqual(before);
    expect(before).toEqual(['stroke-chart-cat-4', 'stroke-chart-cat-2']);
  });
  it('uses a status colour for an order-status series', () => {
    const { container } = render(
      donut([
        { id: 'ok', label: 'Delivered', value: 8, colorKey: 'status-success' },
        { id: 'bad', label: 'Failed', value: 2, colorKey: 'status-danger' },
      ]),
    );
    expect(container.querySelector('.stroke-success-fg')).not.toBeNull();
    expect(container.querySelector('.stroke-critical-solid')).not.toBeNull();
  });
  it('shows the total in the centre and a right-aligned legend with value and share', () => {
    const { container } = render(donut(cats(3)));
    expect(container.querySelector('[data-centre] text')?.textContent).toBe('A$60');
    const row = container.querySelector('[data-legend="c2"]')!;
    expect(row.textContent).toContain('A$20');
    expect(row.textContent).toContain('33.3%');
    expect(row.querySelector('.tabular-nums.text-end')).not.toBeNull();
  });
  it('replaces the centre text with the active slice and has no floating tooltip', () => {
    const { container } = render(donut(cats(3)));
    fireEvent.focus(container.querySelector('[data-segment="c1"]')!);
    const centre = container.querySelector('[data-centre]')!.textContent;
    expect(centre).toContain('A$30');
    expect(centre).toContain('Cat 1');
    expect(centre).toContain('50%');
    expect(container.querySelector('[data-donut-tooltip]')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Cat 1: A$30, 50%');
    fireEvent.keyDown(container.querySelector('[data-segment="c1"]')!, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toContain('Cat 2');
    fireEvent.keyDown(container.querySelector('[data-segment="c1"]')!, { key: 'Escape' });
    expect(container.querySelector('[data-centre]')!.textContent).toContain('Total');
  });
  it('highlights the legend row and its segment on hover', () => {
    const { container } = render(donut(cats(3)));
    fireEvent.pointerEnter(container.querySelector('[data-legend="c2"]')!);
    expect(container.querySelector('[data-legend="c2"]')!.className).toContain('bg-muted');
    expect(container.querySelector('[data-centre]')!.textContent).toContain('Cat 2');
  });
  it('shrinks the centre figure so a long amount fits', () => {
    const { container } = render(
      donut([{ id: 'a', label: 'A', value: 12_345_678 }], {
        formatValue: (v: number) => `A$${v.toLocaleString('en-AU')}`,
      }),
    );
    const size = Number(container.querySelector('[data-centre] text')?.getAttribute('font-size'));
    expect(size).toBeLessThan(18);
    expect(size).toBeGreaterThanOrEqual(11);
  });
  it('truncates a long category name in the centre and the legend, keeping the full name in a title', () => {
    const long = 'Halal certified fresh produce and chilled goods';
    const { container } = render(
      donut([
        { id: 'a', label: long, value: 5 },
        { id: 'b', label: 'B', value: 4 },
      ]),
    );
    fireEvent.focus(container.querySelector('[data-segment="a"]')!);
    expect(container.querySelector('[data-centre] text:last-child')?.textContent).toContain('…');
    expect(container.querySelector('[data-legend="a"] [title]')?.getAttribute('title')).toBe(long);
  });
  it('buckets everything past the fifth category into a neutral Other', () => {
    const slices = sliceSegments(cats(8), 'Other');
    expect(slices.map((s) => s.label)).toEqual([
      'Cat 1',
      'Cat 2',
      'Cat 3',
      'Cat 4',
      'Cat 5',
      'Other',
    ]);
    expect(slices[5]!.value).toBe(60);
    expect(slices[5]!.colorKey).toBe('cat-other');
    const { container } = render(donut(cats(8)));
    expect(container.querySelectorAll('[data-segment]')).toHaveLength(6);
    expect(container.querySelector('.stroke-chart-cat-other')).not.toBeNull();
  });
  it('keeps exactly five categories without Other and puts a sixth into Other', () => {
    expect(sliceSegments(cats(5), 'Other')).toHaveLength(5);
    expect(sliceSegments(cats(6), 'Other')).toHaveLength(6);
    expect(sliceSegments(cats(6), 'Other')[5]!.isOther).toBe(true);
  });
  it('switches to a table with swatches, value and share and back; the toggle sits next to the legend', () => {
    const { container } = render(donut(cats(8)));
    expect(
      container
        .querySelector('[data-legend="c1"]')!
        .parentElement!.parentElement!.contains(
          screen.getByRole('button', { name: 'View as table' }),
        ),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const table = screen.getByRole('table', { name: 'Sales by category' });
    expect(table.querySelectorAll('tbody tr')).toHaveLength(6);
    expect(table.querySelectorAll('[data-swatch]')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'View as chart' }));
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('says Nothing in this period for no usable value and Not enough data yet only when the caller says so', () => {
    for (const segments of [
      [],
      [{ id: 'a', label: 'A', value: 0 }],
      [{ id: 'a', label: 'A', value: -4 }],
      [{ id: 'a', label: 'A', value: Number.NaN }],
    ]) {
      const { container, unmount } = render(donut(segments));
      expect(screen.getByText('Nothing in this period')).toBeTruthy();
      expect(container.querySelector('svg')).toBeNull();
      unmount();
    }
    const a = render(donut(cats(3), { state: 'insufficient' }));
    expect(screen.getByText('Not enough data yet')).toBeTruthy();
    expect(a.container.querySelector('svg')).toBeNull();
    a.unmount();
    render(donut([], { state: 'insufficient', emptyLabels: { insufficient: 'Too few orders' } }));
    expect(screen.getByText('Too few orders')).toBeTruthy();
  });
  it('drops negative and non-finite values and says how many in the footnote', () => {
    const { container } = render(
      donut(
        [
          { id: 'a', label: 'A', value: 10 },
          { id: 'b', label: 'B', value: -5 },
          { id: 'c', label: 'C', value: Number.NaN },
        ],
        { droppedNote: (n: number) => `${n} values left out` },
      ),
    );
    expect(container.querySelectorAll('[data-segment]')).toHaveLength(1);
    expect(container.querySelector('[data-dropped-note]')?.textContent).toBe('2 values left out');
  });
  it('draws a single category as a full ring and a tiny one at its minimum arc', () => {
    const one = render(donut([{ id: 'a', label: 'Only', value: 5 }]));
    expect(one.container.querySelector('[data-segment] circle')).not.toBeNull();
    one.unmount();
    const { container } = render(
      donut([
        { id: 'a', label: 'Big', value: 10000 },
        { id: 'b', label: 'Tiny', value: 1 },
      ]),
    );
    expect(container.querySelector('[data-segment="b"] path')).not.toBeNull();
  });
});

describe('StackedBarChart', () => {
  const series = Array.from({ length: 7 }, (_, i) => ({
    id: `s${i + 1}`,
    label: `Source ${i + 1}`,
  }));
  const days = [1, 2, 3].map((d) => ({
    label: `D${d}`,
    values: Object.fromEntries(series.map((s, i) => [s.id, (7 - i) * d])),
  }));
  const stacked = (
    p = days,
    s: {
      id: string;
      label: string;
      colorKey?: 'status-success' | 'status-danger' | 'cat-4';
    }[] = series,
    extra: Record<string, unknown> = {},
  ) => (
    <StackedBarChart
      title="Orders by source"
      series={s}
      points={p}
      formatValue={(v) => `${v} orders`}
      otherLabel="Other"
      totalLabel="Total"
      labels={labels}
      {...extra}
    />
  );
  it('stacks five named series and an Other bucket in the palette order, with a legend', () => {
    const cols = stackSeries(series, days, 'Other');
    expect(cols.map((c) => c.label)).toEqual([
      'Source 1',
      'Source 2',
      'Source 3',
      'Source 4',
      'Source 5',
      'Other',
    ]);
    expect(cols[5]!.values).toEqual([3, 6, 9]);
    const { container } = render(stacked());
    expect(screen.getByRole('img', { name: 'Orders by source' })).toBeTruthy();
    expect(container.querySelectorAll('rect.fill-chart-cat-1')).toHaveLength(3);
    expect(container.querySelectorAll('rect.fill-chart-cat-other')).toHaveLength(3);
    expect(container.querySelector('ul .bg-chart-cat-5')).not.toBeNull();
  });
  it('keeps a series colour when ranks swap (colorKey, including status colours)', () => {
    const s = [
      { id: 'a', label: 'Delivered', colorKey: 'status-success' as const },
      { id: 'b', label: 'Failed', colorKey: 'status-danger' as const },
    ];
    const one = stackSeries(s, [{ label: 'D1', values: { a: 9, b: 1 } }], 'Other');
    const two = stackSeries(s, [{ label: 'D1', values: { a: 1, b: 9 } }], 'Other');
    expect(one.map((c) => [c.id, c.colorKey]).sort()).toEqual(
      two.map((c) => [c.id, c.colorKey]).sort(),
    );
    const { container } = render(stacked([{ label: 'D1', values: { a: 9, b: 1 } }], s));
    expect(container.querySelector('rect.fill-success-fg')).not.toBeNull();
    expect(container.querySelector('rect.fill-critical-solid')).not.toBeNull();
  });
  it('reads a period in a band above the plot with every category and the total, never a floating box', () => {
    const { container } = render(stacked());
    const svg = screen.getByRole('img', { name: 'Orders by source' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByRole('status').textContent).toContain('D1: Source 1 7 orders');
    const band = container.querySelector('[data-stacked-tooltip]')!;
    expect(band.textContent).toContain('Other');
    expect(band.className).not.toContain('absolute');
    expect(band.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(band.textContent?.trim()).toBe('');
  });
  it('prints x labels at an even stride', () => {
    const many = Array.from({ length: 14 }, (_, d) => ({ label: `L${d}`, values: { s1: d + 1 } }));
    const { container } = render(stacked(many, series.slice(0, 1)));
    const printed = [...container.querySelectorAll('svg text')]
      .map((t) => t.textContent)
      .filter((t) => /^L\d+$/.test(t ?? ''))
      .map((t) => Number(t.slice(1)));
    const gaps = new Set(printed.slice(1).map((v, i) => v - printed[i]!));
    expect(printed[0]).toBe(0);
    expect(gaps.size).toBe(1);
  });
  it('truncates long series names in the legend with the full name in a title', () => {
    const long = 'Seller invite links and referral partners';
    const { container } = render(stacked(days.slice(0, 1), [{ id: 's1', label: long }]));
    const item = container.querySelector('ul li [title]');
    expect(item?.getAttribute('title')).toBe(long);
    expect(item?.className).toContain('truncate');
  });
  it('switches to a table with swatches, a column per category and a total, and back', () => {
    render(stacked());
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const table = screen.getByRole('table', { name: 'Orders by source' });
    expect(table.querySelectorAll('thead th')).toHaveLength(8);
    expect(table.querySelectorAll('[data-swatch]')).toHaveLength(6);
    expect(screen.getByText('56 orders')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View as chart' }));
    expect(screen.queryByRole('table')).toBeNull();
  });
  it('treats missing, negative and non-finite values as zero and reports the dropped ones', () => {
    const { container } = render(
      stacked([{ label: 'D1', values: { s1: 4, s2: -2, s3: Number.NaN } }], series.slice(0, 4), {
        droppedNote: (n: number) => `${n} left out`,
      }),
    );
    expect(container.querySelectorAll('rect')).toHaveLength(1);
    expect(container.querySelector('[data-dropped-note]')?.textContent).toBe('2 left out');
  });
  it('distinguishes empty from insufficient only by the caller state', () => {
    for (const p of [[], [{ label: 'D1', values: {} }], [{ label: 'D1', values: { s1: 0 } }]]) {
      const { container, unmount } = render(stacked(p));
      expect(screen.getByText('Nothing in this period')).toBeTruthy();
      expect(container.querySelector('svg')).toBeNull();
      unmount();
    }
    render(stacked(days, series, { state: 'insufficient' }));
    expect(screen.getByText('Not enough data yet')).toBeTruthy();
  });
});

describe('ShareBar', () => {
  const parts: ShareBarItem[] = [
    { id: 'new', label: 'New customers', value: 320, colorKey: 'cat-2' },
    { id: 'ret', label: 'Returning customers', value: 680, colorKey: 'cat-1' },
  ];
  const bar = (items = parts, extra: Record<string, unknown> = {}) => (
    <ShareBar
      title="New and returning customers"
      items={items}
      formatValue={(v) => `${v}`}
      otherLabel="Other"
      labels={dLabels}
      {...extra}
    />
  );
  it('draws one part per item in the caller colours, with a legend of value and share', () => {
    const { container } = render(bar());
    expect(
      screen.getByRole('img', {
        name: /New and returning customers: Returning customers 68%, New customers 32%/,
      }),
    ).toBeTruthy();
    expect(container.querySelector('[data-part="new"]')!.className).toContain('bg-chart-cat-2');
    expect(container.querySelector('[data-part="ret"]')!.className).toContain('bg-chart-cat-1');
    const row = container.querySelector('[data-legend="ret"]')!;
    expect(row.textContent).toContain('680');
    expect(row.textContent).toContain('68%');
  });
  it('buckets past five into Other, highlights on hover, and toggles a table with swatches', () => {
    const items = cats(7).map((c) => ({ ...c }));
    const { container } = render(bar(items));
    expect(container.querySelectorAll('[data-part]')).toHaveLength(6);
    expect(container.querySelector('[data-part="__other"]')!.className).toContain(
      'bg-chart-cat-other',
    );
    fireEvent.pointerEnter(container.querySelector('[data-legend="c2"]')!);
    expect(container.querySelector('[data-part="c1"]')!.className).toContain('opacity-50');
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    expect(
      screen
        .getByRole('table', { name: 'New and returning customers' })
        .querySelectorAll('[data-swatch]'),
    ).toHaveLength(6);
  });
  it('says empty or insufficient as the caller decides, and reports dropped values', () => {
    render(bar([{ id: 'a', label: 'A', value: 0 }]));
    expect(screen.getByText('Nothing in this period')).toBeTruthy();
    cleanup();
    render(bar(parts, { state: 'insufficient' }));
    expect(screen.getByText('Not enough data yet')).toBeTruthy();
    cleanup();
    const { container } = render(
      bar([...parts, { id: 'x', label: 'X', value: -1 }], {
        droppedNote: (n: number) => `${n} left out`,
      }),
    );
    expect(container.querySelector('[data-dropped-note]')?.textContent).toBe('1 left out');
  });
});
