// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarList, Funnel } from './bar-list.tsx';
import { compactNumber, labelIndexes, niceTicks, niceTicksRange } from './chart-scale.ts';
import { ChartEmpty, ChartError, ChartSkeleton } from './chart-states.tsx';
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
