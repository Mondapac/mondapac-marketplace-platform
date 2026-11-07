// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { toast, Toaster } from '@mondapac/ui';
import { DEFAULT_QUERY, type Query } from './products-types.ts';
import { VariantsExport, variantExportQuery } from './variants-export.tsx';

const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';

function mount(query: Query = DEFAULT_QUERY) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <VariantsExport query={query} />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}

describe('variantExportQuery', () => {
  it('carries the tab, the search and the filters of the list, and nothing else', () => {
    const query: Query = {
      ...DEFAULT_QUERY,
      view: 'all',
      q: '  shirt ',
      filters: { scope: 'SELLER', status: 'published', categoryId: CATEGORY },
      sort: 'name',
      page: 3,
    };
    expect(variantExportQuery(query, 'xlsx').toString()).toBe(
      `format=xlsx&view=all&q=shirt&scope=SELLER&status=published&categoryId=${CATEGORY}`,
    );
    expect(variantExportQuery(DEFAULT_QUERY, 'csv').toString()).toBe('format=csv&view=active');
  });
});

describe('Export variants on the product list', () => {
  let fetched: string[];
  let click: { mockRestore: () => void } & ReturnType<typeof vi.fn>;

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    fetched = [];
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:v'), revokeObjectURL: vi.fn() });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    toast.dismiss();
    vi.unstubAllGlobals();
    click.mockRestore();
  });

  const serve = (respond: () => Response) =>
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(respond());
      }),
    );

  it('asks for the format first, then downloads the CSV with the list query', async () => {
    serve(() => new Response('product_code\r\n', { status: 200 }));
    mount({ ...DEFAULT_QUERY, view: 'all', q: 'shirt' });

    fireEvent.click(screen.getByRole('button', { name: 'Export variants' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export variants' });
    expect(fetched).toEqual([]);
    expect(within(dialog).getByRole<HTMLInputElement>('radio', { name: /^CSV/ }).checked).toBe(
      true,
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));

    expect(await screen.findByText('The variant file was downloaded.')).toBeTruthy();
    expect(fetched).toEqual(['/api/catalog/admin/variants/export?format=csv&view=all&q=shirt']);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('downloads an XLSX workbook as bytes when that format is chosen', async () => {
    serve(() => new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { status: 200 }));
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Export variants' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export variants' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^XLSX/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(fetched).toEqual(['/api/catalog/admin/variants/export?format=xlsx&view=active']);
  });

  it('says how wide the filter may be when the file would be too large', async () => {
    serve(
      () =>
        new Response(
          JSON.stringify({ code: 'export.too-large', details: { max: 10000, total: 12345 } }),
          { status: 413 },
        ),
    );
    mount();

    fireEvent.click(screen.getByRole('button', { name: 'Export variants' }));
    const dialog = await screen.findByRole('dialog', { name: 'Export variants' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));

    expect(
      await screen.findByText(
        'The file would be too large (12,345). Narrow the filter so it has 10,000 rows or fewer.',
      ),
    ).toBeTruthy();
    expect(click).not.toHaveBeenCalled();
  });

  it('words a refusal and a network failure without leaking the answer', async () => {
    serve(() => new Response(JSON.stringify({ code: 'access.denied' }), { status: 403 }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Export variants' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Export variants' })).getByRole('button', {
        name: 'Export',
      }),
    );
    expect(await screen.findByText('You don’t have access to do this.')).toBeTruthy();

    toast.dismiss();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export variants' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Export variants' })).getByRole('button', {
        name: 'Export',
      }),
    );
    expect(await screen.findByText('That didn’t work. Try again.')).toBeTruthy();
  });
});
