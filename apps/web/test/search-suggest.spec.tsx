// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import messages from '../messages/en.json';
import { useSuggestBox } from '../src/search/suggest-box.tsx';
import { markParts } from '../src/search/suggest-marks.ts';
import type { SuggestAnswer } from '../src/search/suggest-types.ts';
import { SearchView } from '../src/shell/search-view.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { suggestOf } from '../src/storefront/suggest-source.ts';
import { sampleSuggestions } from '../src/storefront/sample-suggest.ts';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: push }) }));

const ANSWER: SuggestAnswer = {
  products: [
    {
      id: 'p1',
      name: 'Bakery flatbread',
      href: '/p/p1',
      sellerName: 'Sunnybank Pantry Co',
      categoryName: 'Bakery',
      imageUrl: null,
    },
    {
      id: 'p2',
      name: 'Sourdough <b>loaf</b>',
      href: '/p/p2',
      sellerName: 'Kedron Bakers',
      categoryName: null,
      imageUrl: null,
    },
  ],
  stores: [
    { slug: 'kedron-bakers', href: '/s/kedron-bakers', name: 'Kedron Bakers', productCount: 4 },
  ],
  total: 12,
  totalIsCapped: false,
};

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchMock: Mock<Fetch>;
let submitted: string[] = [];

function Box({ onPick, inline = false }: { onPick?: () => void; inline?: boolean }) {
  const box = useSuggestBox({ inline, ...(onPick ? { onPick } : {}) });
  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        submitted.push(new FormData(event.currentTarget).get('q') as string);
      }}
    >
      <input name="q" aria-label="Search" {...box.inputProps} />
      {box.panel}
    </form>
  );
}

const mount = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{node}</StoreProvider>
    </NextIntlClientProvider>,
  );

const reply = (body: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);

async function type(text: string) {
  const input = screen.getByRole('combobox');
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(130);
  });
  return input;
}

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  submitted = [];
  fetchMock = vi.fn<Fetch>(() => reply(ANSWER));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('suggestions combobox', () => {
  it('asks nothing under two characters and shows no panel', async () => {
    mount(<Box />);
    await type('b');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveProperty('ariaExpanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('waits 120 ms after the last key and asks once for the last text', async () => {
    mount(<Box />);
    const input = screen.getByRole('combobox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'ba' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.change(input, { target: { value: 'bak' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/search-suggest?q=bak');
  });

  it('aborts the request a newer text replaces', async () => {
    let first: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      first = init?.signal as AbortSignal;
      return new Promise(() => undefined);
    });
    mount(<Box />);
    await type('ba');
    expect(first?.aborted).toBe(false);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bak' } });
    expect(first?.aborted).toBe(true);
  });

  it('shows products, stores and the See all row, with no price or certification text', async () => {
    mount(<Box />);
    await type('bak');
    const list = screen.getByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.getAttribute('id'))).toHaveLength(4);
    expect(within(list).getByText('Products')).toBeTruthy();
    expect(within(list).getByText('Stores')).toBeTruthy();
    expect(options[0]?.querySelector('small')?.textContent).toBe('Sunnybank Pantry Co · Bakery');
    expect(within(list).getByText('4 products')).toBeTruthy();
    expect(options[3]?.textContent).toBe('See all results for "bak" (12 products)');
    expect(list.textContent).not.toMatch(/\$|A\$|halal|certif/iu);
    expect(screen.getByRole('combobox').getAttribute('aria-controls')).toBe(list.id);
    expect(screen.getByRole('combobox').getAttribute('aria-autocomplete')).toBe('list');
  });

  it('marks the typed words with code and renders names as text', async () => {
    mount(<Box />);
    await type('bak');
    const marks = screen.getByRole('listbox').querySelectorAll('mark');
    expect([...marks].map((m) => m.textContent)).toContain('Bak');
    // A name carrying markup stays text.
    expect(screen.getByText('Sourdough <b>loaf</b>')).toBeTruthy();
    expect(screen.getByRole('listbox').querySelector('b b')).toBeNull();
  });

  it('writes N+ when the total is capped', async () => {
    fetchMock.mockImplementation(() => reply({ ...ANSWER, total: 100, totalIsCapped: true }));
    mount(<Box />);
    await type('bak');
    expect(screen.getByText('See all results for "bak" (100+ products)')).toBeTruthy();
  });

  it('moves with the arrows, wraps, and announces the active row', async () => {
    mount(<Box />);
    const input = await type('bak');
    const options = screen.getAllByRole('option');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[3]?.id);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    expect(screen.getByRole('status').textContent).toMatch(/2 products and 1 store suggested/u);
  });

  it('opens the active product on Enter, and runs the normal search on Enter with no row', async () => {
    const onPick = vi.fn();
    mount(<Box onPick={onPick} />);
    const input = await type('bak');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).not.toHaveBeenCalled();
    // The form's own submit is untouched: nothing here stops it.
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/p/p1');
    expect(onPick).toHaveBeenCalled();
  });

  it('opens a store row, and the See all row submits the search form', async () => {
    mount(<Box />);
    const input = await type('bak');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(push).toHaveBeenCalledWith('/s/kedron-bakers');
    push.mockClear();
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submitted).toEqual(['bak']);
    expect(push).not.toHaveBeenCalled();
  });

  it('Esc closes, the second Esc clears, Tab closes', async () => {
    mount(<Box />);
    const input = (await type('bak')) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('bak');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'bak' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps focus on a row press and closes on blur', async () => {
    mount(<Box />);
    const input = await type('bak');
    const row = screen.getAllByRole('option')[0]!;
    expect(fireEvent.mouseDown(row)).toBe(false);
    fireEvent.blur(input);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows skeleton rows only when the answer is slower than the debounce', async () => {
    let finish: (value: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (finish = resolve)));
    const { container } = mount(<Box />);
    await type('bak');
    expect(container.querySelector('.tasq')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(container.querySelectorAll('.tasq')).toHaveLength(3);
    await act(async () => {
      finish({ ok: true, json: () => Promise.resolve(ANSWER) } as Response);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('.tasq')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('says there are no suggestions and still offers See all', async () => {
    fetchMock.mockImplementation(() =>
      reply({ products: [], stores: [], total: 0, totalIsCapped: false }),
    );
    mount(<Box />);
    await type('zzz');
    expect(screen.getAllByText('No suggestions for "zzz"').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toContain('See all results for "zzz"');
    expect(screen.queryByText(/did you mean/iu)).toBeNull();
  });

  it('has no active descendant until an arrow key chooses a row', async () => {
    mount(<Box />);
    const input = await type('bak');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.hasAttribute('aria-activedescendant')).toBe(true);
    fireEvent.change(input, { target: { value: 'bake' } });
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('ignores Enter while an input method is composing', async () => {
    mount(<Box />);
    const input = await type('bak');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(fireEvent.keyDown(input, { key: 'Enter', isComposing: true })).toBe(true);
    expect(push).not.toHaveBeenCalled();
  });

  it('ignores an older answer that arrives after a newer request started', async () => {
    const waiting: { q: string; finish: (r: Response) => void }[] = [];
    // Neither request listens to the abort signal: the older one can still answer.
    fetchMock.mockImplementation(
      (url: string) =>
        new Promise<Response>((resolve) => {
          waiting.push({
            q: new URL(url, 'http://x').searchParams.get('q') ?? '',
            finish: resolve,
          });
        }),
    );
    mount(<Box />);
    const input = await type('ba');
    fireEvent.change(input, { target: { value: 'bak' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(waiting.map((w) => w.q)).toEqual(['ba', 'bak']);
    const old = { ...ANSWER, total: 99 };
    await act(async () => {
      waiting[0]!.finish({ ok: true, json: () => Promise.resolve(old) } as Response);
      await vi.advanceTimersByTimeAsync(0);
    });
    // The skeleton is still the answer to "bak": the old rows are not shown and cannot be picked.
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    await act(async () => {
      waiting[1]!.finish({ ok: true, json: () => Promise.resolve(ANSWER) } as Response);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getAllByRole('option')[3]?.textContent).toContain('(12 products)');
  });

  it('forgets the answer when the box drops under two characters', async () => {
    mount(<Box />);
    const input = await type('bak');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    fireEvent.change(input, { target: { value: 'b' } });
    fireEvent.change(input, { target: { value: 'ba' } });
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('in the phone view the first Esc closes the list, the second clears, then Esc passes on', async () => {
    mount(<Box inline />);
    const input = (await type('bak')) as HTMLInputElement;
    expect(screen.getAllByRole('option')).toHaveLength(4);
    const first = fireEvent.keyDown(input, { key: 'Escape' });
    expect(first).toBe(false);
    expect(screen.queryByRole('option')).toBeNull();
    expect(input.value).toBe('bak');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('');
    expect(fireEvent.keyDown(input, { key: 'Escape' })).toBe(true);
    // Typing again brings the list back.
    fireEvent.change(input, { target: { value: 'bak' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('calls onPick when a row is pressed in the phone view', async () => {
    const onPick = vi.fn();
    mount(<Box inline onPick={onPick} />);
    await type('bak');
    fireEvent.click(screen.getAllByRole('option')[0]!);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('keeps notes out of the listbox and is not expanded after an error', async () => {
    fetchMock.mockImplementation(() => reply({}, false));
    const { container } = mount(<Box />);
    const input = await type('bak');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[role="listbox"] p')).toBeNull();
    expect(container.querySelector('.tanote')?.textContent).toMatch(/could not load/u);
    fetchMock.mockImplementation(() =>
      reply({ products: [], stores: [], total: 0, totalIsCapped: false }),
    );
    fireEvent.change(input, { target: { value: 'zzz' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(container.querySelector('[role="listbox"] p')).toBeNull();
    expect(container.querySelector('.tanote')?.textContent).toBe('No suggestions for "zzz"');
  });

  it('writes the count in See all in the singular, and leaves it out at zero', async () => {
    fetchMock.mockImplementation(() =>
      reply({
        products: [],
        stores: [{ slug: 'k', href: '/s/k', name: 'Kedron', productCount: 1 }],
        total: 1,
        totalIsCapped: false,
      }),
    );
    mount(<Box />);
    await type('ked');
    expect(screen.getByText('1 product')).toBeTruthy();
    expect(screen.getAllByRole('option')[1]?.textContent).toBe(
      'See all results for "ked" (1 product)',
    );
    fetchMock.mockImplementation(() =>
      reply({ products: [], stores: [], total: 0, totalIsCapped: false }),
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(screen.getByRole('option').textContent).toBe('See all results for "zzz"');
  });

  it.each([
    ['a failed answer', () => reply({}, false)],
    ['a network fault', () => Promise.reject(new TypeError('offline'))],
  ])('says it could not load on %s, and Enter still searches', async (_name, answer) => {
    fetchMock.mockImplementation(answer);
    mount(<Box />);
    const input = await type('bak');
    const message = 'We could not load suggestions. Press Enter to search.';
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(screen.queryByRole('option')).toBeNull();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true);
  });
});

describe('phone search view', () => {
  const view = () => mount(<SearchView popular={['Dates']} />);

  it('keeps Recent and Popular under two characters and replaces them from two', async () => {
    const { container } = view();
    const input = container.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'b' } });
    expect(container.querySelector('.sbody')?.hasAttribute('hidden')).toBe(false);
    fireEvent.change(input, { target: { value: 'bak' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(130);
    });
    expect(container.querySelector('.sbody')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(4);
  });
});

describe('markParts', () => {
  it('marks every typed word, case-blind, merging overlaps', () => {
    expect(markParts('Bakery flatbread', 'bak flat')).toEqual([
      { text: 'Bak', marked: true },
      { text: 'ery ', marked: false },
      { text: 'flat', marked: true },
      { text: 'bread', marked: false },
    ]);
    expect(markParts('Lamb', 'lam la')).toEqual([
      { text: 'Lam', marked: true },
      { text: 'b', marked: false },
    ]);
    expect(markParts('Dates', 'xyz')).toEqual([{ text: 'Dates', marked: false }]);
  });
});

describe('suggestOf (the API answer)', () => {
  const id = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const photo = (p: string, i: string, size: string) => `https://img.test/${p}/${i}/${size}`;
  const body = {
    products: [
      {
        productId: id,
        name: 'Lamb mince',
        sellerName: 'Kedron',
        categoryName: null,
        image: { imageId: id, width: 800, height: 600, alt: 'x' },
      },
      { productId: 3, name: 'bad' },
    ],
    stores: [
      { storeSlug: 'kedron', name: 'Kedron', productCount: 3 },
      { storeSlug: '../x', name: 'Bad', productCount: 1 },
    ],
    total: 9,
    totalIsCapped: true,
  };

  it('checks entries, builds links and photo URLs, and drops what is malformed', () => {
    const answer = suggestOf(body, photo);
    expect(answer?.products).toEqual([
      {
        id,
        name: 'Lamb mince',
        href: `/p/lamb-mince-${id}`,
        sellerName: 'Kedron',
        categoryName: null,
        imageUrl: `https://img.test/${id}/${id}/thumb`,
      },
    ]);
    expect(answer?.stores).toEqual([
      { slug: 'kedron', href: '/s/kedron', name: 'Kedron', productCount: 3 },
    ]);
    expect(answer).toMatchObject({ total: 9, totalIsCapped: true });
    expect(JSON.stringify(answer)).not.toMatch(/price|certif/iu);
  });

  it('has no photo when photos are off, and no answer for a body that is not one', () => {
    expect(suggestOf(body, null)?.products[0]?.imageUrl).toBeNull();
    expect(suggestOf({ products: [] }, null)).toBeUndefined();
    expect(suggestOf(null, null)).toBeUndefined();
  });
});

describe('sample suggestions (API off)', () => {
  it('answers in the API shape: products first by name start, stores, a total, no price', async () => {
    const answer = await sampleSuggestions('lamb');
    expect(answer.products.length).toBeGreaterThan(0);
    expect(answer.products.length).toBeLessThanOrEqual(5);
    expect(answer.products[0]?.name.toLowerCase().startsWith('lamb')).toBe(true);
    expect(answer.stores.length).toBeLessThanOrEqual(3);
    expect(answer.total).toBeGreaterThanOrEqual(answer.products.length);
    expect(Object.keys(answer.products[0]!).join()).not.toMatch(/price|certif/iu);
    expect((await sampleSuggestions('qqqq')).total).toBe(0);
  });
});
