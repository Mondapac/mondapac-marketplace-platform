// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { expectFlash } from '../../../test/toast-spy.ts';
import { NewPageFormView } from './new-page-form.tsx';

const call = vi.mocked(callApi);
const CAT = '0190a000-0000-7000-8000-0000000000c1';

const catalogue = {
  templates: [
    { key: 'campaign-landing', scope: 'dynamic', linkable: ['category', 'seller', 'product'] },
    { key: 'brand-page', scope: 'dynamic', linkable: ['seller', 'category'] },
    { key: 'product-spotlight', scope: 'dynamic', linkable: ['product'] },
    { key: 'info-page', scope: 'dynamic', linkable: [] },
  ],
};
const tree = {
  defaultLocale: 'en-AU',
  categories: [
    {
      id: CAT,
      status: 'active',
      depth: 0,
      names: [{ locale: 'en-AU', name: 'Meat' }],
    },
    { id: 'c2', status: 'archived', depth: 0, names: [{ locale: 'en-AU', name: 'Old' }] },
  ],
};

function route(treeOk = true) {
  call.mockImplementation((method, path) => {
    if (path === 'storefront/admin/catalogue') {
      return Promise.resolve({ ok: true, status: 200, body: catalogue });
    }
    if (path === 'catalog/admin/categories') {
      return Promise.resolve(
        treeOk
          ? { ok: true, status: 200, body: tree }
          : { ok: false, failure: { status: 403, code: 'access.denied' } },
      );
    }
    return Promise.resolve({ ok: true, status: 201, body: { id: 'new-id' } });
  });
}

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NewPageFormView csrfToken="csrf-1" zone="Australia/Brisbane" />
    </NextIntlClientProvider>,
  );
}

const posts = () => call.mock.calls.filter(([method]) => method === 'POST');

beforeEach(() => {
  vi.clearAllMocks();
  route();
});
afterEach(cleanup);

describe('new page form', () => {
  it('offers the three templates that need no product lookup', async () => {
    mount();
    await screen.findByRole('radio', { name: /Campaign landing/ });
    expect(screen.getByRole('radio', { name: /Brand page/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Info page/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Product spotlight/ })).toBeNull();
  });

  it('fills the address from the title until the address is typed in', async () => {
    mount();
    const title = await screen.findByLabelText('Page title');
    fireEvent.change(title, { target: { value: 'Ramadan Specials' } });
    const slug = screen.getByLabelText<HTMLInputElement>('Address');
    expect(slug.value).toBe('ramadan-specials');
    fireEvent.change(slug, { target: { value: 'my-own' } });
    fireEvent.change(title, { target: { value: 'Something else' } });
    expect(slug.value).toBe('my-own');
  });

  it('marks what is missing and sends nothing', async () => {
    mount();
    await screen.findByLabelText('Page title');
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('Choose a template.')).toBeTruthy();
    expect(screen.getByText('Enter a title.')).toBeTruthy();
    expect(screen.getByText('Enter an address.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('refuses a reserved address before asking the API', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Info page/ }));
    fireEvent.change(screen.getByLabelText('Page title'), { target: { value: 'Cart' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('This address is reserved. Choose another.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('offers the linked category only for a template that links categories', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Info page/ }));
    expect(screen.queryByLabelText('Linked category')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Campaign landing/ }));
    const select = await screen.findByLabelText('Linked category');
    expect(select.textContent).toContain('Meat');
    expect(select.textContent).not.toContain('Old');
  });

  it('creates the draft and opens it', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Campaign landing/ }));
    fireEvent.change(screen.getByLabelText('Page title'), {
      target: { value: 'Ramadan specials' },
    });
    fireEvent.change(await screen.findByLabelText('Linked category'), { target: { value: CAT } });
    fireEvent.change(screen.getByLabelText('Live from'), { target: { value: '2026-12-01T09:00' } });
    fireEvent.change(screen.getByLabelText('Live until'), {
      target: { value: '2026-12-08T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/content'));
    expect(posts()[0]).toEqual([
      'POST',
      'storefront/admin/pages',
      {
        templateKey: 'campaign-landing',
        title: 'Ramadan specials',
        slug: 'ramadan-specials',
        linked: { type: 'category', id: CAT },
        // 09:00 in Brisbane (UTC+10) is 23:00 the day before in UTC.
        startsAt: '2026-11-30T23:00:00.000Z',
        endsAt: '2026-12-07T23:00:00.000Z',
      },
      'csrf-1',
    ]);
    expectFlash('Draft created.');
  });

  it('says the address is taken and keeps the form', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Info page/ }));
    fireEvent.change(screen.getByLabelText('Page title'), { target: { value: 'Eid hours' } });
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        path === 'storefront/admin/pages'
          ? { ok: false, failure: { status: 409, code: 'storefront.slug-taken' } }
          : { ok: true, status: 200, body: tree },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('Another page already uses this address.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Page title').value).toBe('Eid hours');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('maps the API field problems on the form', async () => {
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Info page/ }));
    fireEvent.change(screen.getByLabelText('Page title'), { target: { value: 'Eid hours' } });
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        path === 'storefront/admin/pages'
          ? {
              ok: false,
              failure: {
                status: 400,
                code: 'validation.failed',
                details: { fields: [{ path: 'slug', code: 'reserved' }] },
              },
            }
          : { ok: true, status: 200, body: tree },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('This address is reserved. Choose another.')).toBeTruthy();
    expect(screen.getByText('Check the marked fields and try again.')).toBeTruthy();
  });

  it('still creates a page when the category lookup is not allowed', async () => {
    route(false);
    mount();
    fireEvent.click(await screen.findByRole('radio', { name: /Campaign landing/ }));
    expect(screen.queryByLabelText('Linked category')).toBeNull();
  });

  it('shows a load error with a retry when the templates cannot be read', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 500, code: 'x' } });
    mount();
    await screen.findByText(/templates could not be loaded/);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('radio', { name: /Info page/ });
  });
});
