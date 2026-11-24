// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/' }));

import { toast } from '@mondapac/ui';
import type { Selection } from './range.ts';
import { PeriodSwitch } from './period-switch.tsx';

const toasts = {
  success: vi.spyOn(toast, 'success').mockReturnValue(''),
  error: vi.spyOn(toast, 'error').mockReturnValue(''),
};
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal(
    'URL',
    Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }),
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

const TODAY = '2026-11-23';
const options = ['today', '7d', '30d', 'month', 'custom'].map((id) => ({ id, label: id }));
const shown = (selection: Selection = { id: '30d' }, extra: { canExport?: boolean } = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PeriodSwitch
        title="Dashboard"
        label="Period"
        options={options}
        selection={selection}
        today={TODAY}
        zone="Australia/Brisbane"
        canExport={extra.canExport ?? true}
      >
        <p>figures</p>
      </PeriodSwitch>
    </NextIntlClientProvider>,
  );
const pick = (from: string, to: string) => {
  fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: to } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
};
const file = (type = 'text/csv') =>
  new Response('a,b\n', { status: 200, headers: { 'content-type': type } });
const openExport = (item: RegExp) => {
  fireEvent.click(screen.getByRole('button', { name: 'Export' }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
};

describe('PeriodSwitch', () => {
  it('puts a preset in the address and shows the figures below', () => {
    shown();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '7d' }));
    expect(replace).toHaveBeenCalledWith('/?period=7d', { scroll: false });
    expect(screen.getByText('figures')).toBeTruthy();
  });

  it('has the title and the buttons on one row and no subtitle', () => {
    shown();
    const header = screen.getByRole('heading', { name: 'Dashboard' }).parentElement!;
    expect(header.querySelectorAll('p')).toHaveLength(0);
  });

  it('opens the pickers on Custom without leaving the page, then keeps the range in the address', () => {
    shown();
    expect(screen.queryByLabelText('From')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'custom' }));
    expect(replace).not.toHaveBeenCalled();
    pick('2026-09-01', '2026-11-23');
    expect(replace).toHaveBeenCalledWith('/?period=custom&from=2026-09-01&to=2026-11-23', {
      scroll: false,
    });
  });

  it('shows the pickers filled for a range already in the address', () => {
    shown({ id: 'custom', from: '2026-10-01', to: '2026-10-31' });
    expect(screen.getByLabelText<HTMLInputElement>('From').value).toBe('2026-10-01');
    expect(screen.getByLabelText<HTMLInputElement>('To').value).toBe('2026-10-31');
  });

  it.each([
    ['2026-11-10', '2026-11-01', 'The start day is after the end day.'],
    ['2025-09-01', '2026-11-23', 'Start no earlier than 24 Oct 2025.'],
    ['2026-11-01', '2026-11-24', 'The latest end day is 23 Nov 2026.'],
    ['', '2026-11-23', 'Choose a day.'],
  ])('refuses %s to %s under its field and does not change the address', (from, to, text) => {
    shown();
    fireEvent.click(screen.getByRole('radio', { name: 'custom' }));
    pick(from, to);
    expect(screen.getByText(text)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
    // One message, announced once, and focus on the field that is wrong.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toBe(text);
    expect(document.activeElement).toBe(
      screen.getByLabelText(from === '' || from > to || text.startsWith('Start') ? 'From' : 'To'),
    );
  });

  it('limits the pickers to the 13 months and the Market today', () => {
    shown({ id: 'custom', from: '2026-10-01', to: '2026-10-31' });
    expect(screen.getByLabelText<HTMLInputElement>('From').min).toBe('2025-10-01');
    expect(screen.getByLabelText<HTMLInputElement>('From').max).toBe(TODAY);
    expect(screen.getByLabelText<HTMLInputElement>('To').max).toBe(TODAY);
  });

  it('allows exactly 13 months and the Market today', () => {
    shown();
    fireEvent.click(screen.getByRole('radio', { name: 'custom' }));
    pick('2025-10-24', '2026-11-23');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('says what is shown until Apply, and an unchanged Apply closes the form', () => {
    shown({ id: 'custom', from: '2026-10-01', to: '2026-10-31' });
    expect(screen.getByText('Showing 1 Oct 2026 to 31 Oct 2026 until you apply.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('From')).toBeNull();
  });

  it('names the preset being shown while the pickers are open', () => {
    shown({ id: '7d' });
    fireEvent.click(screen.getByRole('radio', { name: 'custom' }));
    expect(screen.getByText('Showing 7 days until you apply.')).toBeTruthy();
  });

  it('says nothing is shown when the range in the address is refused', () => {
    shown({ id: 'custom', from: '2024-01-01', to: '2026-11-23' });
    expect(screen.queryByText(/until you apply/)).toBeNull();
    expect(screen.getByText('Start no earlier than 24 Oct 2025.')).toBeTruthy();
  });

  describe('export', () => {
    it('is hidden without the export keys', () => {
      shown({ id: '30d' }, { canExport: false });
      expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    });

    it('says what the file holds', () => {
      shown();
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      expect(screen.getByText('Figures for the shown period')).toBeTruthy();
      expect(screen.getAllByText(/Daily figures per Market day/)).toHaveLength(2);
    });

    it('downloads the shown preset as CSV or XLSX through the relay path', async () => {
      fetchMock.mockResolvedValueOnce(file());
      shown({ id: '7d' });
      openExport(/CSV/);
      await waitFor(() => expect(toasts.success).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]![0]).toBe(
        '/api/reporting/seller/daily/export?period=7d&format=csv',
      );
      fetchMock.mockResolvedValueOnce(
        file('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      );
      openExport(/XLSX/);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(fetchMock.mock.calls[1]![0]).toBe(
        '/api/reporting/seller/daily/export?period=7d&format=xlsx',
      );
    });

    it('sends the applied custom range with the file request', async () => {
      fetchMock.mockResolvedValueOnce(file());
      shown({ id: 'custom', from: '2026-09-01', to: '2026-11-23' });
      openExport(/CSV/);
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]![0]).toBe(
        '/api/reporting/seller/daily/export?period=custom&from=2026-09-01&to=2026-11-23&format=csv',
      );
    });

    it('is disabled with a reason for a custom range that is not valid', () => {
      shown({ id: 'custom', from: '2024-01-01', to: '2026-11-23' });
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(true);
      expect(screen.getByTitle('Choose a valid range to export it.')).toBeTruthy();
    });

    it('says once that the session cannot export, then hides the button', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 403 }));
      shown();
      openExport(/CSV/);
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Export' })).toBeNull());
      expect(toasts.error).toHaveBeenCalledTimes(1);
      expect(toasts.error).toHaveBeenCalledWith("You can't export this report.", expect.anything());
    });

    it('shows a toast for any other failure and keeps the button', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }));
      shown();
      openExport(/CSV/);
      await waitFor(() =>
        expect(toasts.error).toHaveBeenCalledWith('Export failed. Try again.', expect.anything()),
      );
      expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    });
  });
});
