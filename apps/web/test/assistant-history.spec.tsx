// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import messages from '../messages/en.json';
import { AssistantWidget, type WidgetApi } from '../src/assistant/assistant-widget.tsx';
import {
  conversationPageOf,
  deleteConversation,
  listConversations,
  readConversation,
  sendFeedback,
  storedConversationOf,
  type AssistantSetup,
  type SendResult,
  type sendMessage,
} from '../src/assistant/assistant.ts';
import { StoreProvider } from '../src/shell/store-context.tsx';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => '/',
  useSearchParams: () => null,
}));

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';

const SETUP: AssistantSetup = {
  chatUrl: 'https://api.example.test/assistant',
  guestsAllowed: true,
  welcomeText: null,
  supportEmail: 'help@example.test',
  retentionDays: 365,
  csrfToken: 'csrf-1',
  quickPrompts: [],
  preview: false,
};

const CUSTOMER = {
  firstName: 'Sam',
  fullName: 'Sam Buyer',
  email: 'sam@example.test',
  addresses: [],
};

const ok = (text: string): SendResult => ({
  ok: true,
  reply: {
    conversationId: 'c',
    sentences: [text],
    products: [],
    sellers: [],
    pages: [],
    cartActions: [],
    carts: [],
    baskets: [],
    support: false,
    notices: [],
  },
});

const summary = (id: string, title: string, turns = 1, full = false) => ({
  id,
  title,
  turns,
  full,
  startedAt: '2026-11-10T01:00:00Z',
  lastMessageAt: '2026-11-18T01:00:00Z',
});

type Stub = Mock<(...args: unknown[]) => unknown>;
interface Stubs {
  readonly list: Stub;
  readonly read: Stub;
  readonly remove: Stub;
  readonly feedback: Stub;
}

function stubs(over: Record<string, unknown> = {}): Stubs & WidgetApi {
  const api = {
    list: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { items: [summary(A, 'Halal chicken'), summary(B, 'Dates', 2)], nextCursor: null },
      }),
    ),
    read: vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: {
          ...summary(A, 'Halal chicken', 2),
          messages: [
            {
              position: 1,
              role: 'user' as const,
              text: 'halal chicken',
              pages: [],
              support: false,
              hadListings: false,
            },
            {
              position: 2,
              role: 'assistant' as const,
              text: 'Here is a bird.',
              pages: [],
              support: false,
              hadListings: true,
            },
            {
              position: 3,
              role: 'user' as const,
              text: 'cheaper?',
              pages: [],
              support: false,
              hadListings: false,
            },
            {
              position: 4,
              role: 'assistant' as const,
              text: 'Try the thighs.',
              pages: [],
              support: false,
              hadListings: false,
            },
          ],
        },
      }),
    ),
    remove: vi.fn(() => Promise.resolve({ ok: true as const, value: true as const })),
    feedback: vi.fn(() => Promise.resolve({ ok: true as const, value: true as const })),
    ...over,
  };
  return api;
}

function renderWidget(
  send: typeof sendMessage,
  api: WidgetApi,
  options: { signedIn?: boolean; setup?: AssistantSetup } = {},
) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider initialCustomer={options.signedIn ? CUSTOMER : null}>
        <AssistantWidget setup={options.setup ?? SETUP} send={send} api={api} />
      </StoreProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const launcher = () => screen.getByRole('button', { name: 'Ask the assistant' });
async function say(text: string) {
  fireEvent.change(screen.getByLabelText('Message to the assistant'), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await Promise.resolve();
  });
}
const click = async (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
    await Promise.resolve();
  });

describe('feedback on answers', () => {
  it('sends a thumbs up for position 2, then 4, with the id of the conversation', async () => {
    const api = stubs();
    renderWidget(() => Promise.resolve(ok('One.')), api);
    fireEvent.click(launcher());
    await say('first');
    await click('Good answer');
    expect(api.feedback).toHaveBeenCalledTimes(1);
    const [, conversationId, position, rating, reason] = api.feedback.mock.calls[0]!;
    expect(conversationId).toMatch(/^[0-9a-f]{8}-/);
    expect([position, rating, reason]).toEqual([2, 'up', null]);
    expect(screen.getByText(messages.assistant.thanks)).toBeTruthy();
    await say('second');
    await click('Good answer');
    expect(api.feedback.mock.calls[1]![2]).toBe(4);
    expect(api.feedback.mock.calls[1]![1]).toBe(conversationId);
  });

  it('offers the reasons after a thumbs down and replaces the rating with the chosen one', async () => {
    const api = stubs();
    renderWidget(() => Promise.resolve(ok('One.')), api);
    fireEvent.click(launcher());
    await say('first');
    await click('Bad answer');
    expect(api.feedback.mock.calls[0]!.slice(2, 5)).toEqual([2, 'down', null]);
    const reasons = screen.getByRole('group', { name: 'What went wrong?' });
    expect(within(reasons).getAllByRole('button')).toHaveLength(3);
    await act(async () => {
      fireEvent.click(
        within(reasons).getByRole('button', { name: 'I could not find what I wanted' }),
      );
      await Promise.resolve();
    });
    expect(api.feedback.mock.calls[1]!.slice(2, 5)).toEqual([2, 'down', 'not-found']);
    expect(screen.getByRole('link', { name: 'Email support' })).toBeTruthy();
  });

  it('says so when the feedback is not saved', async () => {
    const api = stubs({
      feedback: vi.fn(() =>
        Promise.resolve({ ok: false as const, refusal: { kind: 'error' as const } }),
      ),
    });
    renderWidget(() => Promise.resolve(ok('One.')), api);
    fireEvent.click(launcher());
    await say('first');
    await click('Good answer');
    expect(await screen.findByText(messages.assistant['feedback-failed'])).toBeTruthy();
  });

  it('sends nothing when the chat keeps no text, and shows no thanks it did not earn', async () => {
    const api = stubs();
    renderWidget(() => Promise.resolve(ok('One.')), api, { setup: { ...SETUP, retentionDays: 0 } });
    fireEvent.click(launcher());
    await say('first');
    await click('Good answer');
    expect(api.feedback).not.toHaveBeenCalled();
    expect(screen.queryByText(messages.assistant.thanks)).toBeNull();
  });

  it('does not guess a position after a turn of unknown outcome (a guest has no way to check)', async () => {
    const api = stubs();
    const results: SendResult[] = [{ ok: false, refusal: { kind: 'error' } }, ok('Later.')];
    renderWidget(() => Promise.resolve(results.shift()!), api);
    fireEvent.click(launcher());
    await say('first');
    await click('Try again');
    await click('Good answer');
    expect(api.feedback).not.toHaveBeenCalled();
  });

  it('starts counting again from a new chat', async () => {
    const api = stubs();
    const results: SendResult[] = [{ ok: false, refusal: { kind: 'error' } }, ok('Later.')];
    renderWidget(() => Promise.resolve(results.shift()!), api);
    fireEvent.click(launcher());
    await say('first');
    await click('Start a new chat');
    await say('again');
    await click('Good answer');
    expect(api.feedback.mock.calls[0]![2]).toBe(2);
  });
});

describe('positions after the unusual turns', () => {
  it('records no thumbs after Stop, even for a signed-in buyer, until the chat is opened again', async () => {
    const api = stubs();
    const send = vi.fn<typeof sendMessage>(
      (_setup, _id, _text, _visitor, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    renderWidget(send, api, { signedIn: true });
    fireEvent.click(launcher());
    await say('first');
    await click('Stop');
    send.mockImplementation(() => Promise.resolve(ok('Later.')));
    await say('again');
    await click('Good answer');
    expect(api.feedback).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
    // Opening the stored chat reads its real count.
    await click('Your conversations');
    await act(async () => {
      fireEvent.click(await screen.findByText('Halal chicken'));
      await Promise.resolve();
    });
    await say('and now?');
    await click('Good answer');
    expect(api.feedback.mock.calls[0]![2]).toBe(6);
  });

  it('starts again at 2 when the server lost the conversation', async () => {
    const api = stubs();
    const results: SendResult[] = [
      ok('One.'),
      { ok: false, refusal: { kind: 'lost' } },
      ok('Two.'),
    ];
    renderWidget(() => Promise.resolve(results.shift()!), api);
    fireEvent.click(launcher());
    await say('a');
    await say('b');
    await click('Try again');
    await click('Good answer');
    expect(api.feedback.mock.calls[0]![2]).toBe(2);
  });

  it('rates the 30th answer as position 60 and the next as none', async () => {
    const api = stubs({
      read: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          value: { ...summary(A, 'Long', 29), messages: [] },
        }),
      ),
    });
    renderWidget(() => Promise.resolve(ok('Last.')), api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await act(async () => {
      fireEvent.click(await screen.findByText('Halal chicken'));
      await Promise.resolve();
    });
    await say('thirtieth');
    await click('Good answer');
    expect(api.feedback.mock.calls[0]![2]).toBe(60);
  });

  it('drops the answer of a chat that was deleted while it was waiting', async () => {
    const api = stubs();
    let answer: (result: SendResult) => void = () => undefined;
    renderWidget(() => new Promise((resolve) => (answer = resolve)), api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await act(async () => {
      fireEvent.click(await screen.findByText('Halal chicken'));
      await Promise.resolve();
    });
    await say('slow one');
    await click('Your conversations');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete conversation: Halal chicken' }),
    );
    await click('Delete');
    await act(async () => {
      answer(ok('Too late.'));
      await Promise.resolve();
    });
    expect(screen.queryByText('Too late.')).toBeNull();
  });

  it('says thanks after a reason is chosen', async () => {
    const api = stubs();
    renderWidget(() => Promise.resolve(ok('One.')), api);
    fireEvent.click(launcher());
    await say('first');
    await click('Bad answer');
    await click('Something else');
    expect(screen.getByText(messages.assistant['thanks-noted'])).toBeTruthy();
  });
});

describe('history of a signed-in buyer', () => {
  it('shows no history button to a guest', () => {
    renderWidget(() => Promise.resolve(ok('x')), stubs());
    fireEvent.click(launcher());
    expect(screen.queryByRole('button', { name: 'Your conversations' })).toBeNull();
  });

  it('shows no history button when chats are not kept', () => {
    renderWidget(() => Promise.resolve(ok('x')), stubs(), {
      signedIn: true,
      setup: { ...SETUP, retentionDays: 0 },
    });
    fireEvent.click(launcher());
    expect(screen.queryByRole('button', { name: 'Your conversations' })).toBeNull();
  });

  it('lists the conversations, opens one and continues it with the same id', async () => {
    const api = stubs();
    const send = vi.fn<typeof sendMessage>(() => Promise.resolve(ok('Thighs are cheaper.')));
    renderWidget(send, api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    expect(await screen.findByText('Halal chicken')).toBeTruthy();
    expect(screen.getAllByText(/Nov 18, 2026/)).toHaveLength(2);
    expect(api.list.mock.calls[0]![1]).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Halal chicken'));
      await Promise.resolve();
    });
    expect(await screen.findByText('Try the thighs.')).toBeTruthy();
    expect(screen.getByText('halal chicken')).toBeTruthy();
    expect(screen.getByText(messages.assistant['history-listings'])).toBeTruthy();
    await say('and a whole one?');
    expect(send.mock.calls[0]![1]).toBe(A);
    // The stored chat had 2 answered turns: the new answer is position 6.
    await click('Good answer');
    expect(api.feedback.mock.calls[0]![1]).toBe(A);
    expect(api.feedback.mock.calls[0]![2]).toBe(6);
  });

  it('blocks asking more in a conversation that is full', async () => {
    const api = stubs({
      read: vi.fn(() =>
        Promise.resolve({
          ok: true as const,
          value: { ...summary(A, 'Long', 30, true), messages: [] },
        }),
      ),
    });
    renderWidget(() => Promise.resolve(ok('x')), api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await act(async () => {
      fireEvent.click(await screen.findByText('Halal chicken'));
      await Promise.resolve();
    });
    expect(await screen.findByText(messages.assistant.full)).toBeTruthy();
  });

  it('deletes after a confirmation, with the CSRF token, and drops the row', async () => {
    const api = stubs();
    renderWidget(() => Promise.resolve(ok('x')), api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await screen.findByText('Dates');
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation: Dates' }));
    expect(api.remove).not.toHaveBeenCalled();
    await click('Delete');
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect((api.remove.mock.calls[0]![0] as AssistantSetup).csrfToken).toBe('csrf-1');
    expect(api.remove.mock.calls[0]![1]).toBe(B);
    await waitFor(() => expect(screen.queryByText('Dates')).toBeNull());
    expect(screen.getByText(messages.assistant['history-deleted'])).toBeTruthy();
  });

  it('keeps the row and says so when the delete fails', async () => {
    const api = stubs({
      remove: vi.fn(() =>
        Promise.resolve({ ok: false as const, refusal: { kind: 'error' as const } }),
      ),
    });
    renderWidget(() => Promise.resolve(ok('x')), api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await screen.findByText('Dates');
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation: Dates' }));
    await click('Delete');
    expect(await screen.findByText(messages.assistant['history-delete-failed'])).toBeTruthy();
    expect(screen.getByText('Dates')).toBeTruthy();
  });

  it('starts a fresh chat when the open one is deleted', async () => {
    const api = stubs();
    const send = vi.fn<typeof sendMessage>(() => Promise.resolve(ok('Fresh.')));
    renderWidget(send, api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await act(async () => {
      fireEvent.click(await screen.findByText('Halal chicken'));
      await Promise.resolve();
    });
    await screen.findByText('Try the thighs.');
    await click('Your conversations');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete conversation: Halal chicken' }),
    );
    await click('Delete');
    fireEvent.click(screen.getAllByRole('button', { name: 'Back to the chat' })[0]!);
    expect(screen.queryByText('Try the thighs.')).toBeNull();
    await say('hello');
    expect(send.mock.calls[0]![1]).not.toBe(A);
  });

  it('marks the open conversation in the list and offers Try again when the list fails', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, refusal: { kind: 'error' } })
      .mockResolvedValueOnce({ ok: true, value: { items: [summary(A, 'One')], nextCursor: null } });
    renderWidget(() => Promise.resolve(ok('x')), stubs({ list }), { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await screen.findByRole('alert');
    await click('Try again');
    expect(await screen.findByText('One')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not bring back a row deleted while a page was loading', async () => {
    let page2: (value: unknown) => void = () => undefined;
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { items: [summary(A, 'One'), summary(B, 'Two')], nextCursor: 'n1' },
      })
      .mockImplementationOnce(() => new Promise((resolve) => (page2 = resolve)));
    renderWidget(() => Promise.resolve(ok('x')), stubs({ list }), { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await screen.findByText('One');
    await click('Show more');
    // Show more is on its way; Two is deleted meanwhile.
    fireEvent.click(screen.getByRole('button', { name: 'Delete conversation: Two' }));
    await click('Delete');
    await act(async () => {
      page2({ ok: true, value: { items: [summary(B, 'Two')], nextCursor: null } });
      await Promise.resolve();
    });
    expect(screen.queryByText('Two')).toBeNull();
  });

  it('says when the list or a conversation cannot be read', async () => {
    const api = stubs({
      list: vi.fn(() =>
        Promise.resolve({ ok: false as const, refusal: { kind: 'error' as const } }),
      ),
    });
    renderWidget(() => Promise.resolve(ok('x')), api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(messages.assistant['history-error'])).toBeTruthy();
  });

  it('removes a conversation that is gone when it is opened', async () => {
    const api = stubs({
      read: vi.fn(() =>
        Promise.resolve({ ok: false as const, refusal: { kind: 'lost' as const } }),
      ),
    });
    renderWidget(() => Promise.resolve(ok('x')), api, { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await act(async () => {
      fireEvent.click(await screen.findByText('Halal chicken'));
      await Promise.resolve();
    });
    expect(await screen.findByText(messages.assistant['history-gone'])).toBeTruthy();
    expect(screen.queryByText('Halal chicken')).toBeNull();
  });

  it('pages the list with the cursor and shows an empty list kindly', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { items: [summary(A, 'One')], nextCursor: 'next_1' },
      })
      .mockResolvedValueOnce({ ok: true, value: { items: [summary(B, 'Two')], nextCursor: null } });
    renderWidget(() => Promise.resolve(ok('x')), stubs({ list }), { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    await screen.findByText('One');
    await click('Show more');
    expect(await screen.findByText('Two')).toBeTruthy();
    expect(list.mock.calls[1]![1]).toBe('next_1');
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows the empty state', async () => {
    const list = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: { items: [], nextCursor: null } }),
    );
    renderWidget(() => Promise.resolve(ok('x')), stubs({ list }), { signedIn: true });
    fireEvent.click(launcher());
    await click('Your conversations');
    expect(await screen.findByText(messages.assistant['history-empty'])).toBeTruthy();
  });
});

describe('history and feedback calls', () => {
  const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));

  it('reads the list with a limit and cursor, and drops rows that are not the shape', async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      json({ items: [summary(A, 'x'), { id: 'nope' }], nextCursor: null }),
    );
    const result = await listConversations(
      SETUP,
      'c_1',
      new AbortController().signal,
      fetcher,
      'tok',
    );
    expect(fetcher.mock.calls[0]![0]).toBe(
      'https://api.example.test/assistant/conversations?limit=20&cursor=c_1',
    );
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['x-assistant-preview']).toBe('tok');
    expect(init.credentials).toBe('include');
    expect(result.ok && result.value.items.map((row) => row.id)).toEqual([A]);
  });

  it('maps a guest, a missing conversation and a bad body', async () => {
    const guest = await listConversations(SETUP, null, new AbortController().signal, () =>
      json({ code: 'assistant.sign-in-required' }, 403),
    );
    expect(guest).toEqual({ ok: false, refusal: { kind: 'sign-in' } });
    const gone = await readConversation(SETUP, A, new AbortController().signal, () =>
      json({ code: 'assistant.conversation-not-found' }, 404),
    );
    expect(gone).toEqual({ ok: false, refusal: { kind: 'lost' } });
    const bad = await readConversation(SETUP, A, new AbortController().signal, () =>
      json({ nope: true }),
    );
    expect(bad).toEqual({ ok: false, refusal: { kind: 'error' } });
  });

  it('deletes with the CSRF header and takes the empty 204', async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 })));
    const result = await deleteConversation(SETUP, A, fetcher);
    expect(result).toEqual({ ok: true, value: true });
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.example.test/assistant/conversations/${A}`);
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>)['X-CSRF-Token']).toBe(
      'csrf-1',
    );
    expect(fetcher.mock.calls[0]![1]!.method).toBe('DELETE');
  });

  it('posts feedback as a closed body: a reason only with down', async () => {
    const fetcher = vi.fn<typeof fetch>(() => json({ rating: 'down', reason: 'wrong' }));
    await sendFeedback(SETUP, A, 4, 'down', 'wrong', fetcher);
    await sendFeedback(SETUP, A, 4, 'up', 'wrong', fetcher);
    expect(fetcher.mock.calls[0]![0]).toBe(
      `https://api.example.test/assistant/conversations/${A}/messages/4/feedback`,
    );
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({
      rating: 'down',
      reason: 'wrong',
    });
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({ rating: 'up' });
  });

  it('sends no CSRF token for a guest', async () => {
    const fetcher = vi.fn<typeof fetch>(() => json({ rating: 'up', reason: null }));
    await sendFeedback({ ...SETUP, csrfToken: null }, A, 2, 'up', null, fetcher);
    expect(
      (fetcher.mock.calls[0]![1]!.headers as Record<string, string>)['X-CSRF-Token'],
    ).toBeUndefined();
  });
});

describe('history parsers', () => {
  it('reads a transcript, rebuilds pages and support, and never shows old product cards', () => {
    const stored = storedConversationOf({
      ...summary(A, 'Halal'),
      messages: [
        {
          position: 2,
          role: 'assistant',
          text: 'Here.',
          at: 'x',
          cards: [
            { kind: 'product', offerId: B },
            { kind: 'seller', sellerId: B },
            { kind: 'page', page: 'cart' },
            { kind: 'page', page: 'category' },
            { kind: 'support' },
          ],
        },
        { position: 1, role: 'user', text: 'hi', at: 'x', cards: [] },
      ],
    });
    expect(stored?.messages.map((m) => m.position)).toEqual([1, 2]);
    const reply = stored!.messages[1]!;
    expect(reply.hadListings).toBe(true);
    expect(reply.support).toBe(true);
    expect(reply.pages).toEqual([{ kind: 'page', page: 'cart', categoryId: null }]);
  });

  it('refuses a transcript with a bad id, position, role or date', () => {
    expect(storedConversationOf({ ...summary('x', 't'), messages: [] })).toBeNull();
    expect(
      storedConversationOf({
        ...summary(A, 't'),
        messages: [{ position: 0, role: 'user', text: 'a', cards: [] }],
      }),
    ).toBeNull();
    expect(
      storedConversationOf({
        ...summary(A, 't'),
        messages: [{ position: 1, role: 'system', text: 'a', cards: [] }],
      }),
    ).toBeNull();
    expect(
      storedConversationOf({ ...summary(A, 't'), lastMessageAt: 'soon', messages: [] }),
    ).toBeNull();
  });

  it('refuses a cursor that could bend a query', () => {
    expect(conversationPageOf({ items: [], nextCursor: 'a&b=1' })).toBeNull();
    expect(conversationPageOf({ items: [], nextCursor: 'ok_1' })).toEqual({
      items: [],
      nextCursor: 'ok_1',
    });
  });
});
