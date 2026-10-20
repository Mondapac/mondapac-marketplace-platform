// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { AssistantWidget } from '../src/assistant/assistant-widget.tsx';
import {
  newConversationId,
  pagePath,
  refusalOf,
  replyOf,
  searchPath,
  sendMessage,
  type AssistantSetup,
  type SendResult,
} from '../src/assistant/assistant.ts';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { StoreShell } from '../src/shell/store-shell.tsx';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: push }),
  usePathname: () => '/',
  useSearchParams: () => null,
}));

const SETUP: AssistantSetup = {
  chatUrl: 'https://api.example.test/assistant',
  guestsAllowed: true,
  welcomeText: null,
  supportEmail: 'help@example.test',
  retentionDays: 30,
  csrfToken: null,
};

const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const STREAM =
  frame('conversation', { id: '0192f000-0000-7000-8000-000000000001' }) +
  frame('card', {
    kind: 'product',
    offerId: '0192f000-0000-7000-8000-0000000000a1',
    productId: '0192f000-0000-7000-8000-0000000000b1',
    sellerId: '0192f000-0000-7000-8000-0000000000c1',
    name: 'Free-range chicken',
    shortText: 'Whole bird',
    price: { amount: '1299', currency: 'AUD' },
    regularPrice: null,
    taxInclusive: true,
  }) +
  frame('card', { kind: 'page', page: 'cart', categoryId: null }) +
  frame('card', { kind: 'unknown' }) +
  frame('text', { text: 'Here are two products.' }) +
  frame('notice', { code: 'see-cards' }) +
  frame('notice', { code: 'not-a-notice' }) +
  frame('done', {});

const ok = (
  sentences: string[],
  extra: Partial<Extract<SendResult, { ok: true }>['reply']> = {},
): SendResult => ({
  ok: true,
  reply: {
    conversationId: 'c',
    sentences,
    products: [],
    pages: [],
    support: false,
    notices: [],
    ...extra,
  },
});

let sheet = false;
beforeEach(() => {
  sheet = false;
  push.mockClear();
  window.matchMedia = ((query: string) => ({
    matches: sheet && query === '(max-width: 700px)',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

function renderWidget(
  send: (...args: Parameters<typeof sendMessage>) => Promise<SendResult>,
  setup: AssistantSetup = SETUP,
) {
  const wrap = (node: ReactNode) => (
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>{node}</StoreProvider>
    </NextIntlClientProvider>
  );
  return render(wrap(<AssistantWidget setup={setup} send={send} />));
}

const launcher = () => screen.getByRole('button', { name: 'Ask the assistant' });
const box = () => screen.getByLabelText('Message to the assistant');
async function say(text: string) {
  fireEvent.change(box(), { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await Promise.resolve();
  });
}

describe('assistant stream', () => {
  it('reads the cards, sentences and notices of a whole answer and drops prices', () => {
    const reply = replyOf(STREAM);
    expect(reply).toEqual({
      conversationId: '0192f000-0000-7000-8000-000000000001',
      sentences: ['Here are two products.'],
      products: [
        {
          kind: 'product',
          offerId: '0192f000-0000-7000-8000-0000000000a1',
          productId: '0192f000-0000-7000-8000-0000000000b1',
          sellerId: '0192f000-0000-7000-8000-0000000000c1',
          name: 'Free-range chicken',
          shortText: 'Whole bird',
        },
      ],
      pages: [{ kind: 'page', page: 'cart', categoryId: null }],
      support: false,
      notices: ['see-cards'],
    });
  });

  it('drops cards whose ids are not UUIDs, so no id can bend a link', () => {
    const bent = replyOf(
      frame('conversation', { id: 'c' }) +
        frame('card', {
          kind: 'product',
          offerId: '..',
          productId: '..',
          sellerId: 's',
          name: 'X',
        }) +
        frame('card', { kind: 'page', page: 'category', categoryId: '../account' }) +
        frame('done', {}),
    );
    expect(bent?.products).toEqual([]);
    expect(bent?.pages).toEqual([]);
  });

  it('treats a stream without done, or with broken JSON, as no answer', () => {
    expect(replyOf(STREAM.replace(frame('done', {}), ''))).toBeNull();
    expect(replyOf('event: conversation\ndata: {oops\n\n')).toBeNull();
  });

  it('maps each refusal of the endpoint to what the widget shows', () => {
    expect(refusalOf(403, 'assistant.off', null)).toEqual({ kind: 'off' });
    expect(refusalOf(403, 'assistant.sign-in-required', null)).toEqual({ kind: 'sign-in' });
    expect(refusalOf(503, 'assistant.paused', null)).toEqual({ kind: 'unavailable' });
    expect(refusalOf(503, 'access.unavailable', null)).toEqual({ kind: 'unavailable' });
    expect(refusalOf(409, 'assistant.conversation-full', null)).toEqual({ kind: 'full' });
    expect(refusalOf(404, 'assistant.conversation-not-found', null)).toEqual({ kind: 'lost' });
    expect(refusalOf(429, 'request.throttled', '120')).toEqual({
      kind: 'limit',
      retryAfterSeconds: 120,
    });
    expect(refusalOf(429, 'request.throttled', null)).toEqual({
      kind: 'limit',
      retryAfterSeconds: 60,
    });
    expect(refusalOf(400, 'validation.failed', null)).toEqual({ kind: 'error' });
    expect(refusalOf(500, 'internal', null)).toEqual({ kind: 'error' });
  });

  it('posts the message as JSON with the visitor id and, for a customer, the CSRF token', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(new Response(STREAM, { headers: { 'Content-Type': 'text/event-stream' } })),
    );
    const result = await sendMessage(
      { ...SETUP, csrfToken: 'tok' },
      'conv-1',
      'chicken',
      'visitor-0123456789abcdef',
      new AbortController().signal,
      fetcher,
    );
    expect(result.ok).toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/assistant/conversations/conv-1/messages');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'tok',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'chicken',
      visitor: 'visitor-0123456789abcdef',
    });
  });

  it('reads a JSON refusal and its Retry-After', async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ statusCode: 429, code: 'request.throttled' }), {
          status: 429,
          headers: { 'Retry-After': '90' },
        }),
      ),
    );
    const result = await sendMessage(SETUP, 'c', 'hi', null, new AbortController().signal, fetcher);
    expect(result).toEqual({ ok: false, refusal: { kind: 'limit', retryAfterSeconds: 90 } });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ text: 'hi' });
    expect(init.headers).not.toHaveProperty('X-CSRF-Token');
  });

  it('makes canonical UUID v7 conversation ids and builds every link in code', () => {
    expect(newConversationId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(pagePath({ kind: 'page', page: 'category', categoryId: 'meat' })).toBe('/c/meat');
    expect(pagePath({ kind: 'page', page: 'category', categoryId: null })).toBeNull();
    expect(pagePath({ kind: 'page', page: 'personalization', categoryId: null })).toBe(
      '/account/personalization',
    );
    expect(searchPath(' halal lamb ')).toBe('/search?q=halal%20lamb');
  });
});

describe('assistant widget', () => {
  const shell = (assistant: AssistantSetup | null) =>
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreShell
          content={SAMPLE_CONTENT}
          cartSource={SAMPLE_CART_SOURCE}
          consent={null}
          signIn={SAMPLE_CHECKOUT.customer}
          assistant={assistant}
        >
          <p>page</p>
        </StoreShell>
      </NextIntlClientProvider>,
    );

  it('shows nothing while the assistant is off, and the launcher once it is on', () => {
    shell(null);
    expect(screen.queryByRole('button', { name: 'Ask the assistant' })).toBeNull();
    expect(document.querySelector('.asw')).toBeNull();
    cleanup();
    shell(SETUP);
    expect(launcher()).toBeTruthy();
  });

  it('opens a docked, non-modal panel with the welcome and quick prompts; Esc closes it', () => {
    renderWidget(() => Promise.resolve(ok([])));
    expect(launcher().getAttribute('aria-expanded')).toBe('false');
    launcher().focus();
    fireEvent.click(launcher());
    const panel = screen.getByRole('dialog', { name: 'Shopping assistant' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(document.activeElement).toBe(box());
    expect(within(panel).getByText(messages.assistant.welcome)).toBeTruthy();
    const prompts = within(panel).getByRole('group', { name: 'Suggested questions' });
    expect(
      within(prompts)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      'Show halal meat',
      'What is on special?',
      'What is in my cart?',
      'How does delivery work?',
    ]);
    expect(box().getAttribute('maxlength')).toBe('500');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(launcher());
  });

  it('is a modal sheet on a phone with focus on Close', () => {
    sheet = true;
    renderWidget(() => Promise.resolve(ok([])));
    fireEvent.click(launcher());
    const panel = screen.getByRole('dialog', { name: 'Shopping assistant' });
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close assistant' }));
  });

  it('shows the admin welcome text instead of the default', () => {
    renderWidget(() => Promise.resolve(ok([])), { ...SETUP, welcomeText: 'Salam! Ask me.' });
    fireEvent.click(launcher());
    expect(screen.getByText('Salam! Ask me.')).toBeTruthy();
  });

  it('lists products as links to their pages without a price, then See all results', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true, reply: replyOf(STREAM)! } as SendResult));
    renderWidget(send);
    fireEvent.click(launcher());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show halal meat' }));
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as unknown[])[2]).toBe('Show halal meat');
    const log = screen.getByRole('log');
    const link = within(log).getByRole('link', { name: 'Free-range chicken' });
    expect(link.getAttribute('href')).toBe('/p/0192f000-0000-7000-8000-0000000000b1');
    expect(log.textContent).not.toMatch(/\$|12\.99|1299/);
    expect(within(log).getByText('Here are two products.')).toBeTruthy();
    // The product note already says it; the notice is not repeated.
    expect(within(log).queryByText(messages.assistant['notice-see-cards'])).toBeNull();
    expect(within(log).getByText(messages.assistant['product-note'])).toBeTruthy();
    fireEvent.click(within(log).getByRole('button', { name: 'See all results' }));
    expect(push).toHaveBeenCalledWith('/search?q=Show%20halal%20meat');
    fireEvent.click(within(log).getByRole('button', { name: 'View cart' }));
    expect(push).toHaveBeenCalledWith('/cart');
  });

  it('renders model text inert: markup and links stay plain text', async () => {
    renderWidget(() =>
      Promise.resolve(
        ok(['<b>Bold</b> <a href="https://evil.test">click</a> <img src=x onerror=alert(1)>']),
      ),
    );
    fireEvent.click(launcher());
    await say('hi');
    const log = screen.getByRole('log');
    expect(log.querySelector('b, img, a[href^="https://evil"]')).toBeNull();
    expect(log.textContent).toContain('<a href="https://evil.test">click</a>');
  });

  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    const send = vi.fn(() => Promise.resolve(ok(['Sure.'])));
    renderWidget(send);
    fireEvent.click(launcher());
    fireEvent.change(box(), { target: { value: 'line one' } });
    fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(box(), { key: 'Enter' });
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByText('line one')).toBeTruthy();
    expect((box() as HTMLTextAreaElement).value).toBe('');
  });

  it('shows the error with Try again, which sends the same text once more', async () => {
    const send = vi
      .fn<(...args: Parameters<typeof sendMessage>) => Promise<SendResult>>()
      .mockResolvedValueOnce({ ok: false, refusal: { kind: 'error' } })
      .mockResolvedValueOnce(ok(['Found it.']));
    renderWidget(send);
    fireEvent.click(launcher());
    await say('lamb');
    expect(screen.getByRole('alert').textContent).toContain(messages.assistant.error);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![2]).toBe('lamb');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByText('lamb')).toHaveLength(1);
    expect(screen.getByText('Found it.')).toBeTruthy();
  });

  it('offers support after two misses in a row', async () => {
    renderWidget(() => Promise.resolve({ ok: false, refusal: { kind: 'error' } }));
    fireEvent.click(launcher());
    await say('one');
    expect(screen.queryByRole('link', { name: 'Email support' })).toBeNull();
    await say('two');
    expect(screen.getByRole('link', { name: 'Email support' }).getAttribute('href')).toBe(
      'mailto:help@example.test',
    );
  });

  it('disables the message box at the message limit', async () => {
    renderWidget(() =>
      Promise.resolve({ ok: false, refusal: { kind: 'limit', retryAfterSeconds: 60 } }),
    );
    fireEvent.click(launcher());
    await say('again');
    expect(screen.getByText(messages.assistant.limit)).toBeTruthy();
    expect((box() as HTMLTextAreaElement).disabled).toBe(true);
  });

  it('turns into the switched-off state, with search and support but no message box', async () => {
    renderWidget(() => Promise.resolve({ ok: false, refusal: { kind: 'off' } }));
    fireEvent.click(launcher());
    await say('hello');
    expect(screen.getByText(messages.assistant['off-title'])).toBeTruthy();
    expect(screen.queryByLabelText('Message to the assistant')).toBeNull();
    expect(screen.getByRole('link', { name: 'Talk to support' }).getAttribute('href')).toBe(
      'mailto:help@example.test',
    );
    fireEvent.change(screen.getByLabelText('Search products'), { target: { value: 'dates' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(push).toHaveBeenCalledWith('/search?q=dates');
  });

  it('asks a guest to log in when guests may not chat', () => {
    renderWidget(() => Promise.resolve(ok([])), { ...SETUP, guestsAllowed: false });
    fireEvent.click(launcher());
    expect(screen.getByText(messages.assistant['sign-in-title'])).toBeTruthy();
    expect(screen.queryByLabelText('Message to the assistant')).toBeNull();
  });

  it('Stop ends the wait and changes nothing', async () => {
    renderWidget(
      (_setup, _id, _text, _visitor, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ ok: false, refusal: { kind: 'error' } }),
          );
        }),
    );
    fireEvent.click(launcher());
    await say('slow one');
    expect(screen.getByRole('status', { name: 'Assistant is typing' })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
      await Promise.resolve();
    });
    expect(screen.getByText(messages.assistant.stopped)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says sorry and offers support after a thumbs down', async () => {
    renderWidget(() => Promise.resolve(ok(['Here you go.'])));
    fireEvent.click(launcher());
    await say('dates');
    const bad = screen.getByRole('button', { name: 'Bad answer' });
    fireEvent.click(bad);
    expect(bad.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(messages.assistant.sorry)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Email support' })).toBeTruthy();
  });

  it('drops a pending answer when a new chat starts', async () => {
    let answer: (result: SendResult) => void = () => undefined;
    renderWidget(() => new Promise((resolve) => (answer = resolve)));
    fireEvent.click(launcher());
    await say('old question');
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }));
    await act(async () => {
      answer(ok(['Late answer.']));
      await Promise.resolve();
    });
    expect(screen.queryByText('Late answer.')).toBeNull();
    expect(screen.queryByText(messages.assistant.stopped)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('starts a new chat from the welcome again', async () => {
    renderWidget(() => Promise.resolve(ok(['Answer one.'])));
    fireEvent.click(launcher());
    await say('first');
    fireEvent.click(screen.getByRole('button', { name: 'Start a new chat' }));
    expect(screen.queryByText('Answer one.')).toBeNull();
    expect(screen.getByText(messages.assistant.welcome)).toBeTruthy();
  });
});
