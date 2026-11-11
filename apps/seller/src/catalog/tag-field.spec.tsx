// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { TagField, topicSentences, useKnownTags } from './tag-field.tsx';
import type { TopicIssue } from './edit-errors.ts';
import type { TopicChoice, TopicRef } from './types.ts';

const call = vi.mocked(callApi);
const assign = vi.fn();

// Two Market shapes: a one-language default (AU) and a Market whose default language is not the
// first key of a tag's names, with a tag that has no name in the default language at all.
const MARKETS = [
  { code: 'AU', locale: 'en-AU', names: (n: string) => ({ 'en-AU': n, ar: `ar ${n}` }) },
  { code: 'ZZ', locale: 'ms-MY', names: (n: string) => ({ en: `en ${n}`, 'ms-MY': n }) },
] as const;
const id = (n: number) => `0197a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe.each(MARKETS)('TagField in market $code', ({ locale, names }) => {
  const choice = (
    n: number,
    name: string,
    group: TopicChoice['group'] = 'occasion',
  ): TopicChoice => ({
    id: id(n),
    slug: `tag-${n}`,
    group,
    name,
    names: names(name),
  });
  const ref = (n: number, name: string, status: TopicRef['status'] = 'active'): TopicRef => ({
    id: id(n),
    slug: `tag-${n}`,
    status,
    name,
    names: names(name),
  });
  const page = (items: TopicChoice[], max = 10) =>
    ({ ok: true, status: 200, body: { items, nextAfterId: null, maxPerProduct: max } }) as const;

  let changes: string[][] = [];
  function Harness({
    start = [],
    refs = [],
    issues = [],
  }: {
    start?: string[];
    refs?: TopicRef[];
    issues?: TopicIssue[];
  }) {
    const [ids, setIds] = useState<string[]>(start);
    const [max, setMax] = useState(10);
    const known = useKnownTags(refs, locale);
    return (
      <TagField
        ids={ids}
        known={known}
        defaultLocale={locale}
        issues={issues}
        max={max}
        onMax={setMax}
        onChange={(next) => {
          changes.push(next);
          setIds(next);
        }}
      />
    );
  }
  const mount = (props: Parameters<typeof Harness>[0] = {}) =>
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <Harness {...props} />
      </NextIntlClientProvider>,
    );
  const open = () => fireEvent.click(screen.getByRole('combobox', { name: /Tags/ }));

  beforeEach(() => {
    vi.clearAllMocks();
    changes = [];
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    Object.defineProperty(window, 'location', {
      value: { assign },
      writable: true,
    });
  });
  afterEach(cleanup);

  it('asks for the active tags when opened and shows the group as a second line', async () => {
    call.mockResolvedValue(page([choice(1, 'Eid'), choice(2, 'Barbecue', 'cuisine')]));
    mount();
    open();
    await screen.findByRole('option', { name: /Eid/ });
    expect(call).toHaveBeenCalledWith('GET', 'catalog/seller/topics?limit=100');
    const second = screen.getByRole('option', { name: /Barbecue/ });
    expect(within(second).getByText('Cuisine')).toBeTruthy();
  });

  it('picks a tag, keeps the order picked and writes the ids', async () => {
    call.mockResolvedValue(page([choice(1, 'Eid'), choice(2, 'Barbecue')]));
    mount();
    open();
    fireEvent.click(await screen.findByRole('option', { name: /Barbecue/ }));
    fireEvent.click(screen.getByRole('option', { name: /Eid/ }));
    expect(changes).toEqual([[id(2)], [id(2), id(1)]]);
    expect(screen.getByRole('button', { name: 'Remove Barbecue' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Eid' })).toBeTruthy();
  });

  it('searches on the server with the typed words, after a pause', async () => {
    call.mockResolvedValue(page([choice(1, 'Eid')]));
    mount();
    open();
    await screen.findByRole('option', { name: /Eid/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Search tags' }), {
      target: { value: ' bbq ' },
    });
    await waitFor(
      () => expect(call).toHaveBeenCalledWith('GET', 'catalog/seller/topics?limit=100&search=bbq'),
      { timeout: 2000 },
    );
  });

  it('keeps the picked chips when the search results change', async () => {
    call.mockResolvedValueOnce(page([choice(1, 'Eid')]));
    mount();
    open();
    fireEvent.click(await screen.findByRole('option', { name: /Eid/ }));
    call.mockResolvedValueOnce(page([choice(2, 'Barbecue')]));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search tags' }), {
      target: { value: 'bar' },
    });
    await screen.findByRole('option', { name: /Barbecue/ }, { timeout: 2000 });
    expect(screen.getByRole('button', { name: 'Remove Eid' })).toBeTruthy();
  });

  it('stops at the most the API allows and says how to add another', async () => {
    call.mockResolvedValue(page([choice(1, 'Eid'), choice(2, 'Barbecue'), choice(3, 'Picnic')], 2));
    mount();
    open();
    fireEvent.click(await screen.findByRole('option', { name: /Eid/ }));
    fireEvent.click(screen.getByRole('option', { name: /Barbecue/ }));
    expect(screen.getByText('You can pick up to 2 tags. Remove one to add another.')).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: /Picnic/ }));
    expect(changes).toHaveLength(2);
  });

  it('spells an archived tag and an unknown one in the chip, and explains the archived one', () => {
    mount({
      start: [id(1), id(2), id(9)],
      refs: [ref(1, 'Eid'), ref(2, 'Ramadan', 'archived')],
    });
    expect(screen.getByRole('button', { name: 'Remove Eid' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Ramadan (archived)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Unavailable tag' })).toBeTruthy();
    expect(
      screen.getByText(
        /Archived tags can't be added\. A tag the live product already has can stay\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/retired/i)).toBeNull();
    // No request is made until the list is opened.
    expect(call).not.toHaveBeenCalled();
  });

  it('says the changes are checked and the field is optional; no archived help without one', () => {
    mount({ start: [id(1)], refs: [ref(1, 'Eid')] });
    expect(
      screen.getByText(
        'Optional. Tags help shoppers find this product. Tag changes are checked by us before they go live.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Archived tags can't be added/)).toBeNull();
  });

  it('removes a tag', () => {
    mount({ start: [id(1), id(2)], refs: [ref(1, 'Eid'), ref(2, 'Picnic')] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Eid' }));
    expect(changes).toEqual([[id(2)]]);
  });

  it('shows a load failure inside the list, not as a field error, and retries', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    mount();
    open();
    await screen.findByText("Tags can't be loaded right now.");
    expect(screen.getByRole('combobox', { name: /Tags/ }).getAttribute('aria-invalid')).toBeNull();
    call.mockResolvedValueOnce(page([choice(1, 'Eid')]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('option', { name: /Eid/ });
  });

  it('uses the generic words when throttled and leaves for sign-in on a 401', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 429, code: 'request.throttled' } });
    mount();
    open();
    await screen.findByText('Too many requests. Wait a moment and try again.');
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('puts one sentence per refused tag in the field error and marks the field invalid', () => {
    mount({
      start: [id(1), id(2), id(9), id(3)],
      refs: [ref(1, 'Eid'), ref(2, 'Ramadan', 'archived'), ref(3, 'Picnic')],
      issues: [
        { index: 1, code: 'archived' },
        { index: 2, code: 'unknown' },
        { index: 3, code: 'duplicate' },
        { index: null, code: 'too-many' },
      ],
    });
    expect(
      screen.getByText(
        'Ramadan is archived. Remove it. A tag on this product no longer exists. Remove it. ' +
          'Picnic is picked twice. Remove one. Pick 10 tags or fewer.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /Tags/ }).getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('names the sentences from the known tags for the banner', () => {
    const known = new Map([[id(1), { name: 'Eid', archived: true }]]);
    const t = (key: string, values?: Record<string, string | number>) =>
      `${key}${values === undefined ? '' : JSON.stringify(values)}`;
    expect(
      topicSentences(
        t,
        [
          { index: 0, code: 'archived' },
          { index: 5, code: 'unknown' },
        ],
        [id(1)],
        known,
        10,
      ),
    ).toEqual([
      'catalog.edit.tags.archived-problem{"name":"Eid"}',
      'catalog.edit.tags.unknown-problem',
    ]);
  });
});
