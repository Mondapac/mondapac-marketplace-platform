// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { editProblemOf } from './edit-errors.ts';
import { contentWith, EditForm } from './edit-form.tsx';
import type { ProductView } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const product = (over: Partial<ProductView> = {}): ProductView => ({
  productId: 'p1',
  productCode: 'P00000001',
  typeCode: 'grocery',
  familyCode: 'food',
  variantModel: 'single',
  status: 'draft',
  variants: [
    { variantId: 'v1', state: 'active' },
    { variantId: 'v2', state: 'retired' },
  ],
  maxVariants: 5,
  sensitiveFields: [],
  lastChangedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  pendingSubmittedAt: null,
  form: { taxCategoryCodes: [], fields: [], categories: [] },
  workingCopy: {
    content: { texts: { 'en-AU': { name: 'Olive oil' } }, attributes: { size: '1L' } },
    lastSavedAt: '2026-10-01T00:00:00Z',
    baseRevisionId: null,
  },
  published: null,
  pending: null,
  ...over,
});
const mount = (p: ProductView = product()) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={p}
        photos={[]}
        locales={['en-AU', 'ar']}
        defaultLocale="en-AU"
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );
const saved = { ok: true, status: 200, body: { variantIds: ['v1'], refusedFields: [] } } as const;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign: vi.fn() }, writable: true });
});
afterEach(cleanup);

describe('EditForm', () => {
  it('saves only the texts and sends every other draft key back unchanged', async () => {
    call.mockResolvedValue(saved);
    mount();
    fireEvent.change(screen.getAllByLabelText(/Short description/)[0] as HTMLElement, {
      target: { value: ' Cold pressed ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'catalog/seller/products/p1/draft',
      {
        content: {
          texts: { 'en-AU': { name: 'Olive oil', shortDescription: 'Cold pressed' } },
          attributes: { size: '1L' },
        },
        variantIds: ['v1'],
      },
      'csrf',
    );
    await expectToast('Draft saved.');
  });

  it('submits without saving first when nothing changed', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { revisionId: 'r1', revisionNo: 1, published: false },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/products/p1/submit',
      { replacePending: false },
      'csrf',
    );
  });

  it('saves first when changed, then submits, once even on a double click', async () => {
    call.mockResolvedValueOnce(saved).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { revisionId: 'r1', revisionNo: 1, published: true },
    });
    mount();
    fireEvent.change(screen.getAllByLabelText('Name')[1] as HTMLElement, {
      target: { value: 'زيت' },
    });
    const button = screen.getByRole('button', { name: 'Submit for review' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call.mock.calls.map((c) => c[0])).toEqual(['PUT', 'POST']);
    await expectToast('Published.');
  });

  it('shows the refused texts and does not submit', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        variantIds: ['v1'],
        refusedFields: [{ field: 'texts.name', ref: null, locale: 'en-AU', code: 'claim-text' }],
      },
    });
    mount();
    fireEvent.change(screen.getAllByLabelText('Name')[0] as HTMLElement, {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText(/Some texts were not saved/)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('shows not-ready issues as plain text', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        code: 'revision.not-ready',
        details: { issues: [{ path: 'attributes.size', code: '<b>required</b>' }] },
      },
    });
    mount();
    fireEvent.change(screen.getAllByLabelText('Name')[0] as HTMLElement, {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('attributes.size: <b>required</b>')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload the product' })).toBeNull();
  });

  it('offers the replace option only when a revision is waiting', () => {
    mount();
    expect(screen.queryByLabelText(/Replace the revision/)).toBeNull();
    cleanup();
    mount(product({ pending: {} as ProductView['pending'] }));
    expect(screen.getByLabelText(/Replace the revision/)).toBeTruthy();
  });
});

describe('contentWith and editProblemOf', () => {
  it('drops empty texts and keeps other keys', () => {
    expect(
      contentWith(
        { a: 1 },
        {
          x: { name: ' ', shortDescription: '', description: '' },
          y: { name: 'n', shortDescription: '', description: '' },
        },
      ),
    ).toEqual({ a: 1, texts: { y: { name: 'n' } } });
  });

  it('maps codes to messages and asks for a reload when stale', () => {
    expect(editProblemOf({ status: 409, code: 'conflict.stale' })).toMatchObject({
      key: 'catalog.edit.error.stale',
      reload: true,
    });
    expect(
      editProblemOf({ status: 429, code: 'request.throttled', details: { retryAfterSeconds: 5 } }),
    ).toMatchObject({ values: { seconds: 5 } });
    expect(editProblemOf({ status: 500, code: 'x' }).key).toBe('catalog.edit.error.unknown');
  });
});
