// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { callApi } from '../../api/client.ts';

const mocks = vi.hoisted(() => ({ call: vi.fn<typeof callApi>() }));
vi.mock('../../api/client.ts', () => ({ callApi: mocks.call }));

import { ProductEdit } from './edit-form.tsx';
import type { ProductView } from './types.ts';

const ID = '0190a000-0000-7000-8000-0000000000c1';
const PANTRY = '0190a000-0000-7000-8000-0000000000d1';
const RICE = '0190a000-0000-7000-8000-0000000000d2';
const WRITER = 'catalog/admin/description-writer';

const product = (description: string): ProductView => ({
  productId: ID,
  productCode: 'P00000001',
  typeCode: 'simple',
  familyCode: 'default',
  variantModel: 'single',
  status: 'draft',
  pausedAt: null,
  offers: { sellerCount: 0, offerCount: 0 },
  variants: [],
  maxVariants: 100,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  form: {
    taxCategoryCodes: ['gst'],
    fields: [
      {
        code: 'origin',
        dataType: 'select',
        localizable: false,
        required: false,
        isVariantOption: false,
        bounds: {},
        names: { en: 'Country of origin' },
        options: [{ code: 'in', labels: { en: 'India' } }],
      },
    ],
    categories: [
      { categoryId: PANTRY, parentId: null, names: { en: 'Pantry' } },
      { categoryId: RICE, parentId: PANTRY, names: { en: 'Rice' } },
    ],
  },
  locales: { default: 'en', supported: ['en'] },
  workingCopy: {
    content: {
      texts: { en: { name: 'Sella rice', description } },
      categoryIds: [RICE],
      attributeValues: { origin: 'in' },
    },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: null,
  },
  published: null,
});

function route(description: string, writer: 'on' | 'off') {
  mocks.call.mockImplementation((method: string, path: string) => {
    if (path === `catalog/admin/platform-products/${ID}`) {
      return Promise.resolve({ ok: true, status: 200, body: product(description) });
    }
    if (path.endsWith('/images'))
      return Promise.resolve({ ok: true, status: 200, body: { images: [] } });
    if (method === 'GET' && path === WRITER) {
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { available: writer === 'on', resetZone: 'Australia/Brisbane' },
      });
    }
    if (method === 'POST' && path === `${WRITER}/drafts`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        body: {
          text: 'Drafted text.',
          leftOut: { certification: 0, other: 0 },
          promptVersion: 'v1',
        },
      });
    }
    return Promise.resolve({ ok: false, failure: { status: 404, code: 'unknown' } });
  });
}

const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ProductEdit
        productId={ID}
        csrfToken="csrf-1"
        marketName="Australia"
        timeZone="Australia/Brisbane"
        canPause={false}
        canReadTags={false}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  mocks.call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('the platform product form: Write with AI', () => {
  it('shows no button when the status says the writer is off', async () => {
    route('', 'off');
    mount();
    await screen.findByLabelText(/^Description/);
    await waitFor(() =>
      expect(mocks.call).toHaveBeenCalledWith(
        'GET',
        WRITER,
        undefined,
        undefined,
        expect.anything(),
      ),
    );
    expect(screen.queryByRole('button', { name: 'Write with AI' })).toBeNull();
  });

  it('sends the form title, category path and details, and puts the draft into the field', async () => {
    route('Existing text.', 'on');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Write with AI' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await screen.findByText('Draft · check it before you use it');
    const post = mocks.call.mock.calls.find((c) => c[0] === 'POST');
    expect(post?.[1]).toBe(`${WRITER}/drafts`);
    expect(post?.[2]).toMatchObject({
      title: 'Sella rice',
      category: 'Pantry › Rice',
      details: [{ name: 'Country of origin', value: 'India' }],
    });
    expect(post?.[3]).toBe('csrf-1');
    fireEvent.click(screen.getByLabelText('Add below it'));
    fireEvent.click(screen.getByRole('button', { name: 'Use text' }));
    expect(screen.getByLabelText<HTMLTextAreaElement>(/^Description/).value).toBe(
      'Existing text.\n\nDrafted text.',
    );
    // The edit counts as unsaved: the bar offers Save.
    expect(await screen.findByRole('button', { name: /Save/ })).toBeTruthy();
  });
});
