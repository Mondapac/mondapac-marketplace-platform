// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { SlideOrderView } from './slide-order-view.tsx';
import type { OrderEntry, OrderPlace, OrderView } from './slide-order.ts';
import { SlidesViewSwitch } from './slides-view-switch.tsx';

const call = vi.mocked(callApi);
const ZONE = 'Australia/Brisbane';
const HERO: OrderPlace = { position: 'home.hero', scope: 'all', scopeId: null };
const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';

const entry = (id: string, name: string, patch: Partial<OrderEntry> = {}): OrderEntry => ({
  id,
  internalName: name,
  status: 'live',
  pinned: false,
  startsAt: '2026-10-23T20:00:00Z',
  endsAt: '2026-10-26T13:59:00Z',
  overLimit: false,
  ...patch,
});
const pinned = entry('p', 'Storm delivery delays', { pinned: true });
const shop = entry('a', 'Shop Express');
const fruit = entry('b', 'Spring fruit boxes');
const diwali = entry('c', 'Diwali sweets week', {
  status: 'scheduled',
  startsAt: '2026-10-26T14:00:00Z',
  endsAt: '2026-11-03T13:59:00Z',
});
const viewOf = (slides: OrderEntry[], maxActive = 8): OrderView => ({
  position: 'home.hero',
  scope: 'all',
  scopeId: null,
  maxActive,
  slides,
});
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

/** GET answers from `reads` in turn (the last one repeats); PUT answers `put`. */
function mount(
  reads: (OrderView | ReturnType<typeof fail>)[],
  put: ReturnType<typeof ok> | ReturnType<typeof fail> = ok({}),
  props: Partial<React.ComponentProps<typeof SlideOrderView>> = {},
) {
  let read = 0;
  call.mockImplementation((method) => {
    if (method === 'PUT') return Promise.resolve(put);
    const answer = reads[Math.min(read, reads.length - 1)];
    read += 1;
    return Promise.resolve(answer !== undefined && 'ok' in answer ? answer : ok(answer));
  });
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SlideOrderView place={HERO} canEdit csrfToken="csrf-1" zone={ZONE} {...props} />
    </NextIntlClientProvider>,
  );
}
const names = () =>
  within(screen.getByRole('list', { name: /^Slides at/ }))
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '');
const puts = () => call.mock.calls.filter(([method]) => method === 'PUT');
const save = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Save order' });
const discard = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Discard' });
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
const four = () => viewOf([pinned, shop, fruit, diwali]);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('loading the order', () => {
  it('shows a skeleton, then reads the place from the API once', async () => {
    mount([four()]);
    expect(screen.getByRole('status').textContent).toContain('Loading the order');
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('GET', 'storefront/admin/slides/order?position=home.hero');
  });

  it('reads one scope with its id', async () => {
    mount([four()], ok({}), {
      place: { position: 'category.top', scope: 'category', scopeId: CATEGORY },
    });
    await screen.findByRole('heading', { name: 'Category · above list' });
    expect(call).toHaveBeenCalledWith(
      'GET',
      `storefront/admin/slides/order?position=category.top&scope=category&scopeId=${CATEGORY}`,
    );
    expect(screen.getByText(`One category: ${CATEGORY}`)).toBeTruthy();
  });

  it('asks for the id before it reads a scope that needs one', () => {
    mount([four()], ok({}), {
      place: { position: 'category.top', scope: 'category', scopeId: null },
    });
    expect(screen.getByText('Enter the id of the item to see its order.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows an error with a retry that reads again', async () => {
    mount([fail(500, 'internal'), four()]);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The order could not be loaded');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('signs out a rejected session', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    mount([fail(401, 'session.invalid')]);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('says so when no slide is approved at the position', async () => {
    mount([viewOf([])]);
    expect(await screen.findByText('No approved slides at this position')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to all slides' }).getAttribute('href')).toBe(
      '/content/slides',
    );
    expect(screen.queryByRole('button', { name: 'Save order' })).toBeNull();
  });
});

describe('the card', () => {
  it('shows the position, its limit and that it moves on its own', async () => {
    mount([four()]);
    expect(await screen.findByRole('heading', { name: 'Home · top' })).toBeTruthy();
    expect(screen.getByText('Up to 8 live')).toBeTruthy();
    expect(screen.getByText('Moves on its own')).toBeTruthy();
  });

  it('does not say a position moves on its own when it does not', async () => {
    mount([{ ...four(), maxActive: 4 }], ok({}), {
      place: { position: 'home.mid', scope: 'all', scopeId: null },
    });
    await screen.findByText('Up to 4 live');
    expect(screen.queryByText('Moves on its own')).toBeNull();
  });

  it('numbers the rows in the saved order, with status, pin and window', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    const rows = within(screen.getByRole('list', { name: /^Slides at/ })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain('1Storm delivery delaysLivePinned');
    expect(rows[1]?.textContent).toContain('2Shop ExpressLive');
    expect(rows[2]?.textContent).toContain('3Spring fruit boxesLive');
    expect(rows[3]?.textContent).toContain('4Diwali sweets weekFrom 27 Oct');
    expect(rows[3]?.textContent).toContain('27 Oct, 12:00 am');
    expect(rows[0]?.textContent).toContain('24 Oct, 6:00 am');
  });

  it('puts the over-limit line before the first slide over the limit', async () => {
    mount([viewOf([shop, fruit, entry('d', 'Third', { overLimit: true }), diwali], 2)]);
    await screen.findByRole('heading', { name: 'Home · top' });
    const rows = names();
    expect(rows[2]).toBe('Over the limit, waits for a free place');
    expect(rows.indexOf('Over the limit, waits for a free place')).toBe(2);
    expect(rows).toHaveLength(5);
  });

  it('has no over-limit line when every live slide has a place', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(screen.queryByText('Over the limit, waits for a free place')).toBeNull();
  });
});

describe('moving slides', () => {
  it('gives each slide two buttons named after it, disabled at the ends and for pinned slides', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(button('Move Storm delivery delays up').disabled).toBe(true);
    expect(button('Move Storm delivery delays down').disabled).toBe(true);
    expect(button('Move Shop Express up').disabled).toBe(true);
    expect(button('Move Shop Express down').disabled).toBe(false);
    expect(button('Move Spring fruit boxes up').disabled).toBe(false);
    expect(button('Move Diwali sweets week up').disabled).toBe(false);
    expect(button('Move Diwali sweets week down').disabled).toBe(true);
  });

  it('moves a slide, announces it, and enables Discard and Save', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(true);
    fireEvent.click(button('Move Spring fruit boxes up'));
    const rows = names();
    expect(rows[1]).toContain('Spring fruit boxes');
    expect(rows[2]).toContain('Shop Express');
    expect(rows[0]).toContain('Storm delivery delays');
    expect(screen.getByText('Spring fruit boxes moved to place 2 of 4.')).toBeTruthy();
    expect(save().disabled).toBe(false);
    expect(discard().disabled).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on the moved slide, on the other button once it reaches an end', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Diwali sweets week up'));
    expect(document.activeElement).toBe(button('Move Diwali sweets week up'));
    fireEvent.click(button('Move Diwali sweets week up'));
    // At the top of the movable places the up button is disabled: focus goes to the down button.
    expect(document.activeElement).toBe(button('Move Diwali sweets week down'));
  });

  it('moves the over-limit line with the order', async () => {
    mount([viewOf([shop, fruit, entry('d', 'Third', { overLimit: true })], 2)]);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Third up'));
    const rows = names();
    expect(rows.indexOf('Over the limit, waits for a free place')).toBe(2);
    expect(rows[3]).toContain('Spring fruit boxes');
  });

  it('puts the order back with Discard', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(discard());
    expect(names()[1]).toContain('Shop Express');
    expect(save().disabled).toBe(true);
  });

  it('is not changed when a slide is moved back to where it was', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(button('Move Spring fruit boxes down'));
    expect(save().disabled).toBe(true);
  });
});

describe('saving', () => {
  it('sends the place and every slide in the new order, then reads again and announces it', async () => {
    const after = viewOf([pinned, fruit, shop, diwali]);
    mount([four(), after]);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]).toEqual([
      'PUT',
      'storefront/admin/slides/order',
      { position: 'home.hero', scope: 'all', scopeId: null, slideIds: ['p', 'b', 'a', 'c'] },
      'csrf-1',
    ]);
    expect((await screen.findByText(/^Order saved\./)).getAttribute('aria-live')).toBe('polite');
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(names()[1]).toContain('Spring fruit boxes');
    expect(save().disabled).toBe(true);
  });

  it('sends the scope id for one category', async () => {
    mount([four(), four()], ok({}), {
      place: { position: 'category.top', scope: 'category', scopeId: CATEGORY },
    });
    await screen.findByRole('heading', { name: 'Category · above list' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]?.[2]).toMatchObject({
      position: 'category.top',
      scope: 'category',
      scopeId: CATEGORY,
    });
  });

  it('tells the admin the list changed and loads the current one on request', async () => {
    mount([four(), viewOf([pinned, fruit])], fail(409, 'storefront.slide-order-mismatch'));
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The slides at this position changed since you opened it');
    fireEvent.click(within(alert).getByRole('button', { name: 'Load current list' }));
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(save().disabled).toBe(true);
  });

  it.each([
    [fail(403, 'access.denied'), "You don't have permission to change the order."],
    [fail(0, 'network'), 'No connection. Your order is still here; try again.'],
    [fail(500, 'unknown'), 'The order could not be saved. Try again.'],
    [
      fail(400, 'validation.failed', { fields: [{ path: 'slideIds[1]', code: 'not-found' }] }),
      'One of the slides is no longer live at this position.',
    ],
    [
      fail(400, 'validation.failed', { fields: [{ path: 'scope', code: 'enum' }] }),
      'The order was refused.',
    ],
  ])('maps a refused save to a message and keeps the order', async (answer, text) => {
    mount([four()], answer);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(save());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text);
    expect(names()[1]).toContain('Spring fruit boxes');
    expect(save().disabled).toBe(false);
  });

  it('signs out a rejected session', async () => {
    mount([four()], fail(401, 'session.invalid'));
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(save());
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('sends one request however often Save is pressed', async () => {
    mount([four(), four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.click(button('Move Spring fruit boxes up'));
    fireEvent.click(save());
    fireEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
  });

  it('shows the note about going live at once', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(
      screen.getByText(
        'Order changes go live at once for slides already approved. Buyers see the new order within a minute; the change is recorded in the history.',
      ),
    ).toBeTruthy();
  });
});

describe('permission to edit', () => {
  it('shows move buttons, Discard and Save order with the edit permission', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(screen.getAllByRole('button', { name: /^Move / })).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save order' })).toBeTruthy();
    expect(screen.queryByText('You can view the order but not change it.')).toBeNull();
  });

  it('is a read-only list without it: no move buttons, no Discard, no Save order', async () => {
    mount([four()], ok({}), { canEdit: false });
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save order' })).toBeNull();
    expect(screen.getByText('You can view the order but not change it.')).toBeTruthy();
    expect(names()).toHaveLength(4);
    expect(puts()).toHaveLength(0);
  });
});

describe('choosing the place', () => {
  it('opens another position at once', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'home.mid' } });
    expect(router.push).toHaveBeenCalledWith('/content/slides/order?position=home.mid');
  });

  it('lists the six positions, and offers a scope only where the position takes one', async () => {
    mount([four()]);
    await screen.findByRole('heading', { name: 'Home · top' });
    expect(within(screen.getByLabelText('Position')).getAllByRole('option')).toHaveLength(6);
    expect(screen.queryByLabelText('Shown on')).toBeNull();
    fireEvent.change(screen.getByLabelText('Position'), {
      target: { value: 'product.below-details' },
    });
    expect(router.push).not.toHaveBeenCalledWith(expect.stringContaining('scope=category'));
  });

  it('waits for a valid id before it opens a scope', async () => {
    mount([four()], ok({}), {
      place: { position: 'category.top', scope: 'all', scopeId: null },
    });
    await screen.findByRole('heading', { name: 'Category · above list' });
    fireEvent.change(screen.getByLabelText('Shown on'), { target: { value: 'category' } });
    expect(router.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show order' }));
    expect(screen.getByText(/^Enter a valid id/)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Category ID'), { target: { value: CATEGORY } });
    fireEvent.click(screen.getByRole('button', { name: 'Show order' }));
    expect(router.push).toHaveBeenCalledWith(
      `/content/slides/order?position=category.top&scope=category&scopeId=${CATEGORY}`,
    );
  });
});

describe('view switch', () => {
  const labels = { nav: 'Slides view', all: 'All slides', order: 'Order by position' };

  it('marks the current view with aria-current and links both pages', () => {
    render(<SlidesViewSwitch labels={labels} active="order" />);
    const nav = screen.getByRole('navigation', { name: 'Slides view' });
    expect(
      within(nav).getByRole('link', { name: 'Order by position' }).getAttribute('aria-current'),
    ).toBe('page');
    const all = within(nav).getByRole('link', { name: 'All slides' });
    expect(all.getAttribute('aria-current')).toBeNull();
    expect(all.getAttribute('href')).toBe('/content/slides');
    expect(within(nav).getByRole('link', { name: 'Order by position' }).getAttribute('href')).toBe(
      '/content/slides/order?position=home.hero',
    );
  });

  it('marks All slides on the list page', () => {
    render(<SlidesViewSwitch labels={labels} active="all" />);
    expect(screen.getByRole('link', { name: 'All slides' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
});
