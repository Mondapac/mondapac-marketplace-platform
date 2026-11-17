import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Config from '../src/storefront/config.ts';
import { loadAssistant } from '../src/storefront/source.ts';

// loadAssistant: what the server render knows of the buyer assistant, and when it is off.

const state = vi.hoisted(() => {
  const initial: {
    config: unknown;
    host: unknown;
    email: unknown;
    cookies: string[];
    sessionReads: number;
    session: unknown;
  } = {
    config: null,
    host: undefined,
    email: 'help@example.test',
    cookies: [],
    sessionReads: 0,
    session: { kind: 'ok', body: { csrfToken: 'csrf-1' } },
  };
  return initial;
});

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'storefront.localhost:3003' })),
  cookies: () => Promise.resolve({ has: (name: string) => state.cookies.includes(name) }),
}));
vi.mock('next-intl/server', () => ({
  getLocale: () => Promise.resolve('en'),
  getTranslations: () => Promise.resolve(() => state.email),
}));
vi.mock('../src/storefront/config.ts', async (original) => ({
  ...(await original<typeof Config>()),
  storefrontApiConfig: () => state.config,
  storefrontHostFor: () => state.host,
}));
vi.mock('../src/storefront/session.ts', () => ({
  sessionGet: () => {
    state.sessionReads += 1;
    return Promise.resolve(state.session);
  },
}));

beforeEach(() => {
  state.config = { marketId: 'AU' };
  state.host = { marketId: 'AU' };
  state.email = 'help@example.test';
  state.cookies = [];
  state.sessionReads = 0;
  state.session = { kind: 'ok', body: { csrfToken: 'csrf-1' } };
});

describe('loadAssistant', () => {
  it('is off with no API configured', async () => {
    state.config = null;
    expect(await loadAssistant()).toBeNull();
  });

  it('is off for a host that is not listed', async () => {
    state.host = undefined;
    expect(await loadAssistant()).toBeNull();
  });

  it('is off when the support address is not a plain, valid one', async () => {
    for (const bad of ['', 'not an email', 'a..b@example.test', 5, undefined]) {
      state.email = bad;
      expect(await loadAssistant(), String(bad)).toBeNull();
    }
  });

  it('answers the relay route and the support address, with no CSRF token for a guest', async () => {
    expect(await loadAssistant()).toEqual({
      chatUrl: '/api/assistant',
      supportEmail: 'help@example.test',
      csrfToken: null,
    });
    expect(state.sessionReads).toBe(0);
  });

  it('reads the session only when the session cookie exists', async () => {
    state.cookies = ['__Host-session-customer-AU'];
    expect((await loadAssistant())?.csrfToken).toBe('csrf-1');
    expect(state.sessionReads).toBe(1);
  });

  it('keeps the assistant on without a token when the session read fails', async () => {
    state.cookies = ['__Host-session-customer-AU'];
    state.session = { kind: 'failed', status: 500 };
    expect((await loadAssistant())?.csrfToken).toBeNull();
  });
});
