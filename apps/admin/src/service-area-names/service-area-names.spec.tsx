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
  names: { en: { name: 'Greater Brisbane', configuredName: 'Greater Brisbane', edited: false } },
  ...patch,
});
const data = (areas: readonly AreaRow[] = [row()]): AreaNames => ({
  defaultLanguage: 'en',
  languages: ['en', 'fa', 'ar'],
  areas,
});
const mount = (initial: AreaNames, canEdit = true) =>
  render(wrap(<ServiceAreaNamesPanel initial={initial} canEdit={canEdit} csrfToken="csrf" />));

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

  it('shows no edit button to a viewer', () => {
    mount(data(), false);
    expect(screen.queryByRole('button', { name: /Edit the names/ })).toBeNull();
    expect(screen.getByText(/can see the names but not change/)).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit the names of brisbane' }));
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

  it('refuses an empty required name before calling the API', () => {
    mount(data());
    fireEvent.click(screen.getByRole('button', { name: 'Edit the names of brisbane' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit the names of brisbane' }));
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

  it('says why a refused save failed and keeps the dialog open', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount(data());
    fireEvent.click(screen.getByRole('button', { name: 'Edit the names of brisbane' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Brisbane' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save names' }));
    await waitFor(() =>
      expect(within(dialog).getByText(/cannot change service area/)).toBeTruthy(),
    );
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
