// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { CATEGORY, ID, detail, summary, version } from './test-data.ts';
import { SlidePlacementEditor } from './slide-placement-editor.tsx';
import type { SlideDetail, SlideSummary } from './slide-types.ts';

const call = vi.mocked(callApi);
const ZONE = 'Australia/Brisbane';

/** The list answer: the slides live now. */
const liveList = (slides: SlideSummary[]) => ({
  ok: true as const,
  status: 200,
  body: { slides },
});
const fourAtMid = ['m1', 'm2', 'm3', 'm4'].map((id) => summary({ id, positions: ['home.mid'] }));

function mount(
  props: Partial<React.ComponentProps<typeof SlidePlacementEditor>> = {},
  list: SlideSummary[] | 'fails' = [summary({ id: 'x', positions: ['home.hero'] })],
) {
  call.mockImplementation((method) =>
    Promise.resolve(
      method === 'GET'
        ? list === 'fails'
          ? { ok: false as const, failure: { status: 500, code: 'internal' } }
          : liveList(list)
        : { ok: true as const, status: 200, body: detail() },
    ),
  );
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SlidePlacementEditor slide={detail()} canEdit csrfToken="csrf-1" zone={ZONE} {...props} />
    </NextIntlClientProvider>,
  );
}
const position = (name: string) => screen.getByRole('listitem', { name });
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save to draft' }));
const puts = () => call.mock.calls.filter(([method]) => method === 'PUT');

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('positions', () => {
  it('has one row per position of the catalogue, with the ones the draft uses chosen', async () => {
    mount();
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Home · top',
      'Home · between shelves',
      'Category · above list',
      'Product · below details',
      'Cart · below items',
      'Landing · top',
    ]);
    expect(within(position('Home · top')).getByRole<HTMLInputElement>('checkbox').checked).toBe(
      true,
    );
    expect(
      within(position('Cart · below items')).getByRole<HTMLInputElement>('checkbox').checked,
    ).toBe(false);
    expect(
      screen.getByText('Checkout, order confirmation and account pages never show slides.'),
    ).toBeTruthy();
    await screen.findByText('1 of 8 live');
  });

  it('tags the positions that move on their own', () => {
    mount();
    expect(screen.getAllByText('Moves on its own')).toHaveLength(2);
    expect(within(position('Home · top')).getByText('Moves on its own')).toBeTruthy();
    expect(within(position('Landing · top')).getByText('Moves on its own')).toBeTruthy();
    expect(within(position('Home · between shelves')).queryByText('Moves on its own')).toBeNull();
  });

  it('shows how many places are taken, and full in the warning tone', async () => {
    mount({}, [...fourAtMid, summary({ id: 'h', positions: ['home.hero'] })]);
    expect(await screen.findByText('4 of 4 live · full')).toBeTruthy();
    expect(screen.getByText('1 of 8 live')).toBeTruthy();
    expect(screen.getAllByText('0 of 3 live')).toHaveLength(2);
    expect(call).toHaveBeenCalledWith('GET', 'storefront/admin/slides?state=live');
  });

  it('counts this slide at the positions where it is live, and does not call that full', async () => {
    mount(
      {
        slide: detail({
          status: 'live',
          live: version({
            placements: [{ ...version().placements[0]!, position: 'home.mid' }],
          }),
        }),
      },
      [...fourAtMid.slice(0, 3), summary({ id: ID, positions: ['home.mid'] })],
    );
    expect(await screen.findByText('4 of 4 live · full')).toBeTruthy();
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    expect(screen.queryByText(/is full/)).toBeNull();
  });

  it('warns when a chosen position is full, and not before it is chosen', async () => {
    mount({}, fourAtMid);
    await screen.findByText('4 of 4 live · full');
    expect(screen.queryByText(/is full\./)).toBeNull();
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    expect(
      screen
        .getByText(
          'Home · between shelves is full. If you add this slide there, it waits until a place frees up.',
        )
        .closest('[role="status"]'),
    ).toBeTruthy();
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    expect(screen.queryByText(/is full\./)).toBeNull();
  });

  it('says so, and shows no counts, when the live slides cannot be read', async () => {
    mount({}, 'fails');
    expect(await screen.findByText(/Live counts could not be loaded/)).toBeTruthy();
    expect(screen.queryByText(/of 8 live/)).toBeNull();
    expect(screen.getAllByLabelText('Live count not available')).toHaveLength(6);
    // Choosing and saving still work.
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    expect(screen.queryByText(/is full/)).toBeNull();
  });

  it('asks for a category and offers its subcategories, then an id for a product', () => {
    mount();
    const row = () => position('Category · above list');
    fireEvent.click(within(row()).getByRole('checkbox', { name: 'Category · above list' }));
    expect(within(row()).getByLabelText('Shown on')).toBeTruthy();
    fireEvent.change(within(row()).getByLabelText('Shown on'), { target: { value: 'category' } });
    expect(within(row()).getByLabelText('Category ID')).toBeTruthy();
    expect(within(row()).getByLabelText('Also its subcategories')).toBeTruthy();
    fireEvent.change(within(row()).getByLabelText('Shown on'), { target: { value: 'all' } });
    expect(within(row()).queryByLabelText('Category ID')).toBeNull();
    const product = () => position('Product · below details');
    fireEvent.click(within(product()).getByRole('checkbox', { name: 'Product · below details' }));
    fireEvent.change(within(product()).getByLabelText('Shown on'), {
      target: { value: 'product' },
    });
    expect(within(product()).getByLabelText('Product ID')).toBeTruthy();
    expect(within(product()).queryByLabelText('Also its subcategories')).toBeNull();
    // A position with one scope has no scope choice.
    fireEvent.click(within(position('Cart · below items')).getByRole('checkbox'));
    expect(within(position('Cart · below items')).queryByLabelText('Shown on')).toBeNull();
  });

  it('asks for a landing page id at the landing position', () => {
    mount();
    const row = () => position('Landing · top');
    fireEvent.click(within(row()).getByRole('checkbox'));
    fireEvent.change(within(row()).getByLabelText('Shown on'), { target: { value: 'page' } });
    expect(within(row()).getByLabelText('Landing page ID')).toBeTruthy();
  });
});

describe('saving', () => {
  it('sends the whole draft again with the new place, the window in the Market zone and the pin', async () => {
    mount();
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    const category = position('Category · above list');
    fireEvent.click(within(category).getByRole('checkbox'));
    fireEvent.change(within(category).getByLabelText('Shown on'), {
      target: { value: 'category' },
    });
    fireEvent.change(within(category).getByLabelText('Category ID'), {
      target: { value: ` ${CATEGORY}` },
    });
    fireEvent.click(within(category).getByLabelText('Also its subcategories'));
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-11-10T23:59' } });
    fireEvent.click(screen.getByLabelText('Pin first in its positions'));
    save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const [method, path, body, csrf] = puts()[0]!;
    expect([method, path, csrf]).toEqual(['PUT', `storefront/admin/slides/${ID}`, 'csrf-1']);
    expect(body).toMatchObject({
      internalName: 'Diwali sweets week',
      sponsored: false,
      pinned: true,
      startsAt: '2026-10-26T14:00:00Z',
      endsAt: '2026-11-10T13:59:00.000Z',
      content: { title: 'Diwali sweets, delivered', ctaLabel: 'Shop sweets' },
      placements: [
        { position: 'home.hero', scope: 'all', scopeId: null },
        { position: 'home.mid', scope: 'all', scopeId: null, autoplay: false },
        {
          position: 'category.top',
          scope: 'category',
          scopeId: CATEGORY,
          includeSubcategories: true,
        },
      ],
    });
    expect(await screen.findByText('Saved to draft as version 3.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Discard' }).disabled).toBe(true);
  });

  it('names the zone, and says the end is required and at most 90 days after the start', () => {
    mount();
    expect(screen.getByText('Times in Australia/Brisbane.')).toBeTruthy();
    expect(screen.getByText('Required, at most 90 days after the start.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Starts').type).toBe('datetime-local');
    expect(screen.getByLabelText<HTMLInputElement>('Starts').value).toBe('2026-10-27T00:00');
    expect(screen.getByLabelText<HTMLInputElement>('Ends').value).toBe('2026-11-03T23:59');
  });

  it('refuses an end more than 90 days after the start, marks the field and sends nothing', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2027-02-01T00:00' } });
    save();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(
      screen.getByText('A slide can run for at most 90 days. Move the end closer to the start.'),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ends')));
    expect(screen.getByLabelText('Ends').getAttribute('aria-invalid')).toBe('true');
    expect(puts()).toHaveLength(0);
    // Typing in the field clears its error.
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-11-03T23:59' } });
    expect(screen.getByLabelText('Ends').getAttribute('aria-invalid')).toBeNull();
  });

  it('requires an end, an end after the start, a position and a valid id', () => {
    mount();
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '' } });
    save();
    expect(screen.getByText('Choose when the slide ends.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-10-27T00:00' } });
    save();
    expect(screen.getByText('The end must be after the start.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-11-03T23:59' } });
    fireEvent.click(within(position('Home · top')).getByRole('checkbox'));
    save();
    expect(screen.getByText('Choose at least one position.')).toBeTruthy();
    const category = position('Category · above list');
    fireEvent.click(within(category).getByRole('checkbox'));
    fireEvent.change(within(category).getByLabelText('Shown on'), {
      target: { value: 'category' },
    });
    save();
    expect(within(category).getByText('Fill this in.')).toBeTruthy();
    fireEvent.change(within(category).getByLabelText('Category ID'), { target: { value: 'nope' } });
    save();
    expect(within(category).getByText(/Enter a valid id/)).toBeTruthy();
    expect(puts()).toHaveLength(0);
  });

  it('maps the problems the API finds onto the window and the rows', async () => {
    mount();
    const category = position('Category · above list');
    fireEvent.click(within(category).getByRole('checkbox'));
    fireEvent.change(within(category).getByLabelText('Shown on'), {
      target: { value: 'category' },
    });
    fireEvent.change(within(category).getByLabelText('Category ID'), {
      target: { value: CATEGORY },
    });
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'GET'
          ? liveList([])
          : {
              ok: false as const,
              failure: {
                status: 400,
                code: 'validation.failed',
                details: {
                  fields: [
                    { path: 'endsAt', code: 'too-long' },
                    { path: 'placements[1].scopeId', code: 'format' },
                  ],
                },
              },
            },
      ),
    );
    save();
    expect(await screen.findByText(/at most 90 days. Move the end/)).toBeTruthy();
    expect(within(category).getByText(/Enter a valid id/)).toBeTruthy();
    expect(screen.getByLabelText('Ends').getAttribute('aria-invalid')).toBe('true');
  });

  it.each([
    [{ status: 0, code: 'network' }, 'No connection. Your changes are still here; try again.'],
    [
      { status: 409, code: 'storefront.slide-archived' },
      'This slide is archived and can no longer be changed.',
    ],
    [
      { status: 409, code: 'storefront.slide-version-limit' },
      'This slide has reached its limit of saved versions.',
    ],
    [{ status: 404, code: 'storefront.slide-not-found' }, 'This slide no longer exists.'],
    [{ status: 403, code: 'access.denied' }, "You don't have permission to change slides."],
    [{ status: 500, code: 'internal' }, 'The slide could not be saved. Try again.'],
  ])('says what went wrong for %j and keeps what was chosen', async (failure, text) => {
    mount();
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    call.mockImplementation((method) =>
      Promise.resolve(method === 'GET' ? liveList([]) : { ok: false as const, failure }),
    );
    save();
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect(
      within(position('Home · between shelves')).getByRole<HTMLInputElement>('checkbox').checked,
    ).toBe(true);
  });

  it('sends a signed-out editor to the session-ended page', async () => {
    mount();
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'GET'
          ? liveList([])
          : { ok: false as const, failure: { status: 401, code: 'session.invalid' } },
      ),
    );
    save();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('puts the form back as saved on Discard', () => {
    mount();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Discard' }).disabled).toBe(true);
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('Ends'), { target: { value: '2026-11-05T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(
      within(position('Home · between shelves')).getByRole<HTMLInputElement>('checkbox').checked,
    ).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Ends').value).toBe('2026-11-03T23:59');
  });
});

describe('page frame and permission gates', () => {
  it('shows the slide name, versions and both tabs with Where and when current', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Diwali sweets week' })).toBeTruthy();
    const tabs = within(screen.getByRole('navigation', { name: 'Slide sections' }));
    expect(tabs.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      `/content/slides/${ID}`,
      `/content/slides/${ID}/placement`,
    ]);
    expect(tabs.getByRole('link', { name: 'Where and when' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Slides' }).getAttribute('href')).toBe(
      '/content/slides',
    );
  });

  it('edits and saves with the edit permission', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Save to draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
    expect(
      screen.queryByText('You can view where and when slides appear but not change it.'),
    ).toBeNull();
    expect(screen.getByLabelText('Starts').matches(':disabled')).toBe(false);
    expect(
      screen.getByText('Buyers see these changes only after a platform admin approves.'),
    ).toBeTruthy();
  });

  it('is read-only without it: values shown, every control off, no Save', () => {
    mount({ canEdit: false });
    expect(
      screen.getByText('You can view where and when slides appear but not change it.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save to draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    for (const control of [
      ...screen.getAllByRole<HTMLInputElement>('checkbox'),
      screen.getByLabelText<HTMLInputElement>('Starts'),
      screen.getByLabelText<HTMLInputElement>('Ends'),
    ]) {
      expect(control.matches(':disabled')).toBe(true);
    }
    expect(screen.getByLabelText<HTMLInputElement>('Ends').value).toBe('2026-11-03T23:59');
    fireEvent.submit(screen.getByRole('form', { name: 'Where and when' }));
    expect(puts()).toHaveLength(0);
  });

  it('is read-only for an archived slide, even for an editor', () => {
    mount({ slide: detail({ status: 'archived', live: null }) });
    expect(screen.getByText('This slide is archived. It cannot be changed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save to draft' })).toBeNull();
    expect(screen.getByLabelText('Ends').matches(':disabled')).toBe(true);
  });
});

describe('what a save does not touch', () => {
  it('keeps a second placement at a position and a position the panel does not list', async () => {
    const base = version().placements[0]!;
    const slide: SlideDetail = detail({
      draft: version({
        placements: [
          base,
          { ...base, position: 'category.top', scope: 'category', scopeId: CATEGORY },
          { ...base, position: 'category.top', scope: 'category', scopeId: ID },
          { ...base, position: 'checkout.top' },
        ],
      }),
    });
    mount({ slide });
    expect(screen.getByText('1 more placement at this position is kept as it is.')).toBeTruthy();
    expect(
      screen.getByText('1 placement at a position this panel does not list is kept as it is.'),
    ).toBeTruthy();
    fireEvent.click(within(position('Home · between shelves')).getByRole('checkbox'));
    save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const { placements } = puts()[0]![2] as {
      placements: { position: string; scopeId: string | null }[];
    };
    expect(placements.map((p) => p.position)).toEqual([
      'home.hero',
      'home.mid',
      'category.top',
      'category.top',
      'checkout.top',
    ]);
  });
});
