// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { ProposalsView } from './proposals-view.tsx';
import { ShelfPicker } from './shelf-picker.tsx';
import type { OwnProposal, OwnProposals } from './types.ts';
import { visibleNavItems } from '@mondapac/ui';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
import { callApi } from '../api/client.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-0000000000${n.toString(16).padStart(2, '0')}`;
const assign = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(() => cleanup());

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const proposal = (over: Partial<OwnProposal>): OwnProposal => ({
  id: id(1),
  platformParentId: id(10),
  texts: [{ locale: 'en-AU', name: 'Sweets', description: null }],
  status: 'pending',
  reasonCode: null,
  sellerCategoryId: null,
  decidedAt: null,
  createdAt: '2026-11-05T01:00:00.000Z',
  version: 3,
  ...over,
});
const data = (over: Partial<OwnProposals> = {}): OwnProposals => ({
  canPropose: true,
  maxPending: 3,
  proposals: [],
  shelves: [],
  ...over,
});
const PARENTS = [{ categoryId: id(10), parentId: null, names: { 'en-AU': 'Pantry' } }];
const LOCALES = { default: 'en-AU', supported: ['en-AU', 'fa'] };

function view(over: Partial<OwnProposals> = {}, sent = false) {
  return render(
    wrap(
      <ProposalsView
        data={data(over)}
        parents={PARENTS}
        locales={LOCALES}
        csrfToken="csrf"
        sent={sent}
      />,
    ),
  );
}

describe('Suggest a category', () => {
  it('shows a note and no form when the platform has not enabled it', () => {
    view({ canPropose: false });
    expect(screen.getByText(/has not turned on category suggestions/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send suggestion' })).toBeNull();
  });

  it('counts waiting proposals and hides the form at the cap', () => {
    view({
      maxPending: 1,
      proposals: [proposal({})],
    });
    expect(screen.getByTestId('pending-count').textContent).toBe('1 of 1 waiting');
    expect(screen.queryByRole('button', { name: 'Send suggestion' })).toBeNull();
  });

  it('sends the parent and the typed texts, per locale, with dir rtl for Persian', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: {} });
    view();
    fireEvent.change(screen.getByLabelText('Platform category it belongs under'), {
      target: { value: id(10) },
    });
    fireEvent.change(screen.getByLabelText(/^Shelf name/), { target: { value: 'Sweets' } });
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fa' } });
    const fa = screen.getByLabelText(/^Shelf name/);
    expect(fa.getAttribute('dir')).toBe('rtl');
    fireEvent.change(fa, { target: { value: 'شیرینی' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/category-proposals',
      {
        platformParentId: id(10),
        texts: { 'en-AU': { name: 'Sweets' }, fa: { name: 'شیرینی' } },
      },
      'csrf',
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/category-proposals?sent=1'));
  });

  it('keeps Send off until a parent and the default name are set', () => {
    view();
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send suggestion' });
    expect(send.disabled).toBe(true);
  });

  it.each([
    ['category-proposal.duplicate', 409, /already have a suggestion or a shelf/],
    ['category-proposal.limit', 422, /5 suggestions waiting/],
    ['claim-text.check-unavailable', 503, /wording check is not available/],
    ['request.throttled', 429, /too many suggestions today/],
    ['conflict.stale', 409, /changed since you opened/],
    ['category-proposal.not-allowed', 403, /has not turned on category suggestions/],
  ])('explains %s in words', async (code, status, text) => {
    call.mockResolvedValue({
      ok: false,
      failure: { status, code, details: { max: 5 } },
    });
    view();
    fireEvent.change(screen.getByLabelText('Platform category it belongs under'), {
      target: { value: id(10) },
    });
    fireEvent.change(screen.getByLabelText(/^Shelf name/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(text);
  });

  it('points at the field of a refused word without repeating the word', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        code: 'category.claim-word',
        details: { fields: [{ path: 'texts.en-AU.name', code: 'claim-word' }] },
      },
    });
    view();
    fireEvent.change(screen.getByLabelText('Platform category it belongs under'), {
      target: { value: id(10) },
    });
    fireEvent.change(screen.getByLabelText(/^Shelf name/), { target: { value: 'secretword' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Australian English, name: uses a word that is not allowed/);
    expect(alert.textContent).not.toMatch(/secretword/);
  });

  it('lists proposals with status and reason, and shows permission removed', () => {
    view({
      proposals: [
        proposal({ id: id(1) }),
        proposal({ id: id(2), status: 'cancelled', reasonCode: 'permission-revoked' }),
        proposal({ id: id(3), status: 'rejected', reasonCode: 'too-broad' }),
      ],
    });
    expect(screen.getByText('Closed: permission removed')).toBeTruthy();
    expect(screen.getByText('Rejected: too broad for a shelf.')).toBeTruthy();
    // Only the waiting one can be withdrawn.
    expect(screen.getAllByRole('button', { name: 'Withdraw' })).toHaveLength(1);
  });

  it('withdraws a waiting proposal with its version', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    view({ proposals: [proposal({ id: id(1), version: 3 })] });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `catalog/seller/category-proposals/${id(1)}/cancel`,
        { version: 3 },
        'csrf',
      ),
    );
  });

  it('says so when a withdraw is stale', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    view({ proposals: [proposal({})] });
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed since/);
  });

  it('lists the shelves', () => {
    view({
      shelves: [
        {
          id: id(20),
          platformParentId: id(10),
          slug: 'sweets',
          status: 'active',
          texts: [{ locale: 'en-AU', name: 'Sweets', description: null }],
          version: 1,
        },
      ],
    });
    const shelves = screen.getByRole('region', { name: 'Your shelves' });
    expect(within(shelves).getByText('Sweets')).toBeTruthy();
    expect(within(shelves).getByText('Active')).toBeTruthy();
  });

  it('adds the page to the menu only with the propose permission', () => {
    const ids = (keys: string[]) => visibleNavItems(sellerNav, new Set(keys)).map((i) => i.id);
    expect(ids(['catalog.own-category.propose'])).toContain('s_categories');
    expect(ids(['catalog.own-product.view'])).not.toContain('s_categories');
  });
});

describe('shelf picker', () => {
  const shelves = [{ id: id(20), name: 'Sweets' }];
  const picker = () =>
    render(wrap(<ShelfPicker offerId={id(5)} version={4} shelves={shelves} csrfToken="csrf" />));

  it('puts the Offer on a shelf with its version, then uses the new version', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { version: 5 } });
    picker();
    fireEvent.change(screen.getByLabelText('Shelf'), { target: { value: id(20) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save shelf' }));
    await screen.findByText('The Offer is on the shelf.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      `catalog/seller/offers/${id(5)}/shelf`,
      { shelfId: id(20), version: 4 },
      'csrf',
    );
    fireEvent.change(screen.getByLabelText('Shelf'), { target: { value: '__none' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save shelf' }));
    await screen.findByText('The Offer is off its shelf.');
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      `catalog/seller/offers/${id(5)}/shelf`,
      { shelfId: null, version: 5 },
      'csrf',
    );
  });

  it('explains a stale write', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    picker();
    fireEvent.change(screen.getByLabelText('Shelf'), { target: { value: id(20) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save shelf' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Offer changed/);
  });
});
