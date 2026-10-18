// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { ConsentBar } from '../src/consent/consent-bar.tsx';
import { CONSENT_VERSION, consentOf, consentValue } from '../src/consent/consent.ts';
import { CookieSettings } from '../src/consent/cookie-settings.tsx';
import { saveConsent } from '../src/consent/save-consent.ts';
import { ENGAGEMENT_CONSENT_HEADER, engagementRequest } from '../src/storefront/engagement.ts';

const nav = vi.hoisted(() => ({ pathname: '/' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

const jar = vi.hoisted(() => ({
  set: vi.fn(),
  getAll: vi.fn(() => [] as { name: string }[]),
}));
vi.mock('next/headers', () => ({ cookies: () => Promise.resolve(jar) }));

beforeEach(() => {
  nav.pathname = '/';
  jar.set.mockReset();
  jar.getAll.mockReset().mockReturnValue([]);
});
afterEach(cleanup);

const withIntl = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

describe('consent cookie value', () => {
  it('reads back what it writes', () => {
    expect(consentOf(consentValue({ personalization: true }))).toEqual({ personalization: true });
    expect(consentOf(consentValue({ personalization: false }))).toEqual({
      personalization: false,
    });
  });

  it('asks again when the value is missing, malformed or from another version', () => {
    expect(consentOf(undefined)).toBeNull();
    expect(consentOf('yes')).toBeNull();
    expect(consentOf(`v${CONSENT_VERSION + 1}.p1`)).toBeNull();
  });
});

describe('engagement request', () => {
  it('sends nothing without Personalization', () => {
    expect(engagementRequest({ kind: 'view' }, null)).toBeNull();
    expect(engagementRequest({ kind: 'view' }, { personalization: false })).toBeNull();
  });

  it('carries the consent header once accepted', () => {
    const init = engagementRequest({ kind: 'view' }, { personalization: true });
    expect(init?.headers).toMatchObject({ [ENGAGEMENT_CONSENT_HEADER]: 'granted' });
  });
});

describe('saveConsent', () => {
  it('keeps the choice in a one-year Secure Lax cookie', async () => {
    await saveConsent(true);
    expect(jar.set).toHaveBeenCalledTimes(1);
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v1.p1', {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      secure: true,
    });
  });

  it('deletes the behaviour cookie when Personalization is off', async () => {
    jar.getAll.mockReturnValue([
      { name: '__Host-engagement-guest-AU' },
      { name: '__Host-cart-guest-AU' },
      { name: 'sf-palette' },
    ]);
    await saveConsent(false);
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v1.p0', expect.anything());
    expect(jar.set).toHaveBeenCalledWith(
      '__Host-engagement-guest-AU',
      '',
      expect.objectContaining({ maxAge: 0, path: '/', secure: true }),
    );
    expect(jar.set).toHaveBeenCalledTimes(2);
  });
});

describe('cookie bar', () => {
  it('is a labelled region with Accept, Reject and Settings of equal weight', () => {
    withIntl(<ConsentBar initial={null} />);
    const region = screen.getByRole('region', { name: 'Cookies on Mondapac' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const accept = screen.getByRole('button', { name: 'Accept all' });
    const reject = screen.getByRole('button', { name: 'Necessary only' });
    const settings = screen.getByRole('link', { name: 'Cookie settings' });
    expect(settings.getAttribute('href')).toBe('/cookies');
    expect(new Set([accept.className, reject.className, settings.className])).toEqual(
      new Set(['btn']),
    );
    expect(region.contains(document.activeElement)).toBe(false);
  });

  it('does not count Escape as a choice', () => {
    withIntl(<ConsentBar initial={null} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(jar.set).not.toHaveBeenCalled();
    expect(screen.getByRole('region')).toBeTruthy();
  });

  it.each([
    ['Accept all', 'v1.p1'],
    ['Necessary only', 'v1.p0'],
  ])('%s saves the choice and closes', async (name, value) => {
    withIntl(<ConsentBar initial={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
      await Promise.resolve();
    });
    expect(jar.set).toHaveBeenCalledWith('sf-consent', value, expect.anything());
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('stays open with an error when saving fails', async () => {
    jar.set.mockImplementationOnce(() => {
      throw new Error('offline');
    });
    withIntl(<ConsentBar initial={null} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toBe(messages.consent.error);
    expect(screen.getByRole('region')).toBeTruthy();
  });

  it('is not shown once chosen, nor on the cookie settings page', () => {
    withIntl(<ConsentBar initial={{ personalization: false }} />);
    expect(screen.queryByRole('region')).toBeNull();
    cleanup();
    nav.pathname = '/cookies';
    withIntl(<ConsentBar initial={null} />);
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('cookie settings', () => {
  it('starts off without a choice and saves Personalization on', async () => {
    withIntl(<CookieSettings initial={null} />);
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: /Personalization/ });
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
      await Promise.resolve();
    });
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v1.p1', expect.anything());
    expect(screen.getByRole('status').textContent).toBe(messages.cookies['saved-on']);
  });

  it('withdraws an earlier Accept', async () => {
    jar.getAll.mockReturnValue([{ name: '__Host-engagement-guest-AU' }]);
    withIntl(<CookieSettings initial={{ personalization: true }} />);
    fireEvent.click(screen.getByRole('switch'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
      await Promise.resolve();
    });
    expect(jar.set).toHaveBeenCalledWith('__Host-engagement-guest-AU', '', expect.anything());
    expect(screen.getByRole('status').textContent).toBe(messages.cookies['saved-off']);
  });
});
