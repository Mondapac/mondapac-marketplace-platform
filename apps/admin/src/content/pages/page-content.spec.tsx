// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { PageContent } from './page-content.tsx';
import type { PageDetail } from './page-types.ts';
import { BANNER, ID, SHELF_A, SHELF_B, page } from './test-data.ts';

const call = vi.mocked(callApi);
const API = `storefront/admin/pages/${ID}`;

function mount(detail: PageDetail = page(), canEdit = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PageContent page={detail} canEdit={canEdit} csrfToken="csrf-1" zone="Australia/Brisbane" />
    </NextIntlClientProvider>,
  );
}
const ok = (body: PageDetail) => ({ ok: true as const, status: 200, body });
const refused = (code: string, status = 409, fields?: { path: string; code: string }[]) => ({
  ok: false as const,
  failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
});
const sent = () => call.mock.calls.map(([method, path, body]) => [method, path, body]);

/** The page with one change applied, as the API answers it. */
const withPlacements = (placements: PageDetail['draft']['placements']): PageDetail => {
  const base = page();
  return { ...base, draft: { ...base.draft, placements } };
};

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no modal <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const slot = (name: string) => screen.getByRole('region', { name });
const dialog = () => screen.getByRole('dialog', { hidden: true });

describe('the Content tab', () => {
  it('shows the slots of the template in order with their size and what each module holds', () => {
    mount();
    const names = screen
      .getAllByRole('heading', { level: 2 })
      .map((heading) => heading.textContent);
    expect(names).toEqual(['Hero', 'Main', 'Bottom']);
    expect(within(slot('Hero')).getByText('1 of 1 · at least 1')).toBeTruthy();
    expect(within(slot('Main')).getByText('2 of 8 · at least 1')).toBeTruthy();
    expect(within(slot('Bottom')).getByText('0 of 2')).toBeTruthy();
    expect(within(slot('Bottom')).getByText(/No modules yet/)).toBeTruthy();
    expect(within(slot('Hero')).getByText('Ramadan')).toBeTruthy();
    expect(within(slot('Main')).getByText('Bestsellers, up to 12')).toBeTruthy();
    expect(within(slot('Main')).getByText('Chosen products, up to 6')).toBeTruthy();
  });

  it('marks a hidden module', () => {
    const detail = page();
    mount(
      withPlacements({
        ...detail.draft.placements,
        hero: [{ ...detail.draft.placements.hero![0]!, enabled: false }],
      }),
    );
    expect(within(slot('Hero')).getByText('Hidden')).toBeTruthy();
    expect(
      within(slot('Hero'))
        .getByRole('switch', { name: 'Show Banner to buyers' })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('shows a fixed slot of a system page as filled by the app, with no Add', () => {
    mount(
      page({
        kind: 'system',
        id: null,
        systemKey: 'search',
        templateKey: 'system.search',
        slots: [
          { key: 'top', kind: 'modules', modules: ['banner'], min: 0, max: 1, width: 'full' },
          { key: 'results', kind: 'fixed', modules: [], min: 0, max: 0, width: 'full' },
        ],
        draft: { ...page().draft, placements: { top: [], results: [] } },
      }),
    );
    expect(screen.getByText(/header, bottom bar and footer are set by the app/)).toBeTruthy();
    expect(within(slot('Search results')).getByText(/Filled by the app/)).toBeTruthy();
    expect(within(slot('Search results')).queryByRole('button')).toBeNull();
    expect(within(slot('Top')).getByRole('button', { name: 'Add module' })).toBeTruthy();
  });

  it('has no controls, and says why, without the edit key, on an archived page and on a locked page', () => {
    mount(page(), false);
    expect(screen.getByText(/view this page but not change it/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add module' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
    cleanup();
    mount(page({ status: 'archived' }));
    expect(screen.getByText(/page is archived/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    cleanup();
    mount(page({ editLevel: 'locked' }));
    expect(screen.getByText(/page is locked in the app/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('changes to the draft', () => {
  it('hides and shows a module with the switch', async () => {
    const detail = page();
    call.mockResolvedValue(
      ok(
        withPlacements({
          ...detail.draft.placements,
          hero: [{ ...detail.draft.placements.hero![0]!, enabled: false }],
        }),
      ),
    );
    mount();
    fireEvent.click(within(slot('Hero')).getByRole('switch', { name: 'Show Banner to buyers' }));
    await within(slot('Hero')).findByText('Hidden');
    expect(sent()).toEqual([['PUT', `${API}/slots/hero/modules/${BANNER}`, { enabled: false }]]);
  });

  it('moves a module down and sends the whole new order of the slot', async () => {
    const detail = page();
    const main = detail.draft.placements.main!;
    call.mockResolvedValue(
      ok(withPlacements({ ...detail.draft.placements, main: [main[1]!, main[0]!] })),
    );
    mount();
    const first = within(slot('Main')).getAllByRole('button', {
      name: /Move Product shelf down/,
    })[0]!;
    fireEvent.click(first);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([
      ['PUT', `${API}/slots/main/order`, { placementIds: [SHELF_B, SHELF_A] }],
    ]);
    // The answer puts the second shelf first.
    await waitFor(() =>
      expect(within(slot('Main')).getAllByRole('listitem')[0]?.textContent).toContain(
        'Chosen products',
      ),
    );
    // The first module cannot go up, the last cannot go down.
    const ups = within(slot('Main')).getAllByRole('button', { name: /Move Product shelf up/ });
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    const downs = within(slot('Main')).getAllByRole('button', { name: /Move Product shelf down/ });
    expect((downs[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('removes a module only after it is confirmed, and not when the slot is at its minimum', async () => {
    const detail = page();
    const main = detail.draft.placements.main!;
    call.mockResolvedValue(ok(withPlacements({ ...detail.draft.placements, main: [main[1]!] })));
    mount();
    // The hero holds its one required banner: Remove is off.
    fireEvent.click(within(slot('Hero')).getByRole('button', { name: 'More actions for Banner' }));
    expect(screen.getByRole('menuitem', { name: /Remove/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    // A shelf of the main slot can go.
    fireEvent.click(
      within(slot('Main')).getAllByRole('button', { name: 'More actions for Product shelf' })[0]!,
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove' }));
    expect(call).not.toHaveBeenCalled();
    expect(within(dialog()).getByText('Remove Product shelf?')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(sent()).toEqual([['DELETE', `${API}/slots/main/modules/${SHELF_A}`, undefined]]),
    );
    await waitFor(() => expect(within(slot('Main')).getAllByRole('listitem')).toHaveLength(1));
  });

  it('edits a module in a dialog and saves only what is filled in', async () => {
    const detail = page();
    call.mockResolvedValue(ok(detail));
    mount();
    fireEvent.click(within(slot('Hero')).getByRole('button', { name: /Edit/ }));
    const form = within(dialog());
    expect(form.getByRole('heading', { name: 'Edit Banner' })).toBeTruthy();
    expect(form.getByLabelText<HTMLInputElement>(/^Title/).value).toBe('Ramadan');
    fireEvent.change(form.getByLabelText(/^Title/), { target: { value: 'Eid specials' } });
    fireEvent.change(form.getByLabelText(/^Subtitle/), { target: { value: '  ' } });
    fireEvent.change(form.getByLabelText(/^Link/), { target: { value: '/offers' } });
    fireEvent.click(form.getByRole('button', { name: 'Save to draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([
      [
        'PUT',
        `${API}/slots/hero/modules/${BANNER}`,
        {
          config: {
            title: 'Eid specials',
            image: { ref: 'fruits', alt: 'Fruit' },
            href: '/offers',
          },
        },
      ],
    ]);
    // The dialog is gone once the draft is saved.
    await waitFor(() => expect(screen.queryByText('Edit Banner')).toBeNull());
  });

  it('adds a module the slot allows, starting from its blank settings', async () => {
    call.mockResolvedValue(ok(page()));
    mount();
    fireEvent.click(within(slot('Bottom')).getByRole('button', { name: 'Add module' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'FAQ' }));
    const form = within(dialog());
    expect(form.getByRole('heading', { name: 'Add FAQ' })).toBeTruthy();
    fireEvent.change(form.getByLabelText(/^Question/), { target: { value: 'Is it halal?' } });
    fireEvent.change(form.getByLabelText(/^Text/), { target: { value: 'Yes.' } });
    fireEvent.click(form.getByRole('button', { name: 'Save to draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([
      [
        'POST',
        `${API}/slots/bottom/modules`,
        {
          module: 'faq',
          config: { items: [{ question: 'Is it halal?', answer: [{ text: 'Yes.' }] }] },
        },
      ],
    ]);
  });

  it('offers only the modules of the slot, and no Add when the slot is full', () => {
    mount();
    fireEvent.click(within(slot('Bottom')).getByRole('button', { name: 'Add module' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'FAQ',
      'Text',
    ]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(
      within(slot('Hero')).getByRole<HTMLButtonElement>('button', { name: 'Add module' }).disabled,
    ).toBe(true);
  });

  it('shows the field the API refused, keeps the dialog open and keeps what was typed', async () => {
    call.mockResolvedValue(
      refused('validation.failed', 400, [{ path: 'config.title', code: 'required' }]),
    );
    mount();
    fireEvent.click(within(slot('Hero')).getByRole('button', { name: /Edit/ }));
    const form = within(dialog());
    fireEvent.change(form.getByLabelText(/^Title/), { target: { value: '' } });
    fireEvent.change(form.getByLabelText(/^Subtitle/), { target: { value: 'Kept' } });
    fireEvent.click(form.getByRole('button', { name: 'Save to draft' }));
    await form.findByText('Fill this in.');
    expect(form.getByText('Check the marked fields and try again.')).toBeTruthy();
    expect(form.getByLabelText(/^Title/).getAttribute('aria-invalid')).toBe('true');
    expect(form.getByLabelText<HTMLInputElement>(/^Subtitle/).value).toBe('Kept');
  });

  it('asks for a reload when the page changed under the editor', async () => {
    call.mockResolvedValue(refused('storefront.placement-not-found', 404));
    mount();
    fireEvent.click(within(slot('Hero')).getByRole('switch', { name: 'Show Banner to buyers' }));
    await screen.findByText(/changed since you opened it/);
    fireEvent.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('closes a dialog and offers the reload when the page changed under it', async () => {
    call.mockResolvedValue(refused('storefront.placement-not-found', 404));
    mount();
    fireEvent.click(within(slot('Hero')).getByRole('button', { name: /Edit/ }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save to draft' }));
    await screen.findByRole('button', { name: 'Reload the page' });
    expect(screen.queryByText('Edit Banner')).toBeNull();
  });

  it.each([
    ['storefront.page-locked', 409, /locked in the app and cannot be changed/],
    ['storefront.page-archived', 409, /archived page cannot be changed/],
    ['storefront.slot-full', 409, /part is full/],
    ['access.denied', 403, /permission to change pages/],
    ['network', 0, /No connection/],
    ['mystery', 500, /could not be saved/],
  ])('words the refusal %s', async (code, status, words) => {
    call.mockResolvedValue(refused(code, status));
    mount();
    fireEvent.click(within(slot('Hero')).getByRole('switch', { name: 'Show Banner to buyers' }));
    await screen.findByText(words);
  });

  it('goes to the sign-in page when the session ended', async () => {
    call.mockResolvedValue(refused('session.required', 401));
    mount();
    fireEvent.click(within(slot('Hero')).getByRole('switch', { name: 'Show Banner to buyers' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('ignores a second press while a change is being saved', async () => {
    let finish: (value: ReturnType<typeof ok>) => void = () => undefined;
    call.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    mount();
    const toggle = within(slot('Hero')).getByRole('switch', { name: 'Show Banner to buyers' });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(call).toHaveBeenCalledTimes(1);
    finish(ok(page()));
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows a module this editor has no form for by its raw name, without Edit', () => {
    const detail = page();
    mount(
      withPlacements({
        ...detail.draft.placements,
        bottom: [{ id: 'z', module: 'mystery', enabled: true, config: {} }],
      }),
    );
    expect(within(slot('Bottom')).getByText('mystery')).toBeTruthy();
    expect(within(slot('Bottom')).queryByRole('button', { name: /Edit/ })).toBeNull();
  });
});
