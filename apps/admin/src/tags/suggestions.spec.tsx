// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

import { callApi, type ApiResult } from '../api/client.ts';
import { suggestionProblemOf } from './suggestion-errors.ts';
import { SuggestionsView } from './suggestions-view.tsx';
import type { Locales } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Two Markets: a test that only passes for AU is a bug. */
const MARKETS: readonly { readonly name: string; readonly locales: Locales }[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { name: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP', 'fa-IR'] } },
];

let granted: readonly string[] = ['approve', 'map', 'reject'];
const list = (
  locales: Locales,
  labels: readonly string[] = ['<b>Eid</b> gifts'],
  total: number = labels.length,
  hasNext = false,
) => ({
  locales,
  requiredLocales: [locales.default],
  total,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext,
  items: labels.map((label, index) => ({
    id: id(index + 1),
    version: 3 + index,
    label,
    createdAt: '2026-11-03T10:00:00.000Z',
    sellerId: id(9),
    productId: id(8),
    productCode: index === 0 ? 'SKU-1' : null,
    suggestedSlug: 'eid-gifts',
    actions: granted,
  })),
});

const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (
  status: number,
  code: string,
  fields?: { path: string; code: string }[],
): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(fields === undefined ? {} : { details: { fields } }) },
});
const decided = (status: 'approved' | 'mapped' | 'rejected') =>
  ok({ suggestion: { id: id(1), status, version: 4, topicId: null } });

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SuggestionsView csrfToken="csrf-1" paging="pages" accountId={id(99)} marketId="AU" />
    </NextIntlClientProvider>,
  );
}
const LABEL = '<b>Eid</b> gifts';
const click = async (name: string) => fireEvent.click(await screen.findByRole('button', { name }));
/** Opens the row's Actions menu and picks an item: no row action is a button in the row. */
async function act(label: string, item: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${label}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
}
const posts = () => call.mock.calls.filter(([method]) => method === 'POST');

beforeEach(() => {
  granted = ['approve', 'map', 'reject'];
  // The search select asks whether the screen is a phone (jsdom has no matchMedia).
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(MARKETS)('tag suggestions list ($name)', ({ locales }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockReset();
  });

  it('shows the seller words as plain text with product, seller and the section tabs', async () => {
    call.mockResolvedValue(ok(list(locales)));
    mount();
    expect(await screen.findByText(LABEL)).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Tag suggestions' })).toBeTruthy();
    expect(screen.getByText('SKU-1')).toBeTruthy();
    const seller = screen.getByRole('link', { name: id(9).slice(0, 8) });
    expect(seller.getAttribute('href')).toBe(`/sellers/${id(9)}`);
    expect(screen.getByRole('link', { name: 'Suggestions' }).getAttribute('href')).toBe(
      '/catalog/tags/suggestions',
    );
    expect(screen.getByRole('link', { name: 'Tags' }).getAttribute('href')).toBe('/catalog/tags');
    const first = new URLSearchParams(call.mock.calls[0]?.[1].split('?')[1]);
    expect(first.get('page')).toBe('1');
    expect(first.get('paging')).toBe('pages');
    expect(first.get('sort')).toBe('created');
    expect(first.get('direction')).toBe('asc');
  });

  it('names a suggestion without a product, and never says topic in the page text', async () => {
    call.mockResolvedValue(ok(list(locales, ['A', 'B'])));
    mount();
    expect(await screen.findByText('No product code')).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('topic');
  });

  it('shows the empty state and a load error', async () => {
    call.mockResolvedValue(ok(list(locales, [])));
    mount();
    expect(await screen.findByText('No tag suggestions waiting')).toBeTruthy();
    cleanup();
    call.mockResolvedValue(fail(500, 'unknown'));
    mount();
    expect(await screen.findByText(/Could not load tag suggestions/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('searches the seller words on the server and moves to the next page', async () => {
    call.mockResolvedValue(ok(list(locales, ['One'], 40, true)));
    mount();
    await screen.findByText('One');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search suggestions' }), {
      target: { value: 'eid' },
    });
    await waitFor(() => expect(call.mock.calls.at(-1)?.[1]).toContain('q=eid'));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(call.mock.calls.at(-1)?.[1]).toContain('page=2'));
  });

  it('keeps every decision in the Actions menu, as many as the API names for the row', async () => {
    call.mockResolvedValue(ok(list(locales)));
    mount();
    await screen.findByText(LABEL);
    expect(screen.queryByRole('button', { name: /^(Approve|Reject|Map)/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${LABEL}` }));
    expect(await screen.findByRole('menuitem', { name: 'Approve…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Map to existing tag…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Reject…' })).toBeTruthy();
    cleanup();
    granted = ['map', 'reject'];
    call.mockResolvedValue(ok(list(locales)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${LABEL}` }));
    expect(await screen.findByRole('menuitem', { name: 'Map to existing tag…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Approve…' })).toBeNull();
  });

  it('approves with the group, name and slug, the version seen, and the CSRF token', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Approve…');
    const dialog = await screen.findByRole('dialog', { name: `Approve “${LABEL}”?` });
    // Focus starts on Cancel, not on the red button.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog).getByLabelText<HTMLInputElement>(/Tag name/).value).toBe(LABEL);
    expect(within(dialog).getByLabelText<HTMLInputElement>('Slug').value).toBe('eid-gifts');
    expect(within(dialog).getByText(/default language/)).toBeTruthy();
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Create tag' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Tag name/), {
      target: { value: ' Eid gifts ' },
    });
    fireEvent.change(within(dialog).getByLabelText(/Group/), { target: { value: 'occasion' } });
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: ' Eid-Gifts ' } });
    expect(confirm.disabled).toBe(false);
    call.mockResolvedValueOnce(decided('approved'));
    call.mockResolvedValueOnce(ok(list(locales, [])));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(posts()[0]).toEqual([
      'POST',
      `catalog/admin/topic-suggestions/${id(1)}/approve`,
      { version: 3, group: 'occasion', name: 'Eid gifts', slug: 'eid-gifts' },
      'csrf-1',
    ]);
    await expectToast('Tag created. The seller has been emailed.');
  });

  it('omits an emptied slug and blocks a bad one', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Approve…');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Group/), { target: { value: 'use' } });
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'bad--slug' } });
    expect(
      within(dialog).getByText('Use lower case letters, digits and single hyphens.'),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Create tag' }).disabled,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: '' } });
    call.mockResolvedValueOnce(decided('approved'));
    call.mockResolvedValueOnce(ok(list(locales, [])));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]?.[2]).toEqual({ version: 3, group: 'use', name: LABEL });
  });

  it('maps to an existing active tag found by search', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    const tags = {
      items: [
        {
          id: id(5),
          slug: 'eid',
          group: 'occasion',
          status: 'active',
          names: { [locales.default]: 'Eid' },
          synonyms: {},
          intro: null,
          createdAt: '',
          updatedAt: '',
          version: 1,
        },
      ],
      nextAfterId: null,
      locales,
      groups: [],
      maxSynonyms: 10,
    };
    call.mockResolvedValue(ok(tags));
    await act(LABEL, 'Map to existing tag…');
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(call.mock.calls[1]?.[1]).toBe('catalog/admin/topics?status=active&limit=25'),
    );
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Map tag' });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /Eid/ }));
    expect(confirm.disabled).toBe(false);
    call.mockReset();
    call.mockResolvedValueOnce(decided('mapped'));
    call.mockResolvedValueOnce(ok(list(locales, [])));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(call.mock.calls[0]).toEqual([
      'POST',
      `catalog/admin/topic-suggestions/${id(1)}/map`,
      { version: 3, topicId: id(5) },
      'csrf-1',
    ]);
    await expectToast('Suggestion mapped to the tag. The seller has been emailed.');
  });

  it('disables mapping when there is no active tag, and shows a picker error', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    call.mockResolvedValue(
      ok({ items: [], nextAfterId: null, locales, groups: [], maxSynonyms: 10 }),
    );
    await act(LABEL, 'Map to existing tag…');
    expect(await screen.findByText('There are no active tags to map to.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Map tag' }).disabled).toBe(true);
    await click('Cancel');
    call.mockResolvedValue(fail(500, 'unknown'));
    await act(LABEL, 'Map to existing tag…');
    fireEvent.click(await screen.findByRole('combobox'));
    expect(await screen.findByText('Could not load tags. Try again.')).toBeTruthy();
  });

  it('rejects with a reason, counted, and sends the trimmed reason', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Reject…');
    const dialog = await screen.findByRole('dialog', { name: `Reject “${LABEL}”?` });
    expect(within(dialog).getByText('0 / 300')).toBeTruthy();
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Reject suggestion',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '  Too broad ' } });
    expect(within(dialog).getByText('12 / 300')).toBeTruthy();
    call.mockResolvedValueOnce(decided('rejected'));
    call.mockResolvedValueOnce(ok(list(locales, [])));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(posts()[0]).toEqual([
      'POST',
      `catalog/admin/topic-suggestions/${id(1)}/reject`,
      { version: 3, reason: 'Too broad' },
      'csrf-1',
    ]);
    await expectToast('Suggestion rejected. The seller has been emailed.');
  });

  it('sends nothing when the dialog is cancelled', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Reject…');
    await click('Cancel');
    expect(screen.queryByRole('dialog', { name: /Reject/ })).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('sends a decision once on a double click and locks the field while it runs', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Reject…');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(decided('rejected'));
    call.mockResolvedValue(ok(list(locales, [])));
    const button = within(dialog).getByRole('button', { name: 'Reject suggestion' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(within(dialog).getByRole<HTMLTextAreaElement>('textbox').readOnly).toBe(true);
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(posts()).toHaveLength(1);
  });

  it.each([
    ['suggestion.stale', 409],
    ['suggestion.not-open', 409],
    ['suggestion.not-found', 404],
  ])('refreshes the list with a notice on %s', async (code, status) => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Reject…');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(fail(status, code));
    call.mockResolvedValueOnce(ok(list(locales, [])));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject suggestion' }));
    await expectToast(
      'That suggestion was already decided or changed by someone else. The list has been refreshed.',
      'error',
    );
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('creates tags from the ticked suggestions in one group, and says what was skipped', async () => {
    call.mockResolvedValueOnce(ok(list(locales, ['One', 'Two'])));
    mount();
    await screen.findByText('One');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select One' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select Two' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create tags from 2 suggestions?' });
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Create 2 tags',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Group/), { target: { value: 'occasion' } });
    call.mockResolvedValueOnce(
      ok({ action: 'approve', counts: { done: 1, skipped: 1, failed: 0 }, results: [] }),
    );
    call.mockResolvedValueOnce(ok(list(locales, ['Two'])));
    fireEvent.click(confirm);
    expect(await within(dialog).findByText('1 row decided, 1 skipped.')).toBeTruthy();
    expect(posts()[0]).toEqual([
      'POST',
      'catalog/admin/topic-suggestions/bulk-decide',
      {
        action: 'approve',
        items: [
          { id: id(1), version: 3 },
          { id: id(2), version: 4 },
        ],
        group: 'occasion',
      },
      'csrf-1',
    ]);
  });

  it('rejects the ticked suggestions only with a reason, and refuses more than 50 at once', async () => {
    call.mockResolvedValueOnce(ok(list(locales, ['One'])));
    mount();
    await screen.findByText('One');
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Select One' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reject ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reject 1 suggestion?' });
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Reject 1 suggestion',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Too broad' } });
    call.mockResolvedValueOnce(fail(413, 'batch.too-large'));
    fireEvent.click(confirm);
    expect(await within(dialog).findByText('At most 50 rows can be decided at once.')).toBeTruthy();
    expect(posts()[0]?.[2]).toEqual({
      action: 'reject',
      items: [{ id: id(1), version: 3 }],
      reason: 'Too broad',
    });
  });

  it('keeps the dialog and its inputs open on a refusal the admin can fix', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Approve…');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Group/), { target: { value: 'use' } });
    call.mockResolvedValueOnce(
      fail(422, 'topic.claim-word', [{ path: 'name', code: 'claim-word' }]),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(
      await within(dialog).findByText(
        'A tag name cannot claim a certification such as halal or organic. Change the name or slug.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Check this field.')).toBeTruthy();
    expect(within(dialog).getByLabelText<HTMLInputElement>(/Tag name/).value).toBe(LABEL);
  });

  it('offers Map to existing tag when the name is taken, and switches the dialog to it', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await act(LABEL, 'Approve…');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Group/), { target: { value: 'use' } });
    call.mockResolvedValueOnce(fail(409, 'topic.term-taken'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create tag' }));
    expect(
      await within(dialog).findByText(/already exists. Map the suggestion to it instead/),
    ).toBeTruthy();
    call.mockResolvedValue(
      ok({ items: [], nextAfterId: null, locales, groups: [], maxSynonyms: 10 }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Map to existing tag…' }));
    expect(
      await screen.findByRole('dialog', { name: `Map “${LABEL}” to an existing tag?` }),
    ).toBeTruthy();
  });
});

describe('suggestion errors', () => {
  const cases: readonly [string, number, string, boolean][] = [
    ['validation.failed', 400, 'invalid', false],
    ['suggestion.label-invalid', 422, 'invalid', false],
    ['suggestion.reason-invalid', 422, 'invalid', false],
    ['topic.claim-word', 422, 'claim-word', false],
    ['topic.locale-uncheckable', 422, 'locale-uncheckable', false],
    ['topic.term-taken', 409, 'term-taken', false],
    ['topic.slug-taken', 409, 'term-taken', false],
    ['suggestion.topic-invalid', 422, 'topic-invalid', false],
    ['suggestion.stale', 409, 'stale', true],
    ['suggestion.not-open', 409, 'stale', true],
    ['suggestion.not-found', 404, 'stale', true],
    ['access.denied', 403, 'denied', false],
    ['request.csrf', 403, 'csrf', false],
    ['request.throttled', 429, 'throttled', false],
    ['network', 0, 'unavailable', false],
    ['anything', 503, 'unavailable', false],
    ['anything', 418, 'unknown', false],
  ];
  it.each(cases)('maps %s (%i) to %s', (code, status, key, reload) => {
    const problem = suggestionProblemOf({ status, code });
    expect(problem.key).toBe(key);
    expect(problem.reload).toBe(reload);
    expect(`tags.suggestions.error.${key}` in {}).toBe(false);
    const errors = messages.tags.suggestions.error as Record<string, string>;
    const notices = messages.tags.suggestions.notice as Record<string, string>;
    expect(errors[key] ?? notices[key]).toBeTruthy();
  });
});
