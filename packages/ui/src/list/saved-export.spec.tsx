// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportDialog, saveFile, type ExportDialogLabels } from './export-dialog.tsx';
import { ListViewsBar } from './list-views-bar.tsx';
import {
  ManageFiltersDialog,
  SaveFilterDialog,
  type ManageFiltersLabels,
  type ManagedFilter,
  type SaveFilterLabels,
  type SavedFilterProblem,
} from './saved-filter-dialogs.tsx';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(() => cleanup());

const errors: Record<SavedFilterProblem, string> = {
  'name-taken': 'Name taken',
  'name-empty': 'Name empty',
  limit: 'Limit',
  'shared-limit': 'Shared limit',
  denied: 'Denied',
  'acting-as': 'Acting as',
  'not-found': 'Not found',
  unavailable: 'Unavailable',
};
const fields = {
  name: 'Name',
  who: 'Who can use it',
  me: 'Only me',
  everyone: 'Everyone',
  everyoneHelp: 'Everyone help',
  ownOnly: 'Own only',
  cancel: 'Cancel',
  errors,
};
const saveLabels: SaveFilterLabels = { ...fields, title: 'Save this filter', submit: 'Save' };
const manageLabels: ManageFiltersLabels = {
  ...fields,
  title: 'Manage filters',
  close: 'Close',
  edit: 'Edit',
  editNamed: (name) => `Edit ${name}`,
  delete: 'Delete',
  deleteNamed: (name) => `Delete ${name}`,
  deleteConfirm: 'Delete filter',
  deleteOwn: (name) => `Delete own ${name}`,
  deleteShared: (name) => `Delete shared ${name}`,
  save: 'Save changes',
  sharedByOther: 'Shared by another',
  empty: 'None yet',
  emptyHelp: 'Help',
  helpShare: 'Can share',
  helpOwn: 'Own only help',
};

describe('SaveFilterDialog', () => {
  const mount = (
    onSubmit: (input: {
      name: string;
      visibility: 'me' | 'everyone';
    }) => Promise<SavedFilterProblem | null>,
    canShare = true,
    onClose = vi.fn(),
  ) =>
    render(
      <SaveFilterDialog
        open
        onClose={onClose}
        summary="Live · Search “oil”"
        canShare={canShare}
        labels={saveLabels}
        onSubmit={onSubmit}
      />,
    );

  it('shows the summary and saves the trimmed name with the chosen visibility, then closes', async () => {
    const onSubmit = vi.fn(() => Promise.resolve(null));
    const onClose = vi.fn();
    mount(onSubmit, true, onClose);
    expect(screen.getByText('Live · Search “oil”')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Oils ' } });
    fireEvent.click(screen.getByRole('radio', { name: /Everyone/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Oils', visibility: 'everyone' });
  });

  it('sends me and shows the limit instead of the choice when the role cannot share', async () => {
    const onSubmit = vi.fn(() => Promise.resolve(null));
    mount(onSubmit, false);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Own only')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Oils' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({ name: 'Oils', visibility: 'me' });
  });

  it('asks for a name without calling the page, and says a repeated name under the field', async () => {
    const onSubmit = vi.fn(() => Promise.resolve('name-taken' as SavedFilterProblem));
    mount(onSubmit);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name empty')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Oils' } });
    expect(screen.queryByText('Name empty')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Name taken')).toBeTruthy();
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  });

  it('says any other problem in a banner and stays open', async () => {
    const onClose = vi.fn();
    mount(() => Promise.resolve('acting-as'), true, onClose);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Oils' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Acting as')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ManageFiltersDialog', () => {
  const filters: ManagedFilter[] = [
    { id: 'a', name: 'Mine', visibility: 'me', ownedByMe: true, canManage: true },
    { id: 'b', name: 'Shared', visibility: 'everyone', ownedByMe: true, canManage: true },
    { id: 'c', name: 'Theirs', visibility: 'everyone', ownedByMe: false, canManage: false },
  ];
  const mount = (
    over: Partial<{
      canShare: boolean;
      onUpdate: (
        id: string,
        input: { name: string; visibility: 'me' | 'everyone' },
      ) => Promise<SavedFilterProblem | null>;
      onDelete: (id: string) => Promise<SavedFilterProblem | null>;
      filters: ManagedFilter[];
    }> = {},
  ) =>
    render(
      <ManageFiltersDialog
        open
        onClose={() => undefined}
        filters={over.filters ?? filters}
        canShare={over.canShare ?? true}
        labels={manageLabels}
        onUpdate={over.onUpdate ?? (() => Promise.resolve(null))}
        onDelete={over.onDelete ?? (() => Promise.resolve(null))}
      />,
    );

  it('lists the filters with actions only where the viewer may manage them', () => {
    mount();
    expect(screen.getByText('Can share')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit Mine' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete Shared' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit Theirs' })).toBeNull();
    expect(screen.getByText('Shared by another')).toBeTruthy();
  });

  it('renames and re-shares, and closes the form once the page says it worked', async () => {
    const onUpdate = vi.fn(() => Promise.resolve(null));
    mount({ onUpdate });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Renamed ' } });
    fireEvent.click(screen.getByRole('radio', { name: /Everyone/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull());
    expect(onUpdate).toHaveBeenCalledWith('a', { name: 'Renamed', visibility: 'everyone' });
  });

  it('keeps the form and says the problem when a rename is refused', async () => {
    mount({ onUpdate: () => Promise.resolve('name-taken') });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Name taken')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Name empty')).toBeTruthy();
  });

  it('gives a role that cannot share no choice on a private filter, and the choice to unshare a shared one', () => {
    mount({ canShare: false });
    expect(screen.getByText('Own only help')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Mine' }));
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Shared' }));
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Only me/ }).disabled).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Everyone/ }).checked).toBe(true);
  });

  it('asks once before a delete, with a different sentence for a shared filter', async () => {
    const onDelete = vi.fn(() => Promise.resolve(null));
    mount({ onDelete });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Mine' }));
    expect(screen.getByText('Delete own Mine')).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Shared' }));
    expect(screen.getByText('Delete shared Shared')).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Delete Shared' })).getByRole('button', {
        name: 'Delete filter',
      }),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith('b'));
  });

  it('keeps the question and says the problem when a delete is refused', async () => {
    mount({ onDelete: () => Promise.resolve('denied') });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Mine' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete filter' }));
    expect(await screen.findByText('Denied')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Delete Mine' })).toBeTruthy();
  });

  it('says there is nothing saved yet', () => {
    mount({ filters: [] });
    expect(screen.getByText('None yet')).toBeTruthy();
  });
});

describe('ExportDialog', () => {
  const labels: ExportDialogLabels = {
    title: 'Export 3 products',
    body: 'The file has the columns shown.',
    legend: 'File format',
    csv: 'CSV',
    csvHelp: 'Plain text',
    xlsx: 'XLSX',
    xlsxHelp: 'Workbook',
    confirm: 'Export',
    cancel: 'Cancel',
  };

  it('asks the format, CSV first, and hands the chosen one to the page', () => {
    const onConfirm = vi.fn();
    render(<ExportDialog open onClose={() => undefined} labels={labels} onConfirm={onConfirm} />);
    expect(screen.getByText('The file has the columns shown.')).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^CSV/ }).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onConfirm).toHaveBeenLastCalledWith('csv');
    fireEvent.click(screen.getByRole('radio', { name: /^XLSX/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onConfirm).toHaveBeenLastCalledWith('xlsx');
  });

  it('turns Export off while a download runs, and Cancel closes', () => {
    const onClose = vi.fn();
    render(
      <ExportDialog open busy onClose={onClose} labels={labels} onConfirm={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Export' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('saveFile', () => {
  it('hands the blob to the browser under the given name and frees the address later', () => {
    vi.useFakeTimers();
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      names.push(this.download);
    });
    saveFile(new Blob(['a']), 'products-2026-11-07.csv');
    expect(names).toEqual(['products-2026-11-07.csv']);
    // Not at once: a browser may still be starting the download.
    expect(revoke).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    vi.advanceTimersByTime(4000);
    expect(revoke).toHaveBeenCalledWith('blob:x');
    click.mockRestore();
    vi.useRealTimers();
  });
});

describe('ListViewsBar', () => {
  const items = [
    { id: 'all', label: 'All' },
    { id: 'saved', label: 'Mine' },
  ];

  it('shows the tabs and the Manage link, which acts', () => {
    const onClick = vi.fn();
    render(
      <ListViewsBar
        label="Views"
        items={items}
        activeId="all"
        onSelect={() => undefined}
        manage={{ label: 'Manage filters', onClick }}
      />,
    );
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All',
      'Mine',
      'Manage filters',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Manage filters' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('has no Manage link without one', () => {
    render(
      <ListViewsBar
        label="Views"
        items={items}
        activeId="all"
        onSelect={() => undefined}
        manage={null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });
});
