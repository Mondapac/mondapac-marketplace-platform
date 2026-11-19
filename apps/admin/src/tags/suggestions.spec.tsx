// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { suggestionProblemOf } from './suggestion-errors.ts';
import type { SuggestionList } from './suggestion-types.ts';
import { SuggestionsView } from './suggestions-view.tsx';
import type { Locales } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Two Markets: a test that only passes for AU is a bug. */
const MARKETS: readonly { readonly name: string; readonly locales: Locales }[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { name: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP', 'fa-IR'] } },
];

const list = (
  locales: Locales,
  labels: readonly string[] = ['<b>Eid</b> gifts'],
): SuggestionList => ({
  locales,
  requiredLocales: [locales.default],
  items: labels.map((label, index) => ({
    id: id(index + 1),
    version: 3 + index,
    label,
    createdAt: '2026-11-03T10:00:00.000Z',
    sellerId: id(9),
    productId: id(8),
    productCode: index === 0 ? 'SKU-1' : null,
    suggestedSlug: 'eid-gifts',
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

function mount(canApprove = true, noAccess: React.ReactNode = <p>no access here</p>) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SuggestionsView canApprove={canApprove} csrfToken="csrf-1" noAccess={noAccess} />
    </NextIntlClientProvider>,
  );
}
const LABEL = '<b>Eid</b> gifts';
const click = async (name: string) => fireEvent.click(await screen.findByRole('button', { name }));

beforeEach(() => {
  // The search select asks whether the screen is a phone (jsdom has no matchMedia).
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(MARKETS)('tag suggestions queue ($name)', ({ locales }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockReset();
  });

  it('shows a skeleton while loading, then the card as plain text with meta and count', async () => {
    call.mockResolvedValue(ok(list(locales)));
    mount();
    expect(screen.getByText('Loading tag suggestions')).toBeTruthy();
    expect(await screen.findByText(`“${LABEL}”`)).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Tag suggestions' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3 }).textContent).toBe(`“${LABEL}”`);
    expect(screen.getByRole('list', { name: 'Open tag suggestions' })).toBeTruthy();
    expect(screen.getByText('1 waiting')).toBeTruthy();
    expect(screen.getByText('Open')).toBeTruthy();
    expect(screen.getByText('Product SKU-1')).toBeTruthy();
    const seller = screen.getByRole('link', { name: id(9).slice(0, 8) });
    expect(seller.getAttribute('href')).toBe(`/sellers/${id(9)}`);
    expect(screen.getByRole('link', { name: 'Suggestions (1)' }).getAttribute('href')).toBe(
      '/catalog/tags/suggestions',
    );
    expect(screen.getByRole('link', { name: 'Tags' }).getAttribute('href')).toBe('/catalog/tags');
    expect(call.mock.calls[0]).toEqual(['GET', 'catalog/admin/topic-suggestions']);
  });

  it('names an unknown product and never says topic in the page text', async () => {
    call.mockResolvedValue(ok(list(locales, ['A', 'B'])));
    mount();
    expect(await screen.findByText('Product unknown product')).toBeTruthy();
    expect(document.body.textContent?.toLowerCase()).not.toContain('topic');
    expect(
      Array.from(document.querySelectorAll('[aria-label]')).some((element) =>
        /topic/i.test(element.getAttribute('aria-label') ?? ''),
      ),
    ).toBe(false);
  });

  it('shows the empty state', async () => {
    call.mockResolvedValue(ok({ ...list(locales), items: [] }));
    mount();
    expect(await screen.findByText('No tag suggestions waiting')).toBeTruthy();
    expect(screen.getByText('When a seller suggests a tag you will see it here.')).toBeTruthy();
  });

  it('shows a retry when the list cannot be read', async () => {
    call.mockResolvedValueOnce(fail(500, 'unknown'));
    mount();
    expect(await screen.findByText('Could not load tag suggestions.')).toBeTruthy();
    call.mockResolvedValueOnce(ok(list(locales)));
    await click('Try again');
    expect(await screen.findByText(`“${LABEL}”`)).toBeTruthy();
  });

  it('renders the no-access block on a 403 and sends an ended session to sign-in', async () => {
    call.mockResolvedValueOnce(fail(403, 'access.denied'));
    mount();
    expect(await screen.findByText('no access here')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce(fail(401, 'session.invalid'));
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('approves with the group, name and slug, the version seen, and the CSRF token', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Approve “${LABEL}”`);
    await waitFor(() =>
      expect((document.activeElement as HTMLInputElement).getAttribute('name')).toBe('name'),
    );
    expect(screen.getByLabelText<HTMLInputElement>(/Tag name/).value).toBe(LABEL);
    expect(screen.getByLabelText<HTMLInputElement>('Slug').value).toBe('eid-gifts');
    expect(screen.getByText(/default language/)).toBeTruthy();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Create tag' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Tag name/), { target: { value: ' Eid gifts ' } });
    fireEvent.change(screen.getByLabelText(/Group/), { target: { value: 'occasion' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: ' Eid-Gifts ' } });
    expect(confirm.disabled).toBe(false);
    call.mockResolvedValueOnce(decided('approved'));
    call.mockResolvedValueOnce(ok({ ...list(locales), items: [] }));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(call.mock.calls[1]).toEqual([
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
    await click(`Approve “${LABEL}”`);
    fireEvent.change(screen.getByLabelText(/Group/), { target: { value: 'use' } });
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'bad--slug' } });
    expect(screen.getByText('Use lower case letters, digits and single hyphens.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create tag' }).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: '' } });
    call.mockResolvedValueOnce(decided('approved'));
    call.mockResolvedValueOnce(ok({ ...list(locales), items: [] }));
    await click('Create tag');
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[1]?.[2]).toEqual({ version: 3, group: 'use', name: LABEL });
  });

  it('disables Approve with a help line when the admin may not manage tags', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount(false);
    const approve = await screen.findByRole<HTMLButtonElement>('button', {
      name: `Approve “${LABEL}”`,
    });
    expect(approve.disabled).toBe(true);
    expect(screen.getByText('Approving needs permission to manage tags.')).toBeTruthy();
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
    await click(`Map “${LABEL}” to an existing tag`);
    await waitFor(() =>
      expect(call.mock.calls[1]?.[1]).toBe('catalog/admin/topics?status=active&limit=25'),
    );
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Map tag' });
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByRole('option', { name: /Eid/ }));
    expect(confirm.disabled).toBe(false);
    call.mockReset();
    call.mockResolvedValueOnce(decided('mapped'));
    call.mockResolvedValueOnce(ok({ ...list(locales), items: [] }));
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

  it('disables mapping when there is no active tag', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    call.mockResolvedValue(
      ok({ items: [], nextAfterId: null, locales, groups: [], maxSynonyms: 10 }),
    );
    await click(`Map “${LABEL}” to an existing tag`);
    expect(await screen.findByText('There are no active tags to map to.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Map tag' }).disabled).toBe(true);
  });

  it('shows a picker error when the tags cannot be loaded', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    call.mockResolvedValue(fail(500, 'unknown'));
    await click(`Map “${LABEL}” to an existing tag`);
    fireEvent.click(screen.getByRole('combobox'));
    expect(await screen.findByText('Could not load tags. Try again.')).toBeTruthy();
  });

  it('rejects with a reason, counted, and sends the trimmed reason', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Reject “${LABEL}”`);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
    expect(screen.getByText('0 / 300')).toBeTruthy();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Reject suggestion' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Too broad ' } });
    expect(screen.getByText('12 / 300')).toBeTruthy();
    call.mockResolvedValueOnce(decided('rejected'));
    call.mockResolvedValueOnce(ok({ ...list(locales), items: [] }));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(call.mock.calls[1]).toEqual([
      'POST',
      `catalog/admin/topic-suggestions/${id(1)}/reject`,
      { version: 3, reason: 'Too broad' },
      'csrf-1',
    ]);
    await expectToast('Suggestion rejected. The seller has been emailed.');
  });

  it('cancels with Escape or Cancel and returns focus to the first action', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Reject “${LABEL}”`);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: `Approve “${LABEL}”` }),
      ),
    );
    await click(`Reject “${LABEL}”`);
    await click('Cancel');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('sends a decision once on a double click and locks the field while it runs', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Reject “${LABEL}”`);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(decided('rejected'));
    call.mockResolvedValue(ok({ ...list(locales), items: [] }));
    const button = screen.getByRole('button', { name: 'Reject suggestion' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox').readOnly).toBe(true);
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('moves focus to the next card after a decision', async () => {
    call.mockResolvedValueOnce(ok(list(locales, ['First', 'Second'])));
    mount();
    await click('Reject “First”');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(decided('rejected'));
    const rest = list(locales, ['Second']);
    call.mockResolvedValueOnce(
      ok({ ...rest, items: rest.items.map((item) => ({ ...item, id: id(2), version: 4 })) }),
    );
    await click('Reject suggestion');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Approve “Second”' })),
    );
  });

  it.each([
    ['suggestion.stale', 409],
    ['suggestion.not-open', 409],
    ['suggestion.not-found', 404],
  ])('refreshes the list with a notice on %s', async (code, status) => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Reject “${LABEL}”`);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(fail(status, code));
    call.mockResolvedValueOnce(ok({ ...list(locales), items: [] }));
    await click('Reject suggestion');
    expect(
      await screen.findByText(
        'That suggestion was already decided or changed by someone else. The list has been refreshed.',
      ),
    ).toBeTruthy();
    await waitFor(() => expect(screen.getByText('No tag suggestions waiting')).toBeTruthy());
    expect(call.mock.calls[2]?.[0]).toBe('GET');
  });

  it('says the list may be out of date when the refresh fails', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Reject “${LABEL}”`);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(decided('rejected'));
    call.mockResolvedValueOnce(fail(500, 'unknown'));
    await click('Reject suggestion');
    expect(
      await screen.findByText(/The list may be out of date. Reload to see the latest./),
    ).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Open tag suggestions' })).toBeTruthy();
    call.mockResolvedValueOnce(ok(list(locales, ['Fresh'])));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('“Fresh”')).toBeTruthy();
  });

  it('keeps the form and its inputs open on a refusal the admin can fix', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Approve “${LABEL}”`);
    fireEvent.change(screen.getByLabelText(/Group/), { target: { value: 'use' } });
    call.mockResolvedValueOnce(
      fail(422, 'topic.claim-word', [{ path: 'name', code: 'claim-word' }]),
    );
    await click('Create tag');
    expect(
      await screen.findByText(
        'A tag name cannot claim a certification such as halal or organic. Change the name or slug.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Check this field.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>(/Tag name/).value).toBe(LABEL);
  });

  it('offers Map to existing tag when the name is taken', async () => {
    call.mockResolvedValueOnce(ok(list(locales)));
    mount();
    await click(`Approve “${LABEL}”`);
    fireEvent.change(screen.getByLabelText(/Group/), { target: { value: 'use' } });
    call.mockResolvedValueOnce(fail(409, 'topic.term-taken'));
    await click('Create tag');
    expect(
      await screen.findByText(/already exists. Map the suggestion to it instead/),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: `Map “${LABEL}” to an existing tag` }),
      ),
    );
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
