// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/' }));

import { PeriodSwitch } from './period-switch.tsx';

afterEach(() => {
  cleanup();
  replace.mockReset();
});

const options = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

describe('PeriodSwitch', () => {
  it('puts the choice in the address and shows the figures below it', () => {
    render(
      <PeriodSwitch title="Dashboard" label="Period" options={options} value="30d">
        <p>figures</p>
      </PeriodSwitch>,
    );
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '7 days' }));
    expect(replace).toHaveBeenCalledWith('/?period=7d', { scroll: false });
    expect(screen.getByText('figures')).toBeTruthy();
  });
});
