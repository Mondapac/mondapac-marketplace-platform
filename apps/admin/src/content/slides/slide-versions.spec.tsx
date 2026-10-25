// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { ID, detail, version } from './test-data.ts';
import { SlideVersions } from './slide-versions.tsx';
import type { SlideDetail } from './slide-types.ts';

const call = vi.mocked(callApi);
const V4 = '0190a000-0000-7000-8000-0000000000b4';
const V3 = '0190a000-0000-7000-8000-0000000000b3';
const V2 = '0190a000-0000-7000-8000-0000000000b2';
const V1 = '0190a000-0000-7000-8000-0000000000b1';

const withVersions = (patch: Partial<SlideDetail> = {}): SlideDetail =>
  detail({
    draft: version({ id: V3, versionNo: 3 }),
    live: version({ id: V2, versionNo: 2, approvedAt: '2026-10-24T01:00:00Z' }),
    versions: [
      { id: V3, versionNo: 3, createdAt: '2026-10-25T00:00:00Z', approvedAt: null },
      {
        id: V2,
        versionNo: 2,
        createdAt: '2026-10-24T00:00:00Z',
        approvedAt: '2026-10-24T01:00:00Z',
      },
      {
        id: V1,
        versionNo: 1,
        createdAt: '2026-10-23T00:00:00Z',
        approvedAt: '2026-10-23T02:00:00Z',
      },
    ],
    ...patch,
  });

interface Keys {
  readonly canEdit?: boolean;
  readonly canPause?: boolean;
  readonly canPublish?: boolean;
}
function mount(slide: SlideDetail, keys: Keys = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SlideVersions
        slide={slide}
        canEdit={keys.canEdit ?? false}
        canPause={keys.canPause ?? false}
        canPublish={keys.canPublish ?? false}
        csrfToken="csrf-1"
        zone="Australia/Brisbane"
      />
    </NextIntlClientProvider>,
  );
}
const rowOf = (versionNo: number) =>
  screen.getByRole('rowheader', { name: `Version ${versionNo}` }).closest('tr')!;
const restoreButtons = () => screen.queryAllByRole('button', { name: /^Restore/ });

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no modal <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('versions tab', () => {
  it('is a tab of the slide, after Where and when, and the current one', () => {
    mount(withVersions());
    const tabs = within(screen.getByRole('navigation', { name: 'Slide sections' })).getAllByRole(
      'link',
    );
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Content', 'Where and when', 'Versions']);
    expect(tabs[2]?.getAttribute('aria-current')).toBe('page');
    expect(tabs[2]?.getAttribute('href')).toBe(`/content/slides/${ID}/versions`);
  });

  it('lists the versions newest first with number, when saved and state', () => {
    mount(withVersions());
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Version',
      'Saved',
      'State',
      'Action',
    ]);
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      'Version 3',
      'Version 2',
      'Version 1',
    ]);
    expect(within(rowOf(3)).getByText('Draft')).toBeTruthy();
    expect(within(rowOf(2)).getByText('Live')).toBeTruthy();
    expect(within(rowOf(1)).getByText('Earlier')).toBeTruthy();
    expect(within(rowOf(3)).getByText(/25 Oct/)).toBeTruthy();
    expect(within(rowOf(2)).getByText(/Approved/)).toBeTruthy();
    expect(within(rowOf(3)).queryByText(/Approved/)).toBeNull();
    // The API lists no author, so there is no column for one.
    expect(screen.queryByRole('columnheader', { name: /who|by/i })).toBeNull();
    expect(document.querySelectorAll('colgroup col')).toHaveLength(4);
  });

  it('tells a draft that is waiting from one that is not', () => {
    mount(withVersions({ pending: true, status: 'pending' }));
    expect(within(rowOf(3)).getByText('Draft · waiting')).toBeTruthy();
  });

  it('says how many are listed, and when the API listed only its newest', () => {
    mount(withVersions());
    expect(screen.getByText(/3 versions, newest first/)).toBeTruthy();
    expect(screen.queryByText(/Only the latest/)).toBeNull();
    cleanup();
    const many = Array.from({ length: 50 }, (_, index) => ({
      id: `0190a000-0000-7000-8000-00000000${String(1000 + index)}`,
      versionNo: 50 - index,
      createdAt: '2026-10-23T00:00:00Z',
      approvedAt: null,
    }));
    mount(withVersions({ versions: many, draft: null, live: null }));
    expect(screen.getByText('Only the latest 50 versions are listed.')).toBeTruthy();
  });

  it('says so when there is nothing to list', () => {
    mount(withVersions({ versions: [] }));
    expect(screen.getByText('No versions are saved for this slide.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Restore (storefront.slide.edit)', () => {
  it('is absent without the edit key, with a read-only note and no dialog', () => {
    mount(withVersions(), { canPublish: true });
    expect(restoreButtons()).toHaveLength(0);
    expect(
      screen.getByText('You can view the versions of this slide but not restore one.'),
    ).toBeTruthy();
    expect(document.querySelectorAll('dialog')).toHaveLength(0);
  });

  it('is on the live and earlier versions with the key, not on the draft it would copy into', () => {
    mount(withVersions(), { canEdit: true });
    expect(
      restoreButtons().map((button) => button.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Restore version 2', 'Restore version 1']);
    expect(within(rowOf(3)).queryByRole('button')).toBeNull();
    expect(screen.queryByText(/but not restore one/)).toBeNull();
  });

  it('is absent on an archived slide, for everyone', () => {
    mount(withVersions({ status: 'archived', draft: null }), { canEdit: true, canPublish: true });
    expect(restoreButtons()).toHaveLength(0);
    expect(
      screen.getByText('This slide is archived. Its versions cannot be restored.'),
    ).toBeTruthy();
  });

  it('asks first, then copies the version into the draft and says which version it became', async () => {
    const restored = withVersions({
      draft: version({ id: V4, versionNo: 4 }),
      versions: [
        { id: V4, versionNo: 4, createdAt: '2026-10-25T05:00:00Z', approvedAt: null },
        ...withVersions().versions,
      ],
    });
    call.mockResolvedValue({ ok: true, status: 200, body: restored });
    mount(withVersions(), { canEdit: true });
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: /Restore/ }));
    const dialog = screen.getByRole('dialog', { name: 'Restore version 1?' });
    expect(within(dialog).getByText(/copied into the draft as a new version/)).toBeTruthy();
    expect(within(dialog).getByText(/Buyers keep seeing the live version/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore to draft' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `storefront/admin/slides/${ID}/restore`,
        { versionId: V1 },
        'csrf-1',
      ),
    );
    expect(
      await screen.findByText(/Version 1 was copied into the draft as version 4/),
    ).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Version 4' })).toBeTruthy();
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
  });

  it('does nothing on Cancel or Escape', () => {
    mount(withVersions(), { canEdit: true });
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: /Restore/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
    fireEvent.click(within(rowOf(2)).getByRole('button', { name: /Restore/ }));
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    ['storefront.slide-version-limit', 409, /limit of saved versions/],
    ['storefront.slide-version-not-found', 404, /version no longer exists/],
    ['storefront.slide-archived', 409, /archived/],
    ['access.denied', 403, /don’t have permission/],
  ])('says what a %s refusal means and keeps the list', async (code, status, text) => {
    call.mockResolvedValue({ ok: false, failure: { status, code } });
    mount(withVersions(), { canEdit: true });
    fireEvent.click(within(rowOf(1)).getByRole('button', { name: /Restore/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore to draft' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
    expect(screen.getAllByRole('row')).toHaveLength(4);
  });
});

describe('commands from the Versions tab header', () => {
  it('offers Send for approval and the More menu by the same keys as the other tabs', () => {
    mount(withVersions(), { canEdit: true });
    expect(screen.getByRole('button', { name: 'Send for approval' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeTruthy();
    cleanup();
    mount(withVersions(), {});
    expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});
