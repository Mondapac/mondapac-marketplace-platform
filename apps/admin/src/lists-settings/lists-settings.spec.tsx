// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { ListsSettingsPanel } from './lists-settings-panel.tsx';
import { expectToast } from '../../test/toast-spy.ts';
import { listPagingOf, type MarketSettingsAnswer } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const answer = (value = 'pages', version = 0): MarketSettingsAnswer => ({
  settings: [{ code: 'list-paging', value, version, updatedAt: null }],
});
const mount = (initial = answer(), canManage = true) =>
  render(wrap(<ListsSettingsPanel initial={initial} canManage={canManage} csrfToken="csrf" />));
const select = () => screen.getByLabelText<HTMLSelectElement>('List paging');
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('listPagingOf', () => {
  it('falls back to page numbers at version 0 when the API names no row', () => {
    expect(listPagingOf({ settings: [] })).toMatchObject({ value: 'pages', version: 0 });
  });
});

describe('ListsSettingsPanel', () => {
  it('shows the value in force and no save bar until something changes', () => {
    mount(answer('prev-next', 3));
    expect(select().value).toBe('prev-next');
    expect(screen.getByText('Version 3')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('is read-only without the manage key', () => {
    mount(answer(), false);
    expect(select().disabled).toBe(true);
    expect(screen.getByText('You can view this setting but not change it.')).toBeTruthy();
  });

  it('saves the chosen value with the version it saw, then adopts the answer', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'list-paging', value: 'prev-next', version: 1, updatedAt: null },
    });
    mount();
    fireEvent.change(select(), { target: { value: 'prev-next' } });
    save();
    await waitFor(() => expect(screen.getByText('Version 1')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'settings/admin/market-settings',
      { code: 'list-paging', value: 'prev-next', expectedVersion: 0 },
      'csrf',
    );
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  describe('where a change is reviewed', () => {
    const reviewed: MarketSettingsAnswer = {
      settings: [
        {
          code: 'list-paging',
          value: 'pages',
          version: 0,
          updatedAt: null,
          review: { reviewed: true, risk: 'low' },
        },
      ],
    };
    const note = (text: string) =>
      fireEvent.change(screen.getByLabelText('Note for reviewers'), { target: { value: text } });

    it('asks for no note when the view does not say reviewed', () => {
      mount();
      expect(screen.queryByLabelText('Note for reviewers')).toBeNull();
    });

    it('needs a note, sends it with the save and says the change was sent for review', async () => {
      mount(reviewed);
      fireEvent.change(select(), { target: { value: 'prev-next' } });
      save();
      expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
      expect(call).not.toHaveBeenCalled();
      note('Faster lists');
      call.mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: {
          code: 'list-paging',
          value: 'prev-next',
          version: 1,
          updatedAt: null,
          review: { reviewed: true, risk: 'low' },
          request: { id: 'r1', number: 9 },
        },
      });
      save();
      await expectToast('Sent for review (SR-9)', 'info');
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'settings/admin/market-settings',
        { code: 'list-paging', value: 'prev-next', expectedVersion: 0, note: 'Faster lists' },
        'csrf',
      );
    });

    it('shows a 400 on note on the note field', async () => {
      mount(reviewed);
      fireEvent.change(select(), { target: { value: 'prev-next' } });
      note('x');
      call.mockResolvedValueOnce({
        ok: false,
        failure: {
          status: 400,
          code: 'validation.failed',
          details: { fields: [{ path: 'note', code: 'required' }] },
        },
      });
      save();
      expect(await screen.findByText(/The note was refused/)).toBeTruthy();
    });
  });

  it('keeps the draft and says so when the API refuses the save', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount();
    fireEvent.change(select(), { target: { value: 'prev-next' } });
    save();
    await waitFor(() =>
      expect(screen.getByText("You don't have permission to change this setting.")).toBeTruthy(),
    );
    expect(select().value).toBe('prev-next');
  });

  it('on a stale version re-reads and compares the draft with what is saved now', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'settings.conflict' } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: answer('prev-next', 2) });
    mount();
    fireEvent.change(select(), { target: { value: 'prev-next' } });
    save();
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls[1]).toEqual(['GET', 'settings/admin/market-settings']);
  });
});
