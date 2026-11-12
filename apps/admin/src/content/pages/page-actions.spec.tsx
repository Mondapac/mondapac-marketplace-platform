// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { expectToast } from '../../../test/toast-spy.ts';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { PageActions, canArchivePage, canPublishPage, redirectProblem } from './page-actions.tsx';
import type { PageDetail } from './page-types.ts';
import { ID, page } from './test-data.ts';

const call = vi.mocked(callApi);
const API = `storefront/admin/pages/${ID}`;

function mount(detail: PageDetail = page(), canPublish = true, canArchive = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PageActions page={detail} canPublish={canPublish} canArchive={canArchive} csrfToken="c1" />
    </NextIntlClientProvider>,
  );
}
const ok = { ok: true as const, status: 200, body: page() };
const refused = (code: string, status = 409, fields?: { path: string; code: string }[]) => ({
  ok: false as const,
  failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
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

const press = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const inDialog = (name: string) => {
  const dialog = screen.getByRole('dialog', { hidden: true });
  const button = Array.from(dialog.querySelectorAll('button')).find(
    (entry) => entry.textContent?.trim() === name,
  );
  if (button === undefined) throw new Error(`no ${name} button`);
  fireEvent.click(button);
};

describe('who sees what', () => {
  it('shows nothing without the publish and archive keys', () => {
    const { container } = mount(page(), false, false);
    expect(container.textContent).toBe('');
  });

  it('shows both to a platform administrator', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('does not offer to archive a system page, an archived page, or publish an archived page', () => {
    expect(canArchivePage(page({ kind: 'system', id: null, systemKey: 'home' }))).toBe(false);
    expect(canArchivePage(page({ status: 'archived' }))).toBe(false);
    expect(canPublishPage(page({ status: 'archived' }))).toBe(false);
    expect(canPublishPage(page({ editLevel: 'locked' }))).toBe(false);
  });

  it('explains a disabled Publish when the page has no draft', () => {
    mount(page({ hasDraft: false }));
    expect(screen.getByRole('button', { name: 'Publish' }).matches(':disabled')).toBe(true);
    expect(screen.getByText('Nothing to publish. Change the draft first.')).toBeTruthy();
  });
});

describe('publish', () => {
  it('asks first, then sends the draft version and time it reviewed and reads the page again', async () => {
    call.mockResolvedValue(ok);
    mount();
    press('Publish');
    expect(screen.getByText('Buyers will see the draft at /l/ramadan.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    inDialog('Publish');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `${API}/publish`,
      { versionNo: 3, updatedAt: '2026-11-02T02:00:00Z' },
      'c1',
    );
    await expectToast('Page published.', 'success');
  });

  it('words a draft that changed since it was reviewed and offers the reload', async () => {
    call.mockResolvedValue(refused('storefront.draft-changed'));
    mount();
    press('Publish');
    inDialog('Publish');
    await screen.findByText(/draft changed after you opened this page/);
    inDialog('Reload the page');
    expect(router.refresh).toHaveBeenCalled();
  });

  it('words a slot that holds too few switched-on modules', async () => {
    call.mockResolvedValue(
      refused('validation.failed', 400, [{ path: 'slots.main', code: 'too-few-modules' }]),
    );
    mount();
    press('Publish');
    inDialog('Publish');
    await screen.findByText(/fewer switched-on modules than it needs/);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('words a refusal of the key', async () => {
    call.mockResolvedValue(refused('auth.forbidden', 403));
    mount();
    press('Publish');
    inDialog('Publish');
    await screen.findByText('You don’t have permission to do this.');
  });
});

describe('archive', () => {
  it('sends an empty body when the address is simply gone', async () => {
    call.mockResolvedValue(ok);
    mount();
    press('Archive');
    inDialog('Archive page');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('POST', `${API}/archive`, {}, 'c1');
    await expectToast('Page archived.', 'success');
  });

  it('sends the redirect, trimmed', async () => {
    call.mockResolvedValue(ok);
    mount();
    press('Archive');
    fireEvent.change(screen.getByLabelText(/Send buyers to/), { target: { value: ' /offers ' } });
    inDialog('Archive page');
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith('POST', `${API}/archive`, { redirectTo: '/offers' }, 'c1');
  });

  it('refuses a redirect that is not a site path before asking the API', () => {
    call.mockResolvedValue(ok);
    mount();
    press('Archive');
    fireEvent.change(screen.getByLabelText(/Send buyers to/), { target: { value: '//evil.test' } });
    inDialog('Archive page');
    expect(screen.getByText(/Use a site path such as \/offers/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('checks a redirect the way the API does', () => {
    for (const bad of ['offers', '//x', '/a/../b', '/a b', `/${'a'.repeat(200)}`]) {
      expect(redirectProblem(bad)).toBe(true);
    }
    for (const good of ['', '/', '/offers', '/l/ramadan-2026', '/a_b.c~d']) {
      expect(redirectProblem(good)).toBe(false);
    }
  });
});
