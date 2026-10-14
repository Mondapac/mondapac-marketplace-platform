// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { descriptionWith, OfferEditForm } from './offer-edit-form.tsx';
import { offerEditProblemOf } from './offer-edit-errors.ts';
import type { OfferView, ProductOptions } from './types.ts';

const call = vi.mocked(callApi);
const assign = vi.fn();
const offer: OfferView = {
  offerId: 'o1',
  productId: 'p1',
  product: { productCode: 'P1', typeCode: 'grocery', name: 'Olive oil' },
  sellerSku: 'OIL-1',
  conditionCode: 'new',
  description: { 'en-AU': 'Cold pressed', fr: 'Pressée à froid' },
  status: 'draft',
  listed: false,
  offSaleCauses: [],
  handling: null,
  attestationRecorded: false,
  submittedAt: null,
  firstPublishedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  version: 1,
};
const options: ProductOptions = {
  productTypes: ['grocery'],
  conditions: ['new', 'used'],
  locales: { default: 'en-AU', supported: ['en-AU', 'ar'] },
  sellerCanCreateProduct: true,
};
const mount = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OfferEditForm offer={offer} options={options} csrfToken="csrf" />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(cleanup);

describe('OfferEditForm', () => {
  it('sends the whole form and keeps texts of locales it does not show', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { changedFields: ['sellerSku'] } });
    mount();
    fireEvent.change(screen.getByLabelText(/Your SKU/), { target: { value: 'OIL-2' } });
    fireEvent.change(screen.getByLabelText(/Description \(ar\)/), { target: { value: ' زيت ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save offer' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'catalog/seller/offers/o1',
      {
        sellerSku: 'OIL-2',
        conditionCode: 'new',
        description: { fr: 'Pressée à froid', 'en-AU': 'Cold pressed', ar: 'زيت' },
      },
      'csrf',
    );
    expect(await screen.findByText('Offer saved.')).toBeTruthy();
  });

  it('shows a taken SKU on the field', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'offer.sku-taken' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save offer' }));
    expect(await screen.findAllByText(/already have an open offer/)).not.toHaveLength(0);
  });

  it('sends a signed-out seller to the session-ended page', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save offer' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('offer edit helpers', () => {
  it('drops cleared locales and keeps unshown ones', () => {
    expect(descriptionWith({ fr: 'x', a: 'old' }, { a: ' ', b: 'new' }, ['a', 'b'])).toEqual({
      fr: 'x',
      b: 'new',
    });
  });
  it('names offer-specific codes and falls back to the create mapping', () => {
    expect(offerEditProblemOf({ status: 409, code: 'offer.not-editable' }).form).toBe(
      'catalog.offer-edit.error.not-editable',
    );
    expect(offerEditProblemOf({ status: 422, code: 'claim-text.refused' }).fields).toEqual({
      description: 'catalog.offer-edit.error.claim-text',
    });
    expect(offerEditProblemOf({ status: 429, code: 'request.throttled' }).form).toBe(
      'catalog.create.error.throttled',
    );
  });
});
