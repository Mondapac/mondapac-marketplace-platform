// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const { replace, download, toasts } = vi.hoisted(() => ({
  replace: vi.fn(),
  download: vi.fn<(input: unknown) => Promise<number | null>>(),
  toasts: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }), usePathname: () => '/' }));
vi.mock('../sales/sales-export.tsx', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    downloadSalesExport: (input: unknown): Promise<number | null> => download(input),
  };
});
vi.mock('@mondapac/ui', async (importOriginal) => {
  const original = await importOriginal<{ toast: object } & Record<string, unknown>>();
  return { ...original, toast: { ...original.toast, ...toasts } };
});

import { ExportFailure } from '../sales/sales-export.tsx';
import type { KpiSelection } from './kpi-range.ts';
import { PeriodSwitch } from './period-switch.tsx';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const TODAY = '2026-11-23';
const options = ['today', '7d', '30d', 'month', 'custom'].map((id) => ({ id, label: id }));
const shown = (
  selection: KpiSelection = { id: '30d' },
  extra: { canExport?: boolean; fields?: { path: string; code: string }[] } = {},
) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PeriodSwitch
        title="Dashboard"
        label="Period"
        options={options}
        selection={selection}
        today={TODAY}
        zone="Australia/Brisbane"
        fields={extra.fields ?? []}
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

describe('PeriodSwitch', () => {
  it('puts a preset in the address and shows the figures below', () => {
    shown();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '7d' }));
    expect(replace).toHaveBeenCalledWith('/?period=7d', { scroll: false });
    expect(screen.getByText('figures')).toBeTruthy();
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

  it('puts a refusal that belongs to neither day under the pair, never the API path', () => {
    shown(
      { id: 'custom', from: '2026-10-01', to: '2026-10-31' },
      { fields: [{ path: 'secret.internal', code: 'weird' }] },
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'This range is not accepted. Check both days and try again.',
    );
    expect(document.body.textContent).not.toContain('secret.internal');
  });

  it('allows exactly 13 months and the Market today', () => {
    shown();
    fireEvent.click(screen.getByRole('radio', { name: 'custom' }));
    pick('2025-10-24', '2026-11-23');
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it('shows the fields the server refused under the pickers', () => {
    shown(
      { id: 'custom', from: '2024-01-01', to: '2026-11-23' },
      {
        fields: [{ path: 'from', code: 'too-long' }],
      },
    );
    expect(screen.getByText('Start no earlier than 24 Oct 2025.')).toBeTruthy();
  });

  describe('export', () => {
    it('is hidden without the export keys', () => {
      shown({ id: '30d' }, { canExport: false });
      expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
    });

    it('downloads the shown preset as CSV or XLSX through the relay path', async () => {
      download.mockResolvedValue(null);
      shown({ id: '7d' });
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
      await waitFor(() => expect(toasts.success).toHaveBeenCalled());
      expect(download).toHaveBeenCalledWith(
        expect.objectContaining({
          path: 'reporting/admin/daily/export',
          query: 'period=7d&format=csv',
          format: 'csv',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /XLSX/ }));
      await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
      expect(download.mock.calls[1]![0]).toEqual(
        expect.objectContaining({ query: 'period=7d&format=xlsx', format: 'xlsx' }),
      );
    });

    it('sends the custom range with the file request', async () => {
      download.mockResolvedValue(null);
      shown({ id: 'custom', from: '2026-09-01', to: '2026-11-23' });
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /XLSX/ }));
      await waitFor(() => expect(download).toHaveBeenCalled());
      expect(download.mock.calls[0]![0]).toEqual(
        expect.objectContaining({
          query: 'period=custom&from=2026-09-01&to=2026-11-23&format=xlsx',
        }),
      );
    });

    it('is disabled for a custom range that is not valid', () => {
      shown({ id: 'custom', from: '2024-01-01', to: '2026-11-23' });
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(true);
      expect(screen.getByTitle('Choose a valid range to export it.')).toBeTruthy();
    });

    it('says once that the session cannot export, then hides the button', async () => {
      download.mockRejectedValue(new ExportFailure('denied'));
      shown();
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Export' })).toBeNull());
      expect(toasts.error).toHaveBeenCalledWith("You can't export this report.", expect.anything());
    });

    it('shows a toast for any other failure and keeps the button', async () => {
      download.mockRejectedValue(new ExportFailure('unavailable'));
      shown();
      fireEvent.click(screen.getByRole('button', { name: 'Export' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /CSV/ }));
      await waitFor(() =>
        expect(toasts.error).toHaveBeenCalledWith('Export failed. Try again.', expect.anything()),
      );
      expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy();
    });
  });
});
