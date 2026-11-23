// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardGrid, GridItem, gridItemClass } from './dashboard.tsx';
import { DashboardSlot } from './dashboard-slot.tsx';
import { conversion, FunnelChart } from './funnel-chart.tsx';
import { Gauge } from './gauge.tsx';
import { PeriodSelector } from './period-selector.tsx';
import { Ring } from './ring.tsx';

afterEach(cleanup);

describe('Gauge', () => {
  it('says its figure in the text alternative and draws the filled part', () => {
    const html = renderToStaticMarkup(
      <Gauge
        label="Store health"
        value={82}
        caption="out of 100"
        target={90}
        targetLabel="Target"
        emptyLabel="No score"
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Store health: 82 out of 100, Target 90"');
    expect(html).toContain('stroke-dasharray="82 100"');
    expect(html).toContain('data-gauge="target"');
    expect(html).toContain('stroke-chart-series');
  });
  it('clamps beyond the scale and omits the target when none is given', () => {
    const html = renderToStaticMarkup(<Gauge label="H" value={150} emptyLabel="x" />);
    expect(html).toContain('stroke-dasharray="100 100"');
    expect(html).not.toContain('data-gauge="target"');
  });
  it('shows the empty state without a reading', () => {
    for (const value of [null, Number.NaN]) {
      const html = renderToStaticMarkup(
        <Gauge label="H" value={value} emptyLabel="No score yet" />,
      );
      expect(html).toContain('No score yet');
      expect(html).not.toContain('<svg');
    }
  });
});

describe('Ring', () => {
  it('prints the percentage and names it', () => {
    const html = renderToStaticMarkup(
      <Ring label="Same-day" percent={94.4} caption="on time" emptyLabel="x" />,
    );
    expect(html).toContain('aria-label="Same-day: 94% on time"');
    expect(html).toContain('stroke-dasharray="94.4 100"');
  });
  it('draws no arc at zero and an empty state without data', () => {
    expect(renderToStaticMarkup(<Ring label="R" percent={0} emptyLabel="x" />)).not.toContain(
      'data-ring="value"',
    );
    expect(
      renderToStaticMarkup(<Ring label="R" percent={null} emptyLabel="Nothing yet" />),
    ).toContain('Nothing yet');
  });
});

describe('FunnelChart', () => {
  const labels = {
    viewAsTable: 'View as table',
    viewAsChart: 'View as chart',
    stepColumn: 'Step',
    valueColumn: 'Orders',
    conversionColumn: 'From previous',
    notEnoughData: 'Not enough data',
  };
  const steps = [
    { id: 'a', label: 'Placed', value: 200, display: '200' },
    { id: 'b', label: 'Paid', value: 150, display: '150' },
    { id: 'c', label: 'Shipped', value: 60, display: '60' },
  ];
  it('computes conversion from the previous step', () => {
    expect(conversion(150, 200)).toBe(75);
    expect(conversion(60, 150)).toBe(40);
    expect(conversion(5, 0)).toBeNull();
  });
  it('lists steps with conversion and fades the hue step by step', () => {
    const html = renderToStaticMarkup(<FunnelChart title="Funnel" steps={steps} labels={labels} />);
    expect(html).toContain('aria-label="Funnel"');
    expect(html).toContain('>75%<');
    expect(html).toContain('>40%<');
    const opacities = [...html.matchAll(/opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(opacities).toHaveLength(3);
    expect(opacities[0]).toBe(1);
    expect(opacities[1]!).toBeLessThan(opacities[0]!);
    expect(opacities[2]!).toBeLessThan(opacities[1]!);
  });
  it('switches to a table with the same figures', () => {
    render(<FunnelChart title="Funnel" steps={steps} labels={labels} />);
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    expect(screen.getByRole('table', { name: 'Funnel' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Paid' })).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View as chart' }).className).toContain('min-h-11');
  });
  it('says not enough data for one step or an empty first step', () => {
    for (const s of [steps.slice(0, 1), steps.map((x) => ({ ...x, value: 0 }))]) {
      const html = renderToStaticMarkup(<FunnelChart title="F" steps={s} labels={labels} />);
      expect(html).toContain('Not enough data');
      expect(html).not.toContain('<ol');
    }
  });
});

describe('dashboard grid', () => {
  it('is 12 columns, one column wide on a phone by default', () => {
    const cls = gridItemClass();
    expect(cls).toContain('col-span-12');
    expect(cls).toContain('lg:col-span-12');
    expect(cls).toContain('md:col-span-12');
  });
  it('declares desktop span, tablet span and phone span', () => {
    const cls = gridItemClass({ span: 3, tabletSpan: 6, phoneSpan: 6 });
    expect(cls).toContain('lg:col-span-3');
    expect(cls).toContain('md:col-span-6');
    expect(cls.split(' ')).toContain('col-span-6');
  });
  it('orders KPIs, then tasks, then the rest on a phone and keeps page order from tablet up', () => {
    expect(gridItemClass({ mobileOrder: 'kpi' })).toContain('order-1 md:order-none');
    expect(gridItemClass({ mobileOrder: 'tasks' })).toContain('order-2 md:order-none');
    expect(gridItemClass({})).toContain('order-3 md:order-none');
  });
  it('renders items in a grid-cols-12 container', () => {
    const html = renderToStaticMarkup(
      <DashboardGrid>
        <GridItem span={8}>a</GridItem>
        <GridItem as="li" span={4}>
          b
        </GridItem>
      </DashboardGrid>,
    );
    expect(html).toContain('grid-cols-12');
    expect(html).toContain('lg:col-span-8');
    expect(html).toContain('<li class="min-w-0');
  });
  it('wraps a slot only when it has a layout (old pages keep their markup)', () => {
    const plain = renderToStaticMarkup(
      <DashboardSlot source={1} fallback={null}>
        {(n) => <p>{n}</p>}
      </DashboardSlot>,
    );
    expect(plain).toBe('<p>1</p>');
    const placed = renderToStaticMarkup(
      <DashboardSlot source={1} fallback={null} layout={{ span: 4, mobileOrder: 'tasks' }}>
        {(n) => <p>{n}</p>}
      </DashboardSlot>,
    );
    expect(placed).toContain('lg:col-span-4');
    expect(placed).toContain('order-2');
    expect(placed).toContain('<p>1</p>');
  });
});

describe('PeriodSelector on a phone', () => {
  const options = [
    { id: '7d', label: '7 days' },
    { id: '30d', label: '30 days' },
  ];
  it('offers a native select of the same options, 44px tall, shown below sm only', () => {
    const onChange = vi.fn();
    render(<PeriodSelector label="Period" options={options} value="7d" onChange={onChange} />);
    const select = screen.getByRole('combobox', { name: 'Period' });
    expect(select.className).toContain('min-h-11');
    expect(select.parentElement?.className).toContain('sm:hidden');
    const group = screen.getByRole('group', { name: 'Period' }).className.split(' ');
    expect(group).toContain('hidden');
    expect(group).toContain('sm:block');
    fireEvent.change(select, { target: { value: '30d' } });
    expect(onChange).toHaveBeenCalledWith('30d');
    expect((select as HTMLSelectElement).value).toBe('7d');
  });
});
