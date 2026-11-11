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
  saveFile: vi.fn(),
}));

import { flashToast, saveFile } from '@mondapac/ui';
import { callApi } from '../../api/client.ts';
import { CategoryImport } from './category-import.tsx';
import { exportTree } from './export-tree.ts';
import type { DryRunBody, RowResult } from './import-model.ts';

const call = vi.mocked(callApi);
const toast = vi.mocked(flashToast);
const save = vi.mocked(saveFile);

const result = (
  n: number,
  action: RowResult['action'],
  issues: RowResult['issues'] = [],
): RowResult => ({
  rowNumber: n,
  slug: `cat-${n}`,
  action,
  code: issues[0]?.code ?? null,
  issues,
});
const dry = (rows: RowResult[], over: Partial<DryRunBody> = {}): DryRunBody => {
  const count = (a: RowResult['action']) => rows.filter((r) => r.action === a).length;
  return {
    fileSha256: 'b'.repeat(64),
    treeVersion: 7,
    format: 'csv',
    counts: {
      create: count('create'),
      update: count('update'),
      unchanged: count('unchanged'),
      error: count('error'),
    },
    clean: count('error') === 0,
    rows,
    ...over,
  };
};
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, body } as never);
const fail = (status: number, code: string, details?: object) =>
  Promise.resolve({
    ok: false,
    failure: { status, code, ...(details ? { details } : {}) },
  } as never);

const page = () =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CategoryImport csrfToken="tok" />
    </NextIntlClientProvider>,
  );
const choose = (name = 'tree.csv') => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['slug,parent_slug\n'], name, { type: 'text/csv' });
  fireEvent.change(input, { target: { files: [file] } });
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  call.mockReset();
  toast.mockReset();
  save.mockReset();
});
afterEach(cleanup);

describe('Import categories page', () => {
  it('checks a file without writing, then shows the counts and the rows', async () => {
    call.mockReturnValueOnce(
      ok(dry([result(2, 'create'), result(3, 'update'), result(4, 'unchanged')])),
    );
    page();
    choose();
    expect(
      await screen.findByText('The file is ready. Applying it writes every row in one step.'),
    ).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/admin/category-tree/import/dry-run',
      { data: expect.any(String) as string },
      'tok',
    );
    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.getByText('To create').nextSibling?.textContent).toBe('1');
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply import' }).disabled).toBe(
      false,
    );
  });

  it('keeps Apply off while a row has an error, filters to the errors and downloads the report', async () => {
    call.mockReturnValueOnce(
      ok(
        dry([
          result(2, 'create'),
          result(3, 'error', [{ path: 'slug', code: 'slug.taken' }]),
          result(4, 'error', [{ path: 'parent_slug', code: 'move.not-supported' }]),
        ]),
      ),
    );
    page();
    choose();
    expect(await screen.findByText(/2 rows have errors/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply import' }).disabled).toBe(
      true,
    );
    expect(screen.getByText(/Use Move on the tree page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Errors only (2)' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Download error report' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]![1]).toMatch(/^category-import-errors-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it('says there is nothing to apply when every row is unchanged', async () => {
    call.mockReturnValueOnce(ok(dry([result(2, 'unchanged')])));
    page();
    choose();
    expect(
      await screen.findByText('Every row is already in the tree. There is nothing to apply.'),
    ).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply import' }).disabled).toBe(
      true,
    );
  });

  it('applies the same file with its hash and the tree version, after a confirmation', async () => {
    call
      .mockReturnValueOnce(ok(dry([result(2, 'create'), result(3, 'update')])))
      .mockReturnValueOnce(
        ok({
          treeVersion: 8,
          counts: { create: 1, update: 1, unchanged: 0, error: 0 },
          written: true,
        }),
      );
    page();
    choose();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    expect(within(dialog).getByText(/Nothing is shown to buyers/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply', hidden: true }));
    expect(await screen.findByText('The import is applied')).toBeTruthy();
    expect(call.mock.calls[1]).toEqual([
      'POST',
      'catalog/admin/category-tree/import/apply',
      {
        data: (call.mock.calls[0]![2] as { data: string }).data,
        fileSha256: 'b'.repeat(64),
        treeVersion: 7,
      },
      'tok',
    ]);
    expect(toast).toHaveBeenCalledWith('success', 'Import applied: 1 created, 1 updated.');
  });

  it('offers a new check when the tree changed under the apply', async () => {
    call
      .mockReturnValueOnce(ok(dry([result(2, 'create')])))
      .mockReturnValueOnce(fail(409, 'conflict.stale'))
      .mockReturnValueOnce(ok(dry([result(2, 'create')], { treeVersion: 9 })));
    page();
    choose();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply import' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apply', hidden: true }));
    expect(await screen.findByText(/The tree changed after the file was checked/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check the file again' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2]![1]).toBe('catalog/admin/category-tree/import/dry-run');
    expect(call.mock.calls[2]![2]).toEqual(call.mock.calls[0]![2]);
  });

  it('words a refused file and a refused heading row, and returns to the upload step', async () => {
    call.mockReturnValueOnce(fail(413, 'file.too-large', { maxBytes: 5_242_880 }));
    page();
    choose();
    expect(await screen.findByText('The file is larger than 5 MB.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Choose a file' })).toBeTruthy();
    cleanup();
    call.mockReset();
    call.mockReturnValueOnce(
      fail(422, 'import.columns-invalid', {
        fields: [{ path: 'columns.slug', code: 'column.missing' }],
      }),
    );
    page();
    choose();
    expect(
      await screen.findByText(
        'The first row of the file is not a valid heading row: slug: a required column is missing.',
      ),
    ).toBeTruthy();
  });

  it('sends a rejected session to sign-in', async () => {
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { assign } });
    call.mockReturnValueOnce(fail(401, 'unauthenticated'));
    page();
    choose();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('exportTree', () => {
  const response = (init: { ok: boolean; status?: number; text?: string }) =>
    ({
      ok: init.ok,
      status: init.status ?? (init.ok ? 200 : 500),
      text: () => Promise.resolve(init.text ?? ''),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(2)),
    }) as unknown as Response;

  it('saves the CSV and the XLSX the API sends', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ok: true, text: 'a,b\r\n' }));
    vi.stubGlobal('fetch', fetcher);
    await exportTree('csv', 'failed');
    expect(fetcher.mock.calls[0]![0]).toBe('/api/catalog/admin/category-tree/export?format=csv');
    expect(save.mock.calls[0]![1]).toMatch(/^category-tree-\d{4}-\d{2}-\d{2}\.csv$/);
    await exportTree('xlsx', 'failed');
    expect(save.mock.calls[1]![1]).toMatch(/\.xlsx$/);
    vi.unstubAllGlobals();
  });

  it('shows a toast, and saves nothing, when the API refuses or cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ ok: false, status: 403 })));
    await exportTree('csv', 'failed');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await exportTree('csv', 'failed');
    expect(toast).toHaveBeenCalledTimes(2);
    expect(save).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
