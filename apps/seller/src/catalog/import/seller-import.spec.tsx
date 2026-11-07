// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('./report-download.ts', () => ({ downloadReport: vi.fn(), saveBlob: vi.fn() }));
vi.mock('../photo-prepare.ts', () => ({ preparePhoto: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { downloadReport } from './report-download.ts';
import { canOfferResume, type ImportTemplate, type ImportView } from './import-types.ts';
import { SellerImport } from './seller-import.tsx';

const call = vi.mocked(callApi);
const report = vi.mocked(downloadReport);
const ID = '0190a000-0000-7000-8000-000000000001';
const BASE = 'catalog/seller/imports';

const template: ImportTemplate = {
  modes: [
    {
      mode: 'my-products',
      columns: [
        { key: 'sku', header: 'Seller SKU', required: true },
        { key: 'title', header: 'Title', required: true },
        { key: 'images', header: 'Images', required: false },
      ],
      filename: 'my-products-template.csv',
      csv: 'Seller SKU,Title\n',
      xlsxFilename: 'my-products-template.xlsx',
      xlsx: btoa('PK-mine'),
    },
    {
      mode: 'sell-from-catalogue',
      columns: [
        { key: 'sku', header: 'Seller SKU', required: true },
        { key: 'productCode', header: 'Product code', required: true },
      ],
      filename: 'sell-from-catalogue-template.csv',
      csv: 'Seller SKU,Product code\n',
      xlsxFilename: 'sell-from-catalogue-template.xlsx',
      xlsx: btoa('PK-catalogue'),
    },
  ],
  typesOffered: ['grocery'],
  limits: { rows: 5000, fileBytes: 10 * 1024 * 1024 },
};

const view = (over: Partial<ImportView> = {}): ImportView => ({
  id: ID,
  mode: 'my-products',
  state: 'checked',
  fileLabel: 'products-nov.csv',
  fileBytes: 2_400_000,
  format: 'csv',
  rows: 120,
  ready: 100,
  errors: 20,
  warnings: 3,
  groups: 90,
  ignoredColumns: [
    { header: 'Price', mark: 'elsewhere' },
    { header: 'Halal certificate', mark: 'certification' },
  ],
  skipErrors: null,
  toImport: null,
  created: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
  stopReason: null,
  canResume: false,
  photoStepOpen: false,
  checkedAt: '2026-11-07T10:24:00.000Z',
  startedAt: null,
  finishedAt: null,
  durationSeconds: null,
  errorLines: [
    { rowNumber: 12, column: 'category', code: 'category.unknown', value: 'Fresh', otherRow: null },
    { rowNumber: 47, column: 'title', code: 'required', value: '', otherRow: null },
    {
      rowNumber: 88,
      column: 'option[colour]',
      code: 'import.option-unknown',
      value: 'Rd',
      otherRow: null,
    },
    { rowNumber: 90, column: 'sku', code: 'import.duplicate-row', value: 'A-1', otherRow: 89 },
    { rowNumber: 91, column: 'row', code: 'some.new-code', value: '', otherRow: null },
  ],
  failureLines: [],
  preview: [
    { rowNumber: 2, sku: 'A-1', title: 'Dates', productCode: '', typeCode: 'grocery', options: '' },
  ],
  ...over,
});

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, body } as never);
const fail = (status: number, code: string, details?: object) =>
  Promise.resolve({
    ok: false,
    failure: { status, code, ...(details ? { details } : {}) },
  } as never);

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

const assign = vi.fn();
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellerImport csrfToken="csrf-1" minPhotoIntervalMs={0} />
    </NextIntlClientProvider>,
  );

function pick(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]')!;
  const files = { 0: file, length: 1, item: (index: number) => (index === 0 ? file : null) };
  fireEvent.change(input, { target: { files } });
}

describe('seller import page', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('opens on the upload step with the mode choice, the limits and the template columns', async () => {
    serve(null);
    mount();
    expect(await screen.findByText('Upload a file')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /My products/ })).toHaveProperty('checked', true);
    expect(screen.getByText('Up to 5,000 rows and 10 MB')).toBeTruthy();
    expect(screen.getByRole('button', { name: /CSV template/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /XLSX template/ })).toBeTruthy();
    expect(screen.getByText('Title')).toBeTruthy();
    expect(
      screen.getByText(/Price, cost, stock and certification columns are not imported/),
    ).toBeTruthy();
    // The second mode shows its own columns.
    fireEvent.click(screen.getByRole('radio', { name: /Sell from the catalogue/ }));
    expect(screen.getByText('Product code')).toBeTruthy();
    expect(screen.queryByText('Images')).toBeNull();
  });

  it('downloads the template of the chosen mode as CSV and as XLSX', async () => {
    serve(null);
    const urls: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      urls.push(blob as Blob);
      return 'blob:x';
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    mount();
    await screen.findByText('Upload a file');
    fireEvent.click(screen.getByRole('radio', { name: /Sell from the catalogue/ }));
    fireEvent.click(screen.getByRole('button', { name: /CSV template/ }));
    fireEvent.click(screen.getByRole('button', { name: /XLSX template/ }));
    expect(click).toHaveBeenCalledTimes(2);
    expect(urls[0]?.type).toContain('text/csv');
    expect(await urls[0]?.text()).toBe('Seller SKU,Product code\n');
    expect(urls[1]?.type).toContain('spreadsheetml');
    click.mockRestore();
  });

  it('uploads the file with its mode and shows the counts, the problems and the ignored columns', async () => {
    serve(null, (method, path) => (method === 'POST' && path === BASE ? ok(view()) : undefined));
    const { container } = mount();
    await screen.findByText('Upload a file');
    pick(container, new File(['Seller SKU,Title\n'], 'products-nov.csv', { type: 'text/csv' }));
    expect(await screen.findByText('20 rows have errors')).toBeTruthy();
    const post = call.mock.calls.find(([method, path]) => method === 'POST' && path === BASE);
    expect(post?.[2]).toEqual({
      mode: 'my-products',
      fileName: 'products-nov.csv',
      data: btoa('Seller SKU,Title\n'),
    });
    expect(post?.[3]).toBe('csrf-1');
    const tiles = screen.getAllByRole('listitem').map((item) => item.textContent);
    expect(tiles.some((text) => text?.includes('Rows in the file') && text.includes('120'))).toBe(
      true,
    );
    // Each error has its row number and plain words.
    const table = screen.getByRole('table', { name: 'Rows with errors' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getByText('12')).toBeTruthy();
    expect(rows[0]?.textContent).toContain('No category with this name');
    expect(rows[1]?.textContent).toContain('Title is required');
    expect(rows[2]?.textContent).toContain('Option (colour)');
    expect(rows[3]?.textContent).toContain('Same SKU as row 89');
    expect(rows[4]?.textContent).toContain('is not valid');
    expect(screen.getByText('Showing 5 of 20 errors. The report has all of them.')).toBeTruthy();
    // Ignored columns, with the "set in Prices and Stock" mark.
    expect(screen.getByText('Some columns are not read')).toBeTruthy();
    expect(screen.getByText('Price').parentElement?.textContent).toContain(
      'Set in Prices and Stock',
    );
    expect(screen.getByText('Halal certificate').parentElement?.textContent).toContain(
      'Certification is never imported',
    );
  });

  it('keeps Import off until the rows with errors are skipped, then starts with skipErrors', async () => {
    const running = view({ state: 'queued', skipErrors: true, toImport: 100 });
    serve(view(), (method, path, body) => {
      if (method === 'POST' && path === `${BASE}/${ID}/start`) {
        expect(body).toEqual({ skipErrors: true });
        return ok(running);
      }
      return undefined;
    });
    mount();
    const importButton = await screen.findByRole('button', { name: 'Import 100 rows' });
    expect(importButton).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Skip the 20 rows with errors/ }));
    expect(importButton).toHaveProperty('disabled', false);
    fireEvent.click(importButton);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('The 20 rows with errors are skipped');
    expect(dialog.textContent).toContain('Nothing is submitted or published');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Importing')).toBeTruthy();
  });

  it('shows a clean file with its preview and imports without a skip choice', async () => {
    serve(view({ errors: 0, ready: 120, errorLines: [], ignoredColumns: [] }));
    mount();
    expect(await screen.findByText('All 120 rows are ready to import')).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('table', { name: 'The first rows of the file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Import 120 rows' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('downloads the error report from the check', async () => {
    serve(view());
    report.mockResolvedValue({ ok: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Download error report (CSV)' }));
    expect(report).toHaveBeenCalledWith(ID, 'errors');
  });

  it('words a failed report download', async () => {
    serve(view());
    report.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'import.report-unavailable' },
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Download error report (CSV)' }));
    expect(await screen.findByText('The report is not ready yet.')).toBeTruthy();
  });

  it('cancels a check by discarding it and returns to the products', async () => {
    serve(view(), (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/discard` ? ok({ discarded: true }) : undefined,
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/products'));
    expect(call).toHaveBeenCalledWith('POST', `${BASE}/${ID}/discard`, {}, 'csrf-1');
  });

  it.each([
    ['file.unsupported-type', 'This file type can’t be imported', undefined],
    ['file.too-large', 'The file is larger than 10 MB', undefined],
    ['file.unpacked-too-large', 'The file is too large once opened', undefined],
    ['file.too-complex', 'The file is too complex to read', undefined],
    ['file.busy', 'Another file is being checked', undefined],
    ['file.formula-cell', 'Row 7 has a formula', { rowNumber: 7 }],
    ['file.too-many-rows', 'The file has 6,000 rows', { rows: 6000, max: 5000 }],
    ['file.too-many-columns', 'The file has too many columns', undefined],
    ['file.cell-too-long', 'A cell has too much text', undefined],
    ['file.empty', 'The file has no product rows', undefined],
    ['file.no-rows', 'The file has no product rows', undefined],
    ['file.unreadable', 'The file can’t be read', undefined],
    ['columns.missing', 'The column sku is missing', { columns: ['sku'] }],
    ['columns.duplicate', 'The column title appears twice', { columns: ['title'] }],
    ['setting.product-creation-off', 'Importing your own products is switched off', undefined],
    ['setting.sell-from-catalogue-off', 'Selling from the catalogue is switched off', undefined],
    ['request.throttled', 'Too many files checked', { retryAfterSeconds: 600 }],
    ['seller.not-eligible', 'Your store can’t import right now', undefined],
    ['access.acting-as-refused', 'Imports are not available here', undefined],
    ['access.denied', 'You don’t have access to import products', undefined],
    ['request.csrf', 'Your session expired', undefined],
    ['access.unavailable', 'The file could not be checked', undefined],
  ])('words the upload refusal %s', async (code, title, details) => {
    serve(null, (method, path) =>
      method === 'POST' && path === BASE ? fail(422, code, details) : undefined,
    );
    const { container } = mount();
    await screen.findByText('Upload a file');
    pick(container, new File(['x'], 'a.csv'));
    expect(await screen.findByText(title)).toBeTruthy();
    expect(screen.getByText('Upload a file')).toBeTruthy();
  });

  it('refuses a file over the size limit before sending it', async () => {
    serve(null);
    const { container } = mount();
    await screen.findByText('Upload a file');
    const big = new File(['x'], 'big.csv');
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    pick(container, big);
    expect(await screen.findByText('The file is larger than 10 MB')).toBeTruthy();
    expect(call.mock.calls.some(([method, path]) => method === 'POST' && path === BASE)).toBe(
      false,
    );
  });

  it('shows progress while the import runs, polls the job and ends on the finished state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = view({
      state: 'running',
      skipErrors: true,
      toImport: 100,
      created: 20,
      failed: 5,
    });
    let current = running;
    serve(running, (method, path) =>
      method === 'GET' && path === `${BASE}/${ID}` ? ok(current) : undefined,
    );
    mount();
    expect(await screen.findByText('25 of 100 rows done')).toBeTruthy();
    const meter = screen.getByRole('progressbar', { name: 'Import progress' });
    expect(meter.getAttribute('aria-valuenow')).toBe('25');
    current = view({
      state: 'finished',
      toImport: 100,
      created: 80,
      updated: 10,
      unchanged: 5,
      failed: 5,
      durationSeconds: 75,
      failureLines: [{ rowNumber: 9, sku: 'B-2', code: 'claim-text.found' }],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText('Import finished: 95 rows done')).toBeTruthy();
    expect(screen.getByText('Time taken: 1 min 15 s')).toBeTruthy();
    expect(screen.getByText('B-2')).toBeTruthy();
    expect(screen.getByText(/mentions a certification/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry the rest' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download full report (CSV)' }));
    expect(report).toHaveBeenCalledWith(ID, 'full');
  });

  it('offers to resume a job that stopped for a limit, and resumes it', async () => {
    const stopped = view({
      state: 'stopped',
      toImport: 100,
      created: 40,
      stopReason: 'rate-limited',
      canResume: true,
    });
    serve(stopped, (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/resume`
        ? ok({ ...stopped, state: 'queued' })
        : undefined,
    );
    mount();
    expect(await screen.findByText('The import stopped after 40 rows')).toBeTruthy();
    expect(screen.getByText('Hourly limit reached')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry the rest' }));
    expect(await screen.findByText('Importing')).toBeTruthy();
    expect(call).toHaveBeenCalledWith('POST', `${BASE}/${ID}/resume`, {}, 'csrf-1');
  });

  it.each(['access-lost', 'seller-not-eligible'] as const)(
    'hides resume when the job stopped with %s and offers a new import',
    async (stopReason) => {
      serve(view({ state: 'stopped', toImport: 100, created: 40, stopReason, canResume: true }));
      mount();
      expect(await screen.findByText('The import stopped after 40 rows')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Retry the rest' })).toBeNull();
      expect(screen.getByText(/Start a new import with the rows that are missing/)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Import another file' }));
      expect(await screen.findByText('Upload a file')).toBeTruthy();
    },
  );

  it('offers no resume when the file is no longer stored', async () => {
    serve(view({ state: 'stopped', toImport: 100, stopReason: 'file-missing', canResume: false }));
    mount();
    expect(await screen.findByText('File no longer stored')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry the rest' })).toBeNull();
  });

  it('words a resume the API refuses for lost access, and reads the server state again', async () => {
    const stopped = view({
      state: 'stopped',
      toImport: 100,
      stopReason: 'rate-limited',
      canResume: true,
    });
    let refused = false;
    serve(stopped, (method, path) => {
      if (method === 'POST' && path === `${BASE}/${ID}/resume`) {
        refused = true;
        return fail(409, 'import.access-lost');
      }
      return undefined;
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry the rest' }));
    expect(await screen.findByText(/no longer have the right to import/)).toBeTruthy();
    expect(refused).toBe(true);
  });

  it.each([
    ['import.errors-not-skipped', /Tick “Skip the rows with errors”/],
    ['import.already-running', /Another import of yours is still running/],
    ['import.not-confirmable', /can no longer be started/],
    ['import.nothing-to-import', /nothing to import/],
    ['import.daily-rows-reached', /daily limit of rows/],
    ['request.throttled', /Too many imports for now/],
    ['seller.not-eligible', /can’t import right now/],
    ['access.denied', /don’t have access to do this/],
    ['access.unavailable', /That didn’t work/],
  ])('words the refused start %s', async (code, text) => {
    serve(view({ errors: 0, ready: 120, errorLines: [] }), (method, path) =>
      method === 'POST' && path === `${BASE}/${ID}/start` ? fail(409, code) : undefined,
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Import 120 rows' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('opens a finished my-products import while its photo step is open, and not after', async () => {
    const finished = view({ state: 'finished', toImport: 100, created: 100, photoStepOpen: true });
    serve(finished);
    mount();
    expect(await screen.findByText('Add your photos')).toBeTruthy();
    expect(screen.getByLabelText('Choose photos')).toBeTruthy();
    expect(screen.getByLabelText('Choose a folder')).toBeTruthy();
    cleanup();
    serve({ ...finished, photoStepOpen: false });
    mount();
    expect(await screen.findByText('Upload a file')).toBeTruthy();
    expect(screen.queryByText('Add your photos')).toBeNull();
  });

  it('shows no photo step for a sell-from-catalogue import', async () => {
    serve(
      view({
        mode: 'sell-from-catalogue',
        state: 'stopped',
        stopReason: 'unexpected',
        canResume: true,
      }),
    );
    mount();
    expect(await screen.findByText(/The import stopped/)).toBeTruthy();
    expect(screen.queryByText('Add your photos')).toBeNull();
  });

  it('shows a retry when the page cannot be loaded', async () => {
    call.mockImplementation(() => fail(503, 'access.unavailable'));
    mount();
    expect(await screen.findByText('The import page could not be loaded. Try again.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('labels the steps and the progress for assistive technology', async () => {
    serve(view({ errors: 0, ready: 120, errorLines: [] }));
    mount();
    const steps = await screen.findByRole('list', { name: 'Import steps' });
    expect(within(steps).getByText('Check file').closest('li')?.getAttribute('aria-current')).toBe(
      'step',
    );
  });
});

describe('resume rule', () => {
  it('needs a stopped job the API lets resume, and never after a lost access', () => {
    const base = { state: 'stopped', canResume: true, stopReason: 'rate-limited' } as const;
    expect(canOfferResume(base)).toBe(true);
    expect(canOfferResume({ ...base, canResume: false })).toBe(false);
    expect(canOfferResume({ ...base, stopReason: 'access-lost' })).toBe(false);
    expect(canOfferResume({ ...base, stopReason: 'seller-not-eligible' })).toBe(false);
    expect(canOfferResume({ ...base, state: 'finished' })).toBe(false);
    expect(canOfferResume({ ...base, stopReason: 'unexpected' })).toBe(true);
  });
});
