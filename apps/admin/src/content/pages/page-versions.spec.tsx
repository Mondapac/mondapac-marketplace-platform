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
import { PageVersions } from './page-versions.tsx';
import type { PageDetail } from './page-types.ts';
import { ID, page } from './test-data.ts';

const call = vi.mocked(callApi);
const V1 = '0190a000-0000-7000-8000-0000000000c1';
const V2 = '0190a000-0000-7000-8000-0000000000c2';
const V3 = '0190a000-0000-7000-8000-0000000000c3';
const versions: PageDetail['versions'] = [
  {
    id: V1,
    versionNo: 1,
    state: 'retired',
    createdAt: '2026-10-01T02:00:00Z',
    publishedAt: '2026-10-02T02:00:00Z',
  },
  {
    id: V2,
    versionNo: 2,
    state: 'published',
    createdAt: '2026-11-01T01:00:00Z',
    publishedAt: '2026-11-01T02:00:00Z',
  },
  { id: V3, versionNo: 3, state: 'draft', createdAt: '2026-11-02T02:00:00Z', publishedAt: null },
];

function mount(detail: PageDetail = page({ versions }), canEdit = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PageVersions
        page={detail}
        canEdit={canEdit}
        canPublish={false}
        canArchive={false}
        csrfToken="c1"
        zone="Australia/Brisbane"
      />
    </NextIntlClientProvider>,
  );
}
const refused = (code: string, status = 409) => ({
  ok: false as const,
  failure: { status, code },
});

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the Versions tab', () => {
  it('lists the versions newest first with their state and no author', () => {
    mount();
    const rows = within(screen.getByRole('list', { name: 'Versions of this page' })).getAllByRole(
      'listitem',
    );
    expect(rows.map((row) => row.textContent?.slice(0, 20))).toEqual([
      expect.stringContaining('Version 3Draft'),
      expect.stringContaining('Version 2Live'),
      expect.stringContaining('Version 1Earlier'),
    ]);
  });

  it('offers Restore for the live and earlier versions but not the draft', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Restore version 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Restore version 2' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Restore version 3' })).toBeNull();
  });

  it('offers no Restore without the edit key or on an archived page', () => {
    mount(page({ versions }), false);
    expect(screen.queryByRole('button', { name: /Restore version/ })).toBeNull();
    cleanup();
    mount(page({ versions, status: 'archived' }));
    expect(screen.queryByRole('button', { name: /Restore version/ })).toBeNull();
  });

  it('says so when no version was saved', () => {
    mount(page({ versions: [] }));
    expect(screen.getByText('No version was saved yet.')).toBeTruthy();
  });

  it('asks first, then copies the version into the draft and reads the page again', async () => {
    call.mockResolvedValue({ ok: true as const, status: 200, body: page({ versions }) });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    expect(screen.getByText(/replace the modules in the draft/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore to draft', hidden: true }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `storefront/admin/pages/${ID}/restore`,
      { versionId: V1 },
      'c1',
    );
    await expectToast('Version 1 copied into the draft.', 'success');
  });

  it('words a version that is gone', async () => {
    call.mockResolvedValue(refused('storefront.version-not-found', 404));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore to draft', hidden: true }));
    await screen.findByText('This version no longer exists. Reload the page.');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});
