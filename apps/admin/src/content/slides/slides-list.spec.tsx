// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { summary } from './test-data.ts';
import {
  SLIDE_EDIT_PERMISSION,
  SLIDE_PUBLISH_PERMISSION,
  SLIDE_READ_PERMISSION,
  type SlideSummary,
} from './slide-types.ts';
import { SlidesList } from './slides-list.tsx';

const call = vi.mocked(callApi);
const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000a2';
const C = '0190a000-0000-7000-8000-0000000000a3';
const D = '0190a000-0000-7000-8000-0000000000a4';
const E = '0190a000-0000-7000-8000-0000000000a5';

const slides: SlideSummary[] = [
  summary({
    id: E,
    internalName: 'Black Friday teaser',
    status: 'draft',
    positions: [],
    updatedAt: '2026-10-24T00:00:00Z',
  }),
  summary({
    id: D,
    internalName: 'New minimum order rule',
    kind: 'announcement',
    status: 'paused',
    positions: ['cart.below-lines'],
  }),
  summary({
    id: C,
    internalName: 'Fresh lamb, 15% off',
    status: 'pending',
    sponsored: true,
    positions: ['home.mid'],
  }),
  summary({
    id: B,
    internalName: 'Diwali sweets week',
    status: 'scheduled',
    startsAt: '2026-10-27T00:00:00Z',
    positions: ['home.hero', 'category.top'],
  }),
  summary({
    id: A,
    internalName: 'Storm delivery delays',
    kind: 'announcement',
    status: 'live',
    pinned: true,
    positions: ['home.hero', 'cart.below-lines'],
  }),
];

function mount(
  permissionKeys: string[] = [SLIDE_READ_PERMISSION, SLIDE_EDIT_PERMISSION],
  zone = 'Australia/Brisbane',
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SlidesList permissionKeys={permissionKeys} zone={zone} />
    </NextIntlClientProvider>,
  );
}

const rowOf = (name: string) => screen.getByRole('link', { name }).closest('tr')!;
const names = () =>
  screen
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('link')[0]?.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  call.mockResolvedValue({ ok: true, status: 200, body: { slides } });
});
afterEach(cleanup);

describe('slides list', () => {
  it('asks the API once and shows a skeleton until the answer arrives', async () => {
    mount();
    expect(screen.getByRole('status').textContent).toContain('Loading slides');
    await screen.findByRole('table');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('GET', 'storefront/admin/slides');
  });

  it('sorts live and scheduled first, then waiting, drafts, paused', async () => {
    mount();
    await screen.findByRole('table');
    expect(names()).toEqual([
      'Storm delivery delays',
      'Diwali sweets week',
      'Fresh lamb, 15% off',
      'Black Friday teaser',
      'New minimum order rule',
    ]);
  });

  it('lines the header cells up with the body cells: one column each, same order', async () => {
    mount();
    await screen.findByRole('table');
    const heads = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(heads).toEqual(['Slide', 'Type', 'Positions', 'Live window', 'Status', 'Action']);
    for (const row of screen.getAllByRole('row').slice(1)) {
      expect(within(row).getAllByRole('cell')).toHaveLength(heads.length);
    }
    expect(document.querySelectorAll('colgroup col')).toHaveLength(heads.length);
  });

  it('shows type, position chips, window in the given zone, status and a short line', async () => {
    mount();
    await screen.findByRole('table');
    const storm = rowOf('Storm delivery delays');
    expect(within(storm).getByText('Announcement')).toBeTruthy();
    expect(within(storm).getByText('Home · top')).toBeTruthy();
    expect(within(storm).getByText('Cart · below items')).toBeTruthy();
    expect(within(storm).getByText('Live')).toBeTruthy();
    expect(within(storm).getByText('Pinned')).toBeTruthy();
    // 2026-10-23T20:00Z is 6:00 am on 24 Oct in Brisbane (UTC+10).
    expect(storm.textContent).toMatch(/24 Oct, 6:00 am – 26 Oct, 11:59 pm/);
    expect(screen.getByText(/Times in Australia\/Brisbane/)).toBeTruthy();
    const draft = rowOf('Black Friday teaser');
    expect(within(draft).getByText('No position')).toBeTruthy();
    expect(within(draft).getByText('Not placed yet')).toBeTruthy();
    const lamb = rowOf('Fresh lamb, 15% off');
    expect(within(lamb).getByText('Sponsored')).toBeTruthy();
    expect(within(lamb).getByText('Waiting for approval')).toBeTruthy();
  });

  it('reads a time in UTC when the holder has no zone of their own', async () => {
    mount([SLIDE_READ_PERMISSION], 'UTC');
    await screen.findByRole('table');
    expect(screen.getByText(/Times in UTC/)).toBeTruthy();
    expect(rowOf('Storm delivery delays').textContent).toMatch(/23 Oct, 8:00 pm/);
  });

  it('filters by type in the browser, without asking the API again', async () => {
    mount();
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Announcement' }));
    expect(names()).toEqual(['Storm delivery delays', 'New minimum order rule']);
    expect(screen.getByRole('button', { name: 'Announcement' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(names()).toHaveLength(5);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('searches the internal name in the browser, ignoring case', async () => {
    mount();
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'DIWALI' } });
    expect(names()).toEqual(['Diwali sweets week']);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('sends the position and the status to the API as the query', async () => {
    mount();
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'home.hero' } });
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith('GET', 'storefront/admin/slides?position=home.hero'),
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'live' } });
    await waitFor(() =>
      expect(call).toHaveBeenLastCalledWith(
        'GET',
        'storefront/admin/slides?state=live&position=home.hero',
      ),
    );
  });

  it('shows "no match" with a way to clear the filters', async () => {
    mount();
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search by name'), {
      target: { value: 'nothing like this' },
    });
    expect(screen.getByRole('heading', { name: 'No slides match' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(names()).toHaveLength(5);
  });

  it('shows the empty state with the note and no filters or duplicate New slide button', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { slides: [] } });
    mount();
    expect(await screen.findByRole('heading', { name: 'No slides yet' })).toBeTruthy();
    expect(screen.getByText('Without slides, the home page shows its title only.')).toBeTruthy();
    expect(screen.queryByRole('search')).toBeNull();
    expect(screen.queryByRole('link', { name: 'New slide' })).toBeNull();
  });

  it('keeps the filters when a filter leaves nothing', async () => {
    mount();
    await screen.findByRole('table');
    call.mockResolvedValue({ ok: true, status: 200, body: { slides: [] } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ended' } });
    expect(await screen.findByRole('heading', { name: 'No slides match' })).toBeTruthy();
    expect(screen.getByRole('search')).toBeTruthy();
  });

  it('never breaks a date inside the live window, only before the dash', async () => {
    mount();
    await screen.findByRole('table');
    const spans = [
      ...rowOf('Storm delivery delays').querySelectorAll('span.text-xs > span.whitespace-nowrap'),
    ];
    expect(spans.map((span) => span.textContent)).toEqual([
      '24 Oct, 6:00 am',
      '– 26 Oct, 11:59 pm',
    ]);
  });

  it('shows a load error with a retry that asks again', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 500, code: 'unknown' } });
    mount();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Slides could not be loaded');
    expect(screen.queryByRole('table')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('table');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('sends a signed-out reader to the session page', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 401, code: 'access.unauthenticated' },
    });
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});

describe('row action by permission', () => {
  const action = (name: string) => {
    const row = rowOf(name);
    return within(row).getAllByRole('link').at(-1)!;
  };

  it('links to the editor: Edit for an editor, no Pause or Resume buttons', async () => {
    mount();
    await screen.findByRole('table');
    expect(action('Storm delivery delays').textContent).toContain('Edit');
    expect(action('Storm delivery delays').getAttribute('href')).toBe(`/content/slides/${A}`);
    expect(screen.queryByRole('button', { name: /pause|resume/i })).toBeNull();
  });

  it('says View when the reader may not edit', async () => {
    mount([SLIDE_READ_PERMISSION]);
    await screen.findByRole('table');
    expect(action('Storm delivery delays').textContent).toContain('View');
    expect(action('Fresh lamb, 15% off').textContent).toContain('View');
  });

  it('says Review on a slide waiting for approval only for someone who can approve', async () => {
    mount([SLIDE_READ_PERMISSION, SLIDE_EDIT_PERMISSION]);
    await screen.findByRole('table');
    expect(action('Fresh lamb, 15% off').textContent).toContain('Edit');
    cleanup();
    mount([SLIDE_READ_PERMISSION, SLIDE_EDIT_PERMISSION, SLIDE_PUBLISH_PERMISSION]);
    await screen.findByRole('table');
    expect(action('Fresh lamb, 15% off').textContent).toContain('Review');
    expect(action('Storm delivery delays').textContent).toContain('Edit');
  });
});
