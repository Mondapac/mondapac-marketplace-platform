// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Dialog } from '../overlay/dialog.tsx';
import { SearchSelect, type SearchSelectOption } from './search-select.tsx';

const grocery: SearchSelectOption = { value: 'g', label: 'Grocery' };
const butcher: SearchSelectOption = { value: 'b', label: 'Butcher' };
const noop = () => {};

beforeEach(() => {
  // jsdom has no modal <dialog> and no matchMedia.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: noop,
    removeEventListener: noop,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const select = (
  <SearchSelect
    multiple
    label="Categories"
    options={[grocery, butcher]}
    value={[]}
    onChange={noop}
    alwaysSearch
  />
);

describe('SearchSelect inside a modal dialog', () => {
  it('opens its list inside the dialog, not behind it on the page body', () => {
    render(
      <Dialog
        open
        title="New activity"
        onClose={noop}
        actions={<button type="button">Save</button>}
      >
        {select}
      </Dialog>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: /categories/i }));
    const list = screen.getByRole('listbox');
    // A modal <dialog> sits in the top layer and makes the rest of the page inert: a list placed
    // on document.body would open but could not be seen or clicked.
    expect(list.closest('dialog')).not.toBeNull();
  });

  it('still opens on the page body when there is no dialog', () => {
    render(select);
    fireEvent.click(screen.getByRole('combobox', { name: /categories/i }));
    const list = screen.getByRole('listbox');
    expect(list.closest('dialog')).toBeNull();
    expect(document.body.contains(list)).toBe(true);
  });

  it('lets a pick inside the dialog be chosen', () => {
    const picked: string[] = [];
    render(
      <Dialog
        open
        title="New activity"
        onClose={noop}
        actions={<button type="button">Save</button>}
      >
        <SearchSelect
          multiple
          label="Categories"
          options={[grocery, butcher]}
          value={[]}
          onChange={(value) => picked.push(...value.map((option) => option.value))}
          alwaysSearch
        />
      </Dialog>,
    );
    fireEvent.click(screen.getByRole('combobox', { name: /categories/i }));
    fireEvent.click(screen.getByRole('option', { name: /grocery/i }));
    expect(picked).toEqual(['g']);
  });
});
