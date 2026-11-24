// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { KpiCard } from './kpi-card.tsx';

afterEach(cleanup);

const base = {
  icon: 'wallet',
  tile: 'blue',
  label: 'Sales',
  definition: 'Goods of paid orders.',
  definitionLabel: 'What is Sales?',
  scope: 'Last 30 days',
} as const;

describe('KpiCard', () => {
  it('shows the figure, its scope and the change, and links the label to the list', () => {
    render(
      <KpiCard
        {...base}
        value="$23,480.00"
        href="/earnings"
        delta={{ value: '+9.6%', direction: 'up', sentiment: 'good', comparedWith: 'vs previous' }}
      />,
    );
    expect(screen.getByText('$23,480.00')).toBeTruthy();
    expect(screen.getByText('Last 30 days')).toBeTruthy();
    expect(screen.getByText('+9.6%')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sales' }).getAttribute('href')).toBe('/earnings');
  });

  it('opens and closes the definition from the question mark', () => {
    render(<KpiCard {...base} value="1" />);
    const button = screen.getByRole('button', { name: 'What is Sales?' });
    expect(screen.queryByText('Goods of paid orders.')).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(screen.getByText('Goods of paid orders.').id);
    fireEvent.click(button);
    expect(screen.queryByText('Goods of paid orders.')).toBeNull();
  });

  it('says a withheld figure in words and an error as an alert, with no number either way', () => {
    const { rerender } = render(<KpiCard {...base} note="Available after a week" />);
    expect(screen.getByText('Available after a week')).toBeTruthy();
    rerender(<KpiCard {...base} error="Could not load" />);
    expect(screen.getByRole('alert').textContent).toBe('Could not load');
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('marks only the highlighted card', () => {
    const { container } = render(
      <>
        <KpiCard {...base} value="1" highlight />
        <KpiCard {...base} value="2" tile="aqua" />
      </>,
    );
    expect(container.querySelectorAll('[data-highlight]')).toHaveLength(1);
  });

  it('requires a note or an error when there is no figure', () => {
    // @ts-expect-error a card without a figure must say why: `note` (or `error`) is required
    render(<KpiCard {...base} />);
    expect(screen.getByText('Last 30 days')).toBeTruthy();
  });
});
