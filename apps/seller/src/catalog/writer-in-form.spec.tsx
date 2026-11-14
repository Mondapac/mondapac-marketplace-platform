// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { callApi } from '../api/client.ts';
import { EditForm } from './edit-form.tsx';
import type { ProductView } from './types.ts';

const call = vi.mocked(callApi);
const WRITER = 'catalog/own/description-writer';
const PANTRY = 'c-pantry';
const RICE = 'c-rice';

const product = (description: string): ProductView => ({
  productId: 'p1',
  productCode: 'P00000001',
  typeCode: 'grocery',
  familyCode: 'food',
  variantModel: 'single',
  status: 'draft',
  pausedAt: null,
  variants: [],
  maxVariants: 5,
  sensitiveFields: [],
  lastChangedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  pendingSubmittedAt: null,
  form: {
    taxCategoryCodes: [],
    units: [],
    fields: [
      {
        code: 'origin',
        dataType: 'text',
        localizable: false,
        required: false,
        isVariantOption: false,
        bounds: {},
        names: { 'en-AU': 'Origin' },
        options: [],
      },
    ],
    categories: [
      { categoryId: PANTRY, parentId: null, names: { 'en-AU': 'Pantry' } },
      { categoryId: RICE, parentId: PANTRY, names: { 'en-AU': 'Rice' } },
    ],
  },
  workingCopy: {
    content: {
      texts: { 'en-AU': { name: 'Sella rice', description } },
      categoryIds: [RICE],
      attributeValues: { origin: 'India' },
    },
    lastSavedAt: '2026-10-01T00:00:00Z',
    baseRevisionId: null,
  },
  published: null,
  pending: null,
});

const route = (writer: 'on' | 'off' | 'refused') =>
  call.mockImplementation((method: string, path: string) => {
    if (method === 'GET' && path === WRITER) {
      return Promise.resolve(
        writer === 'refused'
          ? { ok: false, failure: { status: 403, code: 'access.denied' } }
          : {
              ok: true,
              status: 200,
              body: { available: writer === 'on', resetZone: 'Australia/Brisbane' },
            },
      );
    }
    if (method === 'POST' && path === `${WRITER}/drafts`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        body: {
          text: 'Drafted text.',
          leftOut: { certification: 1, other: 0 },
          promptVersion: 'v1',
        },
      });
    }
    return Promise.resolve({ ok: false, failure: { status: 404, code: 'unknown' } });
  });

const mount = (p: ProductView) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={p}
        photos={[]}
        locales={['en-AU']}
        defaultLocale="en-AU"
        marketName="Australia"
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );

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

describe('the seller product form: Write with AI', () => {
  it.each(['off', 'refused'] as const)('shows no button when the status is %s', async (state) => {
    route(state);
    mount(product(''));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('GET', WRITER, undefined, undefined, expect.anything()),
    );
    expect(screen.queryByRole('button', { name: 'Write with AI' })).toBeNull();
  });

  it('puts the button in the Description field head only, and sends the form values', async () => {
    route('on');
    mount(product('Existing.'));
    const buttons = await screen.findAllByRole('button', { name: 'Write with AI' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0] as HTMLElement);
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft · check it before you use it');
    expect(screen.getByText('1 sentence was left out: it named a certification.')).toBeTruthy();
    const post = call.mock.calls.find((c) => c[0] === 'POST');
    expect(post?.[2]).toMatchObject({
      title: 'Sella rice',
      category: 'Pantry › Rice',
      details: [{ name: 'Origin', value: 'India' }],
    });
    expect(post?.[3]).toBe('csrf');
    fireEvent.click(screen.getByRole('button', { name: 'Use text' }));
    expect(screen.getByLabelText<HTMLInputElement>(/^Description/).value).toBe('Drafted text.');
    expect(await screen.findByRole('button', { name: 'Save draft' })).toBeTruthy();
  });
});
