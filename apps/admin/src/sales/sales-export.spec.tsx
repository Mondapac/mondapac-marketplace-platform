// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast, Toaster } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import {
  exportQuery,
  safeFileName,
  useSalesExport,
  type ExportSelection,
} from './sales-export.tsx';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ID_1 = '0190a000-0000-7000-8000-0000000000d1';
const ID_2 = '0190a000-0000-7000-8000-0000000000d2';

function Harness(props: { selection: ExportSelection }) {
  const { item, dialog } = useSalesExport({
    path: 'ordering/admin/documents/export',
    fallbackName: 'invoices',
    listQuery: 'kind=credit-note&page=3&sort=total',
    columns: ['total', 'store'],
    zone: 'Australia/Brisbane',
    selection: props.selection,
  });
  return (
    <>
      <button type="button" disabled={item.disabled === true} onClick={item.onSelect}>
        open
      </button>
      {dialog}
    </>
  );
}

const mount = (selection: ExportSelection) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <Harness selection={selection} />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );

const ticked = (ids: string[]): ExportSelection => ({ ids, allMatching: false, total: 50 });

describe('exportQuery', () => {
  it('refuses to name no rows: an empty selection without "Select all matching"', () => {
    const base = { listQuery: 'kind=credit-note', format: 'csv', columns: ['total'], zone: 'UTC' };
    expect(() => exportQuery({ ...base, format: 'csv', selection: ticked([]) })).toThrow();
    expect(
      exportQuery({ ...base, format: 'csv', selection: { ids: [], allMatching: true, total: 5 } }),
    ).not.toContain('ids=');
  });
});

describe('safeFileName', () => {
  it('strips / and \\ and keeps the rest', () => {
    expect(safeFileName('..\\..//etc/passwd.csv')).toBe('....etcpasswd.csv');
    expect(safeFileName('/\\')).toBe('');
    expect(safeFileName('invoices-2026-11-17.csv')).toBe('invoices-2026-11-17.csv');
  });
});

describe('the Sales export download', () => {
  const names: string[] = [];
  const fetched: string[] = [];
  let click: { mockRestore: () => void };
  const answerWith = (make: () => Response) =>
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(make());
      }),
    );
  const run = (format: 'CSV' | 'XLSX' = 'CSV') => {
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(`^${format}`) }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
  };

  beforeEach(() => {
    names.length = 0;
    fetched.length = 0;
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
  });
  afterEach(() => {
    cleanup();
    toast.dismiss();
    click.mockRestore();
    vi.unstubAllGlobals();
  });

  it('shows the access message for a 403', async () => {
    mount(ticked([ID_1]));
    answerWith(() => new Response('{"code":"access.denied"}', { status: 403 }));
    run();
    expect(await screen.findByText("You don't have access to export this list.")).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('shows the plain too-many-rows message for a 413 without details', async () => {
    mount(ticked([ID_1]));
    answerWith(() => new Response('{"code":"batch.too-large"}', { status: 413 }));
    run();
    expect(
      await screen.findByText('Too many rows to export. Narrow the filter or select fewer rows.'),
    ).toBeTruthy();
  });

  it('shows the "cannot be exported" message for a 400 that is not too-broad', async () => {
    mount(ticked([ID_1]));
    answerWith(
      () =>
        new Response(
          '{"code":"validation.failed","details":{"fields":[{"path":"ids","code":"invalid"}]}}',
          { status: 400 },
        ),
    );
    run();
    expect(
      await screen.findByText(
        "This list can't be exported with its current filters. Change them and try again.",
      ),
    ).toBeTruthy();
  });

  it('names an XLSX with no server name from the fallback and the day in the zone, and counts the ticked ids', async () => {
    mount(ticked([ID_1, ID_2]));
    answerWith(
      () =>
        new Response(new Uint8Array([0x50, 0x4b]), {
          status: 200,
          headers: { 'content-type': XLSX },
        }),
    );
    run('XLSX');
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(names).toEqual([expect.stringMatching(/^invoices-\d{4}-\d{2}-\d{2}\.xlsx$/)]);
    expect(new URL(fetched[0]!, 'http://x').searchParams.get('ids')).toBe(`${ID_1},${ID_2}`);
  });

  it('says "ready" for an XLSX after "Select all matching" with no known total', async () => {
    mount({ ids: [], allMatching: true, total: null });
    answerWith(
      () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': XLSX } }),
    );
    run('XLSX');
    expect(await screen.findByText('Your file is ready.')).toBeTruthy();
  });

  it('saves the server name without path separators', async () => {
    mount(ticked([ID_1]));
    answerWith(
      () =>
        new Response('Id\r\na\r\n', {
          status: 200,
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="..\\..//invoices.csv"',
          },
        }),
    );
    run();
    expect(await screen.findByText('Exported 1 row.')).toBeTruthy();
    expect(names).toEqual(['....invoices.csv']);
  });

  it('does not save an answer that is not the file (a page from a proxy, a wrong type)', async () => {
    mount(ticked([ID_1]));
    answerWith(
      () =>
        new Response('<html>oops</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    run();
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(names).toEqual([]);
    toast.dismiss();
    answerWith(
      () => new Response('a,b\r\n', { status: 200, headers: { 'content-type': 'text/csv' } }),
    );
    run('XLSX');
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(names).toEqual([]);
  });

  it('starts nothing, and sends no ids=, when nothing is ticked and "Select all matching" is off', () => {
    mount(ticked([]));
    answerWith(() => new Response('', { status: 200 }));
    expect(screen.getByRole('button', { name: 'open' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetched).toEqual([]);
  });
});
