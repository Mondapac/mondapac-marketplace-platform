// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { expectToast } from '../../../test/toast-spy.ts';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import type { PageDetail } from '../pages/page-types.ts';
import { page, placement } from '../pages/test-data.ts';
import { NavigationEditor } from './navigation-editor.tsx';

const call = vi.mocked(callApi);
const CAT = '0190a000-0000-7000-8000-0000000000d1';
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const refused = (code: string, status = 409, fields?: { path: string; code: string }[]) => ({
  ok: false as const,
  failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
});

const nav = (over: Partial<PageDetail> = {}): PageDetail =>
  page({
    id: null,
    kind: 'system',
    systemKey: 'navigation',
    status: 'published',
    hasDraft: true,
    publishedVersionNo: 1,
    draft: {
      versionNo: 2,
      updatedAt: '2026-11-02T02:00:00Z',
      settings: null,
      placements: {
        rail: [
          placement({
            id: 'r1',
            module: 'nav-link',
            config: { label: 'Offers', target: { kind: 'path', path: '/offers' } },
          }),
          placement({
            id: 'r2',
            module: 'nav-link',
            config: { label: 'Meat', target: { kind: 'category', id: CAT } },
          }),
        ],
        'drawer-popular': [],
        'drawer-categories': [
          placement({ id: 'c1', module: 'nav-category', config: { categoryId: CAT } }),
        ],
      },
    },
    versions: [
      {
        id: 'v1',
        versionNo: 1,
        state: 'published',
        createdAt: '2026-10-01T01:00:00Z',
        publishedAt: '2026-10-02T01:00:00Z',
      },
      {
        id: 'v2',
        versionNo: 2,
        state: 'draft',
        createdAt: '2026-11-02T01:00:00Z',
        publishedAt: null,
      },
    ],
    ...over,
  });

function mount(detail = nav(), canEdit = true, canApprove = false) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NavigationEditor
        page={detail}
        canEdit={canEdit}
        canApprove={canApprove}
        csrfToken="c1"
        zone="Australia/Brisbane"
      />
    </NextIntlClientProvider>,
  );
}
const section = (name: string) => screen.getByRole('region', { name });

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  call.mockImplementation((method, path) => {
    if (method === 'GET' && path === 'catalog/admin/categories') {
      return Promise.resolve(
        ok({
          defaultLocale: 'en-AU',
          categories: [
            { id: CAT, status: 'active', depth: 0, names: [{ locale: 'en-AU', name: 'Meat' }] },
          ],
        }),
      );
    }
    if (method === 'GET') return Promise.resolve(ok({ pages: [] }));
    return Promise.resolve(ok(nav()));
  });
});
afterEach(cleanup);

describe('the navigation editor', () => {
  it('shows the three lists with their count and the locked Browse button', async () => {
    mount();
    expect(within(section('Left menu')).getByText(/2 of 12/)).toBeTruthy();
    expect(
      within(section('Left menu')).getByText(/“Browse products” always comes first/),
    ).toBeTruthy();
    expect(within(section('Browse: popular and suggested')).getByText(/0 of 12/)).toBeTruthy();
    expect(within(section('Browse: shop by category')).getByText(/1 of 30/)).toBeTruthy();
    await waitFor(() => expect(call).toHaveBeenCalledWith('GET', 'catalog/admin/categories'));
  });

  it('is read-only without the edit key: no controls, a note', () => {
    mount(nav(), false);
    expect(screen.getByText(/view the navigation but not change it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Add/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save to draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Restore version/ })).toBeNull();
  });

  it('saves the whole draft in order after a local change', async () => {
    mount();
    fireEvent.change(screen.getAllByLabelText('Label')[0]!, { target: { value: 'Deals' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move Meat up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        'storefront/admin/navigation/draft',
        expect.anything(),
        'c1',
      ),
    );
    const body = call.mock.calls.find(([method]) => method === 'PUT')?.[2] as {
      slots: { rail: { config: { label: string } }[] };
    };
    expect(body.slots.rail.map((entry) => entry.config.label)).toEqual(['Meat', 'Deals']);
    await expectToast('Saved to draft.', 'success');
  });

  it('adds, switches off and removes rows locally', () => {
    mount();
    fireEvent.click(
      within(section('Browse: popular and suggested')).getByRole('button', { name: /^Add/ }),
    );
    expect(within(section('Browse: popular and suggested')).getByText(/1 of 12/)).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Show Offers to buyers' }));
    expect(
      screen.getByRole('switch', { name: 'Show Offers to buyers' }).getAttribute('aria-checked'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Offers' }));
    expect(within(section('Left menu')).getByText(/1 of 12/)).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('refuses an empty label before asking the API', () => {
    mount();
    fireEvent.change(screen.getAllByLabelText('Label')[0]!, { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
    expect(screen.getAllByText('Fill this in.').length).toBeGreaterThan(0);
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('draws the API refusal on the row it names', async () => {
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'PUT'
          ? refused('validation.failed', 400, [
              { path: 'slots.rail[1].config.label', code: 'length' },
            ])
          : ok({ pages: [], categories: [], defaultLocale: 'en-AU' }),
      ),
    );
    mount();
    fireEvent.change(screen.getAllByLabelText('Label')[0]!, { target: { value: 'Changed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
    await screen.findByText('Use at most 40 characters.');
    expect(screen.getByText('Check the marked fields and try again.')).toBeTruthy();
  });

  it('gives Approve only to the holder of the key, and not with unsaved changes', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Waiting for a platform administrator to approve.')).toBeTruthy();
    cleanup();
    mount(nav(), true, true);
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve.matches(':disabled')).toBe(false);
    fireEvent.change(screen.getAllByLabelText('Label')[0]!, { target: { value: 'Edited' } });
    expect(screen.getByRole('button', { name: 'Approve' }).matches(':disabled')).toBe(true);
    expect(screen.getByText('Save the draft first.')).toBeTruthy();
  });

  it('approves the draft version it holds and reads the page again', async () => {
    mount(nav(), true, true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this navigation?', hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve', hidden: true }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'storefront/admin/navigation/approve',
      { versionNo: 2, updatedAt: '2026-11-02T02:00:00Z' },
      'c1',
    );
    await expectToast('Navigation approved.', 'success');
  });

  it('words a draft that changed under the approver and offers the reload', async () => {
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'POST'
          ? refused('storefront.draft-changed')
          : ok({ pages: [], categories: [], defaultLocale: 'en-AU' }),
      ),
    );
    mount(nav(), true, true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve this navigation?', hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve', hidden: true }));
    await screen.findByText(/draft changed after you opened this page/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload the page', hidden: true }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('restores an earlier version after asking', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    expect(screen.getByText(/replaces the current draft/)).toBeTruthy();
    const dialog = screen.getByRole('dialog', { name: 'Restore version 1?', hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore to draft', hidden: true }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'storefront/admin/navigation/restore',
      { versionId: 'v1' },
      'c1',
    );
    expect(screen.queryByRole('button', { name: 'Restore version 2' })).toBeNull();
  });
});
