// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardGrid, GridItem, gridItemClass } from './dashboard.tsx';
import { DashboardSlot } from './dashboard-slot.tsx';
import { ChartError } from './chart-states.tsx';
import { DashboardCard } from './dashboard.tsx';
import { LineAreaChart } from './line-chart.tsx';
import { conversion, formatConversion, FunnelChart, FunnelChartCard } from './funnel-chart.tsx';
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

describe('Gauge edge cases', () => {
  it('shows the empty state when max is not above zero', () => {
    for (const max of [0, -5]) {
      const html = renderToStaticMarkup(
        <Gauge label="H" value={5} max={max} emptyLabel="No score" />,
      );
      expect(html).toContain('No score');
    }
  });
  it('clamps the arc and the target outside 0..max but prints the raw figure', () => {
    const html = renderToStaticMarkup(
      <Gauge label="H" value={-20} max={50} target={80} targetLabel="Target" emptyLabel="x" />,
    );
    expect(html).not.toContain('data-gauge="value"');
    expect(html).toContain('data-gauge="target"');
    expect(html).toContain('>-20<');
    expect(html).toContain('aria-label="H: -20 of 50, Target 80"');
    const over = renderToStaticMarkup(<Gauge label="H" value={500} emptyLabel="x" />);
    expect(over).toContain('stroke-dasharray="100 100"');
    expect(over).toContain('>500<');
  });
  it('draws no arc under 1% and formats the target like the figure', () => {
    const html = renderToStaticMarkup(
      <Gauge
        label="Rev"
        value={0.4}
        formatValue={(n) => `A$${n}`}
        target={90}
        targetLabel="Goal"
        emptyLabel="x"
      />,
    );
    expect(html).not.toContain('data-gauge="value"');
    expect(html).toContain('aria-label="Rev: A$0.4 of A$100, Goal A$90"');
  });
  it('shrinks and truncates a long figure', () => {
    const html = renderToStaticMarkup(
      <Gauge label="Rev" value={1} display="A$1,234,567.00" emptyLabel="x" />,
    );
    expect(html).toContain('truncate');
    expect(html).toContain('text-base');
    expect(html).toContain('title="A$1,234,567.00"');
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
    conversionColumn: 'From previous step',
    notEnoughData: 'Not enough data',
    empty: 'No orders in this period',
    emptyHint: 'Orders appear after checkout',
  };
  const steps = [
    { id: 'a', label: 'Placed', value: 200, display: '200' },
    { id: 'b', label: 'Paid', value: 150, display: '150' },
    { id: 'c', label: 'Shipped', value: 60, display: '60' },
  ];
  it('computes conversion from the previous step', () => {
    expect(conversion(150, 200)).toBe(75);
    expect(conversion(5, 0)).toBeNull();
    expect(formatConversion(60, 150)).toBe('40%');
    expect(formatConversion(1, 1000)).toBe('<1%');
    expect(formatConversion(0, 10)).toBe('0%');
    expect(formatConversion(5, 0)).toBe('—');
    expect(formatConversion(Number.NaN, 10)).toBe('0%');
    expect(formatConversion(-3, 10)).toBe('0%');
    expect(formatConversion(300, 200)).toBe('150%');
  });
  it('lists steps with conversion and fades the hue step by step', () => {
    const html = renderToStaticMarkup(<FunnelChart title="Funnel" steps={steps} labels={labels} />);
    expect(html).toContain('aria-label="Funnel"');
    expect(html).toContain('75%');
    expect(html).toContain('40%');
    expect(html).toContain('From previous step: </span>—');
    const opacities = [...html.matchAll(/opacity:([\d.]+)/g)].map((m) => Number(m[1]));
    expect(opacities).toHaveLength(3);
    expect(opacities[0]).toBe(1);
    expect(opacities[1]!).toBeLessThan(opacities[0]!);
    expect(opacities[2]!).toBeLessThan(opacities[1]!);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.65);
  });
  it('shows a dash after a zero step and caps only the bar of a step above its predecessor', () => {
    const odd = [
      { id: 'a', label: 'A', value: 100, display: '100' },
      { id: 'b', label: 'B', value: 0, display: '0' },
      { id: 'c', label: 'C', value: 50, display: '50' },
      { id: 'd', label: 'D', value: 400, display: '400' },
    ];
    const html = renderToStaticMarkup(<FunnelChart title="F" steps={odd} labels={labels} />);
    const items = html.split('<li').slice(1);
    expect(items[1]).toContain('0%');
    expect(items[2]).toContain('—');
    expect(items[3]).toContain('800%');
    expect(items[3]).toContain('width:100%');
  });
  it('switches to a table with the same figures', () => {
    render(<FunnelChart title="Funnel" steps={steps} labels={labels} />);
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    expect(screen.getByRole('table', { name: 'Funnel' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Paid' })).toBeTruthy();
    expect(screen.getByText('75%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View as chart' }).className).toContain('min-h-11');
  });
  it('toggles from the keyboard and says which view is on', () => {
    render(<FunnelChart title="Funnel" steps={steps} labels={labels} />);
    const button = screen.getByRole('button', { name: 'View as table' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button); // Enter and Space on a button fire click
    const back = screen.getByRole('button', { name: 'View as chart' });
    expect(back.getAttribute('aria-pressed')).toBe('true');
  });
  it('puts the toggle in the card header when hosted by FunnelChartCard', () => {
    const { container } = render(
      <FunnelChartCard id="f" title="Funnel" steps={steps} labels={labels} />,
    );
    const header = container.querySelector('section > div');
    expect(header?.querySelector('button')?.textContent).toBe('View as table');
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });
  it('says not enough data for one step or an empty first step', () => {
    for (const s of [steps.slice(0, 1), steps.map((x) => ({ ...x, value: 0 }))]) {
      const html = renderToStaticMarkup(<FunnelChart title="F" steps={s} labels={labels} />);
      expect(html).not.toContain('<ol');
    }
    const one = renderToStaticMarkup(
      <FunnelChart title="F" steps={steps.slice(0, 1)} labels={labels} />,
    );
    expect(one).toContain('Not enough data');
    const zero = renderToStaticMarkup(
      <FunnelChart title="F" steps={steps.map((x) => ({ ...x, value: 0 }))} labels={labels} />,
    );
    expect(zero).toContain('No orders in this period');
    expect(zero).toContain('Orders appear after checkout');
  });
});

describe('44px touch targets up to lg', () => {
  it('covers the chart error retry, the card link and the line chart toggle', () => {
    const retry = renderToStaticMarkup(
      <ChartError message="x" retryLabel="Retry" onRetry={() => {}} />,
    );
    expect(retry).toContain('min-h-11');
    expect(retry).toContain('lg:min-h-0');
    const card = renderToStaticMarkup(
      <DashboardCard id="c" title="T" action={{ href: '/x', label: 'View all' }}>
        <p />
      </DashboardCard>,
    );
    expect(card).toContain('min-h-11');
    render(
      <LineAreaChart
        title="t"
        points={[{ label: 'a', value: 1 }]}
        seriesLabel="s"
        formatValue={String}
        labels={{ viewAsTable: 'View as table', viewAsChart: 'View as chart', dateColumn: 'Day' }}
      />,
    );
    expect(screen.getByRole('button', { name: 'View as table' }).className).toContain('min-h-11');
  });
  it('keeps segments 44px to lg and puts the phone select on its own line', () => {
    const { container } = render(
      <PeriodSelector
        label="Period"
        options={[{ id: 'a', label: 'A' }]}
        value="a"
        onChange={() => {}}
        note="n"
      />,
    );
    expect(container.innerHTML).toContain('min-h-11 items-center');
    expect(container.innerHTML).toContain('lg:min-h-10');
    expect(screen.getByRole('combobox').parentElement?.className).toContain('w-full');
  });
});

describe('equal-height cards', () => {
  it('stretches grid items and cards', () => {
    const html = renderToStaticMarkup(
      <DashboardGrid>
        <GridItem span={6}>
          <DashboardCard id="c" title="T">
            x
          </DashboardCard>
        </GridItem>
      </DashboardGrid>,
    );
    expect(html).toContain('items-stretch');
    expect(html).toContain('class="flex min-w-0');
    expect(html).toContain('h-full');
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
    expect(html).toContain('<li class="flex min-w-0');
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
