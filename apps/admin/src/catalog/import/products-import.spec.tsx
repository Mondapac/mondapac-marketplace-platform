// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

import type * as Ui from '@mondapac/ui';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('@mondapac/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  flashToast: vi.fn(),
}));

import { flashToast } from '@mondapac/ui';
import { callApi } from '../../api/client.ts';
import { ProductsImport } from './products-import.tsx';
import type { ImportTemplate, ImportView } from './import-types.ts';

const call = vi.mocked(callApi);
const toast = vi.mocked(flashToast);
const ID = '0190a000-0000-7000-8000-000000000001';
const BASE = 'catalog/admin/platform-imports';

const template: ImportTemplate = {
  columns: [
    { key: 'title', header: 'Title', required: true },
    { key: 'category', header: 'Main category', required: true },
    { key: 'type', header: 'Product type', required: true },
    { key: 'description', header: 'Description', required: false },
    { key: 'brand', header: 'Brand', required: false },
    { key: 'gtin', header: 'Barcode (GTIN)', required: false },
    { key: 'unitSize', header: 'Unit size', required: false },
    { key: 'imageUrl', header: 'Image URL', required: false },
    { key: 'taxCategory', header: 'Tax category', required: false },
  ],
  typesOffered: ['simple'],
  limits: { rows: 5000, fileBytes: 10 * 1024 * 1024 },
  filename: 'products-template.csv',
  csv: 'Title,Main category\n',
  xlsxFilename: 'products-template.xlsx',
  xlsx: btoa('PK-template'),
};

const view = (over: Partial<ImportView> = {}): ImportView => ({
  id: ID,
  state: 'checked',
  fileLabel: 'products-oct.csv',
  fileBytes: 2_400_000,
  rows: 1240,
  ready: 1198,
  errors: 30,
  warnings: 12,
  ignoredColumns: [],
  startAs: null,
  skipErrors: null,
  toImport: null,
  added: 0,
  failed: 0,
  stopReason: null,
  canResume: false,
  checkedAt: '2026-10-31T10:24:00.000Z',
  startedAt: null,
  finishedAt: null,
  durationSeconds: null,
  errorLines: [
    {
      rowNumber: 12,
      column: 'category',
      code: 'category.unknown',
      value: 'Fresh Meats',
      otherRow: null,
    },
    { rowNumber: 47, column: 'title', code: 'required', value: '', otherRow: null },
    { rowNumber: 88, column: 'gtin', code: 'gtin.length', value: '93123', otherRow: null },
    {
      rowNumber: 130,
      column: 'title',
      code: 'duplicate-in-file',
      value: 'Ghee 400 g',
      otherRow: 129,
    },
  ],
  failureLines: [],
  preview: [],
  ...over,
});

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, body } as never);
const fail = (status: number, code: string, details?: object) =>
  Promise.resolve({
    ok: false,
    failure: { status, code, ...(details ? { details } : {}) },
  } as never);

/** The API by path: the current import (or none), the template, and whatever the test adds. */
function serve(
  current: ImportView | null,
  extra: (method: string, path: string, body?: unknown) => Promise<never> | undefined = () =>
    undefined,
) {
  call.mockImplementation((method, path, body) => {
    const own = extra(method, path, body);
    if (own !== undefined) return own;
    if (path === `${BASE}/template`) return ok(template);
    if (path === `${BASE}/current`) return ok({ import: current });
    if (path === `${BASE}/${ID}` && current !== null) return ok(current);
    return fail(404, 'import.not-found');
  });
}

const ALL = ['catalog.platform-import.run', 'catalog.product.pause'];

function mount(permissionKeys: readonly string[] = ALL, openImportId: string | null = null) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductsImport
        permissionKeys={permissionKeys}
        csrfToken="csrf-1"
        openImportId={openImportId}
      />
    </NextIntlClientProvider>,
  );
}

function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]')!;
  const files = { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) };
  fireEvent.change(input, { target: { files } });
}

describe('admin import products', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
  });

  it('opens on the upload step with the template guide and the certification note', async () => {
    serve(null);
    mount();
    expect(await screen.findByRole('heading', { name: 'Upload a file' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Import products' })).toBeTruthy();
    expect(screen.getByText('Drag a CSV or XLSX file here')).toBeTruthy();
    expect(screen.getByText('One product per row · up to 5,000 rows and 10 MB')).toBeTruthy();
    expect(screen.getByRole('button', { name: /CSV template/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /XLSX template/ })).toBeTruthy();
    expect(screen.getByText('Main category')).toBeTruthy();
    expect(
      screen.getByText(
        'Certification tags are not imported: they belong to each seller’s offer, not to the product.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    // Steps bar, Upload file current.
    expect(screen.getByText('Upload file').closest('li')?.getAttribute('aria-current')).toBe(
      'step',
    );
    // The file picker offers CSV and XLSX.
    const input = document.querySelector('input[type="file"]')!;
    expect(input.getAttribute('accept')).toContain('.csv');
    expect(input.getAttribute('accept')).toContain('.xlsx');
  });

  it('sends the chosen file as base64 and shows the check with errors', async () => {
    serve(null, (method, path) => (method === 'POST' && path === BASE ? ok(view()) : undefined));
    const { container } = mount();
    await screen.findByText('Drag a CSV or XLSX file here');
    pick(container, new File(['Title\nA\n'], 'products-oct.csv', { type: 'text/csv' }));
    expect(await screen.findByText('30 rows have errors')).toBeTruthy();
    const post = call.mock.calls.find((entry) => entry[0] === 'POST' && entry[1] === BASE)!;
    expect(post[2]).toEqual({ fileName: 'products-oct.csv', data: btoa('Title\nA\n') });
    expect(post[3]).toBe('csrf-1');
    // Tiles.
    const ready = screen.getByText('Ready to import').closest('li')!;
    expect(within(ready).getByText('1,198')).toBeTruthy();
    expect(screen.getByText('Rows in the file').closest('li')!.textContent).toContain('1,240');
    // Error table: row, column, value, problem in words.
    const table = screen.getByRole('table', { name: 'Rows with errors' });
    expect(within(table).getByText('Fresh Meats')).toBeTruthy();
    expect(within(table).getByText('No category with this name')).toBeTruthy();
    expect(within(table).getByText('(empty)')).toBeTruthy();
    expect(within(table).getByText('Title is required')).toBeTruthy();
    // Below 1024 px each row is a card: every cell names its column (Problem stays visible).
    expect(within(table).getByText('Title is required').getAttribute('data-label')).toBe('Problem');
    expect(within(table).getByText('Same title and brand as row 129')).toBeTruthy();
    expect(screen.getByText('Showing 4 of 30 rows with errors')).toBeTruthy();
    const download = screen.getByRole('link', { name: 'Download error report (CSV)' });
    expect(download.getAttribute('href')).toBe(`/api/${BASE}/${ID}/report?kind=errors`);
    expect(screen.getByText('Upload a corrected file')).toBeTruthy();
  });

  it('keeps Import off until the skip box is ticked, then starts as Inactive after the confirm', async () => {
    serve(view(), (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/start`
        ? ok(view({ state: 'queued', startAs: 'inactive', skipErrors: true, toImport: 1198 }))
        : undefined,
    );
    mount();
    const importButton = await screen.findByRole('button', { name: 'Import 1,198 products' });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText('Inactive is safer: check them in the list, then activate them in bulk.'),
    ).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Inactive' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Skip the 30 rows with errors/ }));
    expect((importButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(importButton);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Import 1,198 products?')).toBeTruthy();
    expect(dialog.textContent).toContain('as Inactive products');
    expect(dialog.textContent).toContain('The 30 rows with errors are skipped.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('You can leave this page')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      `${BASE}/${ID}/start`,
      { startAs: 'inactive', skipErrors: true },
      'csrf-1',
    );
    expect(screen.getByRole('button', { name: 'Back to products' })).toBeTruthy();
  });

  it('shows a clean file with a preview and no skip box, and starts as Active when chosen', async () => {
    const clean = view({
      rows: 3,
      ready: 3,
      errors: 0,
      warnings: 0,
      errorLines: [],
      preview: [
        {
          rowNumber: 2,
          title: 'Lamb cutlets 500 g',
          category: 'Meat',
          typeCode: 'simple',
          brand: 'Cedar',
        },
        { rowNumber: 3, title: 'Plain flour', category: 'Pantry', typeCode: 'simple', brand: '' },
      ],
    });
    serve(clean, (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/start`
        ? ok(view({ ...clean, state: 'queued', startAs: 'active', toImport: 3 }))
        : undefined,
    );
    mount();
    expect(await screen.findByText('All 3 rows are ready to import')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('Lamb cutlets 500 g')).toBeTruthy();
    expect(screen.getByText('Showing the first 2 of 3 rows')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Active' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 3 products' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Import' }),
    );
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `${BASE}/${ID}/start`,
        { startAs: 'active', skipErrors: false },
        'csrf-1',
      ),
    );
  });

  it('without the right to pause, Inactive cannot be chosen and the start is Active', async () => {
    serve(view({ errors: 0, errorLines: [] }));
    mount(['catalog.platform-import.run']);
    await screen.findByRole('button', { name: 'Import 1,198 products' });
    expect(screen.getByRole<HTMLButtonElement>('radio', { name: 'Inactive' }).disabled).toBe(true);
    expect(screen.getByRole('radio', { name: 'Active' }).getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByText('You can’t make products Inactive, so they start Active.'),
    ).toBeTruthy();
  });

  it('Cancel on the check discards the file', async () => {
    serve(view(), (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/discard` ? ok({}) : undefined,
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('POST', `${BASE}/${ID}/discard`, {}, 'csrf-1'),
    );
  });

  it('shows progress while the import runs', async () => {
    serve(view({ state: 'running', startAs: 'inactive', toImport: 1198, added: 400, failed: 2 }));
    mount();
    expect(await screen.findByText('402 of 1,198 rows done')).toBeTruthy();
    expect(
      screen.getByRole('progressbar', { name: 'Import progress' }).getAttribute('aria-valuenow'),
    ).toBe('34');
    expect(screen.getByText('You can leave this page')).toBeTruthy();
    expect(screen.getByText('Import').closest('li')?.getAttribute('aria-current')).toBe('step');
  });

  it('shows the finished report, and Done flashes the toast', async () => {
    serve(
      view({
        state: 'finished',
        startAs: 'inactive',
        toImport: 1198,
        added: 1196,
        failed: 2,
        durationSeconds: 130,
        failureLines: [
          { rowNumber: 301, title: 'Ghee 400 g', code: 'claim-text.found' },
          { rowNumber: 877, title: 'Halwa 250 g', code: 'something.new' },
        ],
      }),
      undefined,
    );
    mount(ALL, ID);
    const finishedBanner = await screen.findByText('Import finished: 1,196 products added');
    expect(finishedBanner).toBeTruthy();
    // The Success tone (piDone), also when some rows were not imported: the tile carries the warning.
    expect(finishedBanner.closest('[role="status"]')?.className).toContain('bg-success-bg');
    expect(screen.getByText('Skipped at check').closest('li')!.textContent).toContain('42');
    expect(screen.getByText('Not imported').closest('li')!.textContent).toContain('2');
    expect(screen.getByText('Time').closest('li')!.textContent).toContain('2 min 10 s');
    const table = screen.getByRole('table', { name: 'Rows that were not imported' });
    expect(within(table).getByText(/mentions a certification/)).toBeTruthy();
    expect(within(table).getByText('The product could not be added')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Download full report (CSV)' }).getAttribute('href'),
    ).toBe(`/api/${BASE}/${ID}/report?kind=full`);
    expect(
      screen.getByRole('link', { name: 'View the imported products' }).getAttribute('href'),
    ).toBe('/catalog/products');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(toast).toHaveBeenCalledWith('success', '1,196 products imported as Inactive.');
  });

  it('shows an import that stopped part way and retries the rest', async () => {
    const stopped = view({
      state: 'stopped',
      startAs: 'inactive',
      toImport: 1198,
      added: 640,
      failed: 0,
      stopReason: 'rate-limited',
      canResume: true,
    });
    serve(stopped, (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/resume`
        ? ok({ ...stopped, state: 'queued', stopReason: null })
        : undefined,
    );
    mount(ALL, ID);
    expect(await screen.findByText('The import stopped after 640 products')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry the rest' }));
    expect(await screen.findByText('You can leave this page')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', `${BASE}/${ID}/resume`, {}, 'csrf-1');
  });

  it('words each refusal of the upload on the step where it happens', async () => {
    const cases: readonly [string, number, string, object | undefined, string][] = [
      ['file.unsupported-type', 415, 'wrong', undefined, 'This file type can’t be imported'],
      ['file.too-many-rows', 422, 'rows', { rows: 7820, max: 5000 }, 'The file has 7,820 rows'],
      ['file.formula-cell', 422, 'formula', { rowNumber: 14 }, 'Row 14 has a formula'],
      [
        'file.unpacked-too-large',
        413,
        'bomb',
        { maxBytes: 52428800 },
        'The file is too large once opened',
      ],
      [
        'columns.missing',
        422,
        'cols',
        { columns: ['category'] },
        'The column Main category is missing',
      ],
      ['file.empty', 422, 'empty', undefined, 'The file has no product rows'],
    ];
    for (const [code, status, name, details, title] of cases) {
      serve(null, (method, path) =>
        method === 'POST' && path === BASE ? fail(status, code, details) : undefined,
      );
      const { container, unmount } = mount();
      await screen.findByText('Drag a CSV or XLSX file here');
      pick(container, new File(['x'], `${name}.csv`, { type: 'text/csv' }));
      expect(await screen.findByText(title)).toBeTruthy();
      expect(screen.getByRole('heading', { name: 'Upload a file' })).toBeTruthy();
      unmount();
    }
  });

  it('sends an XLSX file as base64 under its own name', async () => {
    serve(null, (method, path) => (method === 'POST' && path === BASE ? ok(view()) : undefined));
    const { container } = mount();
    await screen.findByText('Drag a CSV or XLSX file here');
    const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    pick(container, new File(['PK\u0003\u0004'], 'products-oct.xlsx', { type }));
    expect(await screen.findByText('30 rows have errors')).toBeTruthy();
    const post = call.mock.calls.find((entry) => entry[0] === 'POST' && entry[1] === BASE)!;
    expect(post[2]).toEqual({ fileName: 'products-oct.xlsx', data: btoa('PK\u0003\u0004') });
  });

  it('downloads the CSV template and the XLSX template as separate files', async () => {
    serve(null);
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: vi.fn((made: Blob) => {
        blobs.push(made);
        return 'blob:t';
      }),
      revokeObjectURL: vi.fn(),
    });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    try {
      mount();
      await screen.findByText('Drag a CSV or XLSX file here');
      fireEvent.click(await screen.findByRole('button', { name: /CSV template/ }));
      fireEvent.click(screen.getByRole('button', { name: /XLSX template/ }));
      expect(names).toEqual(['products-template.csv', 'products-template.xlsx']);
      expect(blobs[0]!.type).toContain('text/csv');
      expect(blobs[1]!.type).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(new TextDecoder().decode(await blobs[1]!.arrayBuffer())).toBe('PK-template');
    } finally {
      click.mockRestore();
    }
  });

  it('refuses a file over the size limit before sending it', async () => {
    serve(null);
    const { container } = mount();
    await screen.findByText('Drag a CSV or XLSX file here');
    const big = new File(['x'], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    pick(container, big);
    expect(await screen.findByText('The file is larger than 10 MB')).toBeTruthy();
    expect(call.mock.calls.some((entry) => entry[0] === 'POST')).toBe(false);
  });

  it('names a start refusal and keeps the check on screen', async () => {
    serve(view({ errors: 0, errorLines: [] }), (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/start`
        ? fail(409, 'import.already-running')
        : undefined,
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1,198 products' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Import' }),
    );
    expect(
      await screen.findByText('Another import of yours is still running. Wait for it to finish.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import 1,198 products' })).toBeTruthy();
  });

  it('offers a retry when the page cannot be loaded', async () => {
    call.mockImplementation(() => fail(503, 'access.unavailable'));
    mount();
    expect(await screen.findByText('The import page could not be loaded. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('lists the ignored columns and says certification columns are never imported', async () => {
    serve(
      view({
        errors: 0,
        errorLines: [],
        ignoredColumns: [
          { header: 'Halal certified', certification: true },
          { header: 'Notes', certification: false },
        ],
      }),
    );
    mount();
    const banner = (await screen.findByText('Some columns are ignored')).closest(
      'div',
    )!.parentElement!;
    expect(banner.textContent).toContain('Certification columns are never imported');
    expect(banner.textContent).toContain('Halal certified, Notes');
  });
});
