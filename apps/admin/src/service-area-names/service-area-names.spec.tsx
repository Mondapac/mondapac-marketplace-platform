// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { areaProblemOf, languageLabel } from './errors.ts';
import { ServiceAreaNamesPanel } from './service-area-names-panel.tsx';
import type { AreaNames, AreaRow } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const row = (patch: Partial<AreaRow> = {}): AreaRow => ({
  code: 'brisbane',
  region: 'QLD',
  sellerOnboardingEnabled: true,
  deliveryEnabled: true,
  actions: ['edit-names'],
  names: { en: { name: 'Greater Brisbane', configuredName: 'Greater Brisbane', edited: false } },
  ...patch,
});
const data = (areas: readonly AreaRow[] = [row()]): AreaNames => ({
  defaultLanguage: 'en',
  languages: ['en', 'fa', 'ar'],
  areas,
});
const mount = (initial: AreaNames) =>
  render(wrap(<ServiceAreaNamesPanel initial={initial} csrfToken="csrf" />));
const openEditor = () => {
  fireEvent.click(screen.getByRole('button', { name: /^Actions for / }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Edit names…' }));
};

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('ServiceAreaNamesPanel', () => {
  it('lists every area with its names and marks edited ones', () => {
    mount(
      data([
        row({
          names: {
            en: { name: 'Brisbane City', configuredName: 'Greater Brisbane', edited: true },
            fa: { name: 'بریزبین', configuredName: null, edited: true },
          },
        }),
      ]),
    );
    expect(screen.getAllByText('Brisbane City').length).toBeGreaterThan(0);
    expect(screen.getByText('بریزبین')).toBeTruthy();
    expect(screen.getAllByText('Edited')).toHaveLength(2);
    expect(screen.getByText('brisbane · QLD')).toBeTruthy();
  });

  it('offers Edit names… in the Actions menu only, never as an in-row button', () => {
    mount(data());
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Greater Brisbane' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Edit names…',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit names…' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says so when the Market has no service areas', () => {
    mount(data([]));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/The names buyers and sellers see/)).toBeTruthy();
    expect(screen.queryByText(/can see the names but not change/)).toBeNull();
    expect(screen.getByText('No service areas are configured for this Market.')).toBeTruthy();
  });

  it('shows no menu to a viewer and says the names are read-only', () => {
    mount(data([row({ actions: [] })]));
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
    expect(screen.getByText(/can see the names but not change/)).toBeTruthy();
  });

  it('drops the Actions column when no row has a known action, and keeps it otherwise', () => {
    const { unmount } = mount(data([row({ actions: [] })]));
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    unmount();
    mount(data());
    expect(screen.getByRole('columnheader', { name: 'Actions' })).toBeTruthy();
  });

  it('lays each area out as a stacked card below sm with the menu trigger at the top end', () => {
    mount(data());
    expect(screen.getByRole('table').className).toContain('max-sm:block');
    const tr = screen.getAllByRole('row')[1]!;
    expect(tr.className).toContain('max-sm:relative');
    const trigger = screen.getByRole('button', { name: /^Actions for / });
    expect(trigger.closest('td')!.className).toMatch(/max-sm:absolute.*max-sm:end-2.*max-sm:top-2/);
  });

  it('ignores unknown action ids: a row with none known shows no menu', () => {
    mount(data([row({ actions: ['delete-area', 'rename'] })]));
    expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull();
  });

  it('works for another Market with other languages and a menu per row that offers edit', () => {
    const other: AreaNames = {
      defaultLanguage: 'ms',
      languages: ['ms', 'en'],
      areas: [
        row({
          code: 'kl',
          region: 'WP',
          names: {
            ms: { name: 'Kuala Lumpur', configuredName: 'Kuala Lumpur', edited: false },
            en: { name: 'KL', configuredName: null, edited: true },
          },
        }),
        row({
          code: 'penang',
          region: null,
          actions: [],
          names: { ms: { name: 'Pulau Pinang', configuredName: 'Pulau Pinang', edited: false } },
        }),
      ],
    };
    mount(other);
    expect(screen.getAllByText('Malay:')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Actions for/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Actions for Kuala Lumpur' })).toBeTruthy();
    expect(screen.getByText('penang')).toBeTruthy();
  });

  it('saves a name in another language and shows it without a reload', async () => {
    const saved = row({
      names: {
        en: { name: 'Greater Brisbane', configuredName: 'Greater Brisbane', edited: false },
        fa: { name: 'بریزبین', configuredName: null, edited: true },
      },
    });
    call.mockResolvedValue({ ok: true, status: 200, body: { area: saved, changed: 1 } });
    mount(data());
    openEditor();
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Language'), { target: { value: 'fa' } });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: ' بریزبین ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save names' }));
    await waitFor(() => expect(screen.getByText('بریزبین')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'sellers/admin/service-areas/names',
      { areaCode: 'brisbane', names: { fa: 'بریزبین' } },
      'csrf',
    );
  });

  it('asks before Cancel throws away a typed name, and closes at once when nothing changed', () => {
    mount(data());
    openEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /Names of/ })).toBeNull();

    openEditor();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Somewhere' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('dialog', { name: 'Discard your input?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('refuses an empty required name before calling the API', () => {
    mount(data());
    openEditor();
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save names' }));
    expect(within(dialog).getByText(/Enter a name, or restore/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('restores the configured name by sending null', async () => {
    const edited = row({
      names: { en: { name: 'Brisbane City', configuredName: 'Greater Brisbane', edited: true } },
    });
    call.mockResolvedValue({ ok: true, status: 200, body: { area: row(), changed: 1 } });
    mount(data([edited]));
    openEditor();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore configured name' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save names' }));
    await waitFor(() => expect(screen.queryByText('Edited')).toBeNull());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'sellers/admin/service-areas/names',
      { areaCode: 'brisbane', names: { en: null } },
      'csrf',
    );
  });

  it('says why a refused save failed, keeps the dialog open and reads the list again', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 403, code: 'access.denied' } });
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: data([row({ actions: [] })]),
    });
    mount(data());
    openEditor();
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Brisbane' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save names' }));
    await waitFor(() =>
      expect(within(dialog).getByText(/cannot change service area/)).toBeTruthy(),
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'sellers/admin/service-areas'));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Actions for/ })).toBeNull());
  });
  it('a 409 refusal keeps the dialog with its error and reads the list again', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict' } });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: data([row()]) });
    mount(data());
    openEditor();
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Brisbane' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save names' }));
    await waitFor(() =>
      expect(within(dialog).getByText('Something went wrong. Try again.')).toBeTruthy(),
    );
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'sellers/admin/service-areas'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps the shown rows when the re-read after a refusal fails', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict' } });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: 'network' } });
    mount(data());
    openEditor();
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Brisbane' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save names' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'sellers/admin/service-areas'));
    expect(screen.getByText('brisbane · QLD')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Actions for / })).toBeTruthy();
  });
});

describe('helpers', () => {
  it('maps failures to message keys', () => {
    expect(areaProblemOf({ status: 400, code: 'validation.failed' })).toBe('invalid');
    expect(areaProblemOf({ status: 404, code: 'service-area.not-found' })).toBe('not-found');
    expect(areaProblemOf({ status: 403, code: 'whatever' })).toBe('denied');
    expect(areaProblemOf({ status: 0, code: 'network' })).toBe('unavailable');
    expect(areaProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });

  it('words a language in English, and falls back to the tag', () => {
    expect(languageLabel('fa')).toBe('Persian');
    expect(languageLabel('???')).toBe('???');
  });
});
