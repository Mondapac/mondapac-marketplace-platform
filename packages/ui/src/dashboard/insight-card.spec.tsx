// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StatDelta } from './stat-delta.tsx';
import { InsightCard, type InsightTable } from './insight-card.tsx';

afterEach(cleanup);

const table: InsightTable = {
  caption: 'Top categories as a table',
  columns: [
    { id: 'name', header: 'Category' },
    { id: 'sales', header: 'Sales', align: 'end' },
  ],
  rows: [
    ['Lamb', '$4,210.00'],
    ['Chicken', '$3,380.00'],
  ],
};
const card = (over: Partial<Parameters<typeof InsightCard>[0]> = {}) => (
  <InsightCard
    id="x"
    title="Top categories"
    definition="Sales after refunds."
    definitionLabel="What is Top categories?"
    chart={<p>the chart</p>}
    table={table}
    viewAsTable="View as table"
    viewAsChart="View as chart"
    {...over}
  />
);

describe('InsightCard', () => {
  it('switches between the chart and the same figures as a table', () => {
    render(card());
    expect(screen.getByText('the chart')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const grid = screen.getByRole('table', { name: 'Top categories as a table' });
    expect(within(grid).getAllByRole('row')).toHaveLength(3);
    expect(within(grid).getByText('$3,380.00')).toBeTruthy();
    expect(screen.queryByText('the chart')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View as chart' }));
    expect(screen.getByText('the chart')).toBeTruthy();
  });

  it('has no table toggle for a state without a chart, but keeps the definition', () => {
    render(card({ table: undefined, chart: <p>Not enough data</p> }));
    expect(screen.queryByRole('button', { name: 'View as table' })).toBeNull();
    const help = screen.getByRole('button', { name: 'What is Top categories?' });
    fireEvent.click(help);
    expect(screen.getByText('Sales after refunds.')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Sales after refunds.')).toBeNull();
  });
});

describe('StatDelta without a figure', () => {
  it('says why in a title and to screen readers', () => {
    const { container } = render(
      <StatDelta
        value="n/a"
        direction="flat"
        sentiment="neutral"
        comparedWith="vs previous 30 days"
        hint="Too few orders in the previous period to compare."
      />,
    );
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(
      'Too few orders in the previous period to compare.',
    );
    expect(container.textContent).toContain('Too few orders in the previous period to compare.');
  });
});
