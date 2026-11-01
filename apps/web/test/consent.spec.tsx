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
const incoming = vi.hoisted(() => ({ host: 'storefront.localhost:3003' }));
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve(jar),
  headers: () => Promise.resolve(new Headers({ host: incoming.host })),
}));

beforeEach(() => {
  nav.pathname = '/';
  incoming.host = 'storefront.localhost:3003';
  vi.stubEnv('STOREFRONT_HOSTS', 'http://storefront.localhost:3003=AU');
  vi.stubEnv('STOREFRONT_GA4_IDS', '');
  jar.set.mockReset();
  jar.getAll.mockReset().mockReturnValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const withIntl = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

describe('consent cookie value', () => {
  it('reads back what it writes', () => {
    for (const personalization of [true, false])
      for (const analytics of [true, false]) {
        const consent = { personalization, analytics };
        expect(consentOf(consentValue(consent))).toEqual(consent);
      }
    expect(consentValue({ personalization: true, analytics: false })).toBe('v2.p1.a0');
  });

  it('asks again when the value is missing, malformed, from version 1 or from a later one', () => {
    expect(consentOf(undefined)).toBeNull();
    expect(consentOf('yes')).toBeNull();
    expect(consentOf('v1.p1')).toBeNull();
    expect(consentOf('v2.p1')).toBeNull();
    expect(consentOf(`v${CONSENT_VERSION + 1}.p1.a1`)).toBeNull();
  });
});

describe('engagement request', () => {
  it('sends nothing without Personalization', () => {
    expect(engagementRequest({ kind: 'view' }, null)).toBeNull();
    expect(
      engagementRequest({ kind: 'view' }, { personalization: false, analytics: false }),
    ).toBeNull();
  });

  it('carries the consent header once accepted', () => {
    const init = engagementRequest({ kind: 'view' }, { personalization: true, analytics: false });
    expect(init?.headers).toMatchObject({ [ENGAGEMENT_CONSENT_HEADER]: 'granted' });
  });
});

describe('saveConsent', () => {
  it('keeps the choice in a one-year Secure Lax cookie', async () => {
    await saveConsent(true, false);
    expect(jar.set).toHaveBeenCalledTimes(1);
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p1.a0', {
      path: '/',
      maxAge: 31536000,
      sameSite: 'lax',
      secure: true,
      httpOnly: true,
    });
  });

  it('deletes the behaviour cookie when Personalization is off', async () => {
    jar.getAll.mockReturnValue([
      { name: '__Host-engagement-guest-AU' },
      { name: '__Host-cart-guest-AU' },
      { name: 'sf-palette' },
    ]);
    await saveConsent(false, false);
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p0.a0', expect.anything());
    expect(jar.set).toHaveBeenCalledWith(
      '__Host-engagement-guest-AU',
      '',
      expect.objectContaining({ maxAge: 0, path: '/', secure: true }),
    );
    expect(jar.set).toHaveBeenCalledTimes(2);
  });

  describe('with a measurement ID for the Market', () => {
    beforeEach(() => {
      vi.stubEnv('STOREFRONT_GA4_IDS', 'AU=G-ABC123XYZ9');
    });

    it('keeps Analytics on when the buyer chose it', async () => {
      await saveConsent(false, true);
      expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p0.a1', expect.anything());
    });

    it('deletes _ga and _ga_* when Analytics is withdrawn, and only those', async () => {
      jar.getAll.mockReturnValue([
        { name: '_ga' },
        { name: '_ga_ABC123XYZ9' },
        { name: '_gat' },
        { name: '__Host-engagement-guest-AU' },
        { name: 'sf-palette' },
      ]);
      await saveConsent(true, false);
      expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p1.a0', expect.anything());
      for (const name of ['_ga', '_ga_ABC123XYZ9'])
        expect(jar.set).toHaveBeenCalledWith(
          name,
          '',
          expect.objectContaining({ maxAge: 0, path: '/' }),
        );
      expect(jar.set).toHaveBeenCalledTimes(3);
    });

    it('does not keep Analytics for a host with no ID', async () => {
      incoming.host = 'other.localhost:3003';
      vi.stubEnv(
        'STOREFRONT_HOSTS',
        'http://storefront.localhost:3003=AU,http://other.localhost:3003=NZ',
      );
      await saveConsent(true, true);
      expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p1.a0', expect.anything());
    });
  });
});

describe('cookie bar', () => {
  it('is a labelled region with Accept, Reject and Settings of equal weight', () => {
    withIntl(<ConsentBar initial={null} />);
    const region = screen.getByRole('region', { name: 'Cookies on Mondapac' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const accept = screen.getByRole('button', { name: 'Accept all' });
    const reject = screen.getByRole('button', { name: 'Necessary only' });
    // The Settings button of the tablet and desktop bar (the phone's compact bar has an inline
    // link of the same name, below).
    const settings = region.querySelector<HTMLAnchorElement>('.consent-actions a')!;
    expect(settings.textContent).toBe('Cookie settings');
    expect(settings.getAttribute('href')).toBe('/cookies');
    expect(new Set([accept.className, reject.className, settings.className])).toEqual(
      new Set(['btn']),
    );
    expect(region.contains(document.activeElement)).toBe(false);
  });

  it('carries the compact phone summary with Cookie settings as an inline link', () => {
    withIntl(<ConsentBar initial={null} />);
    const short = document.querySelector('.consent-short')!;
    expect(short.textContent).toBe(
      'We use cookies to run the shop and, if you agree, to suggest products. Cookie settings',
    );
    const links = screen.getAllByRole('link', { name: 'Cookie settings' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/cookies', '/cookies']);
    expect(short.querySelector('a')?.className).toBe('');
  });

  it('does not count Escape as a choice', () => {
    withIntl(<ConsentBar initial={null} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(jar.set).not.toHaveBeenCalled();
    expect(screen.getByRole('region')).toBeTruthy();
  });

  it.each([
    ['Accept all', 'v2.p1.a0'],
    ['Necessary only', 'v2.p0.a0'],
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

  it('closes when the layout passes a choice saved elsewhere', () => {
    const view = withIntl(<ConsentBar initial={null} />);
    expect(screen.getByRole('region')).toBeTruthy();
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <ConsentBar initial={{ personalization: true, analytics: false }} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('is not shown once chosen, nor on the cookie settings page', () => {
    withIntl(<ConsentBar initial={{ personalization: false, analytics: false }} />);
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
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p1.a0', expect.anything());
    expect(screen.getByRole('status').textContent).toBe(messages.cookies.saved);
    expect(screen.queryByRole('switch', { name: /Analytics/ })).toBeNull();
  });

  it('withdraws an earlier Accept', async () => {
    jar.getAll.mockReturnValue([{ name: '__Host-engagement-guest-AU' }]);
    withIntl(<CookieSettings initial={{ personalization: true, analytics: false }} />);
    fireEvent.click(screen.getByRole('switch'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
      await Promise.resolve();
    });
    expect(jar.set).toHaveBeenCalledWith('__Host-engagement-guest-AU', '', expect.anything());
    expect(screen.getByRole('status').textContent).toBe(messages.cookies.saved);
  });
});

describe('analytics in the cookie bar and settings', () => {
  beforeEach(() => {
    vi.stubEnv('STOREFRONT_GA4_IDS', 'AU=G-ABC123XYZ9');
  });

  it('Accept all turns both on when the Market has an ID', async () => {
    withIntl(<ConsentBar initial={null} analyticsAvailable />);
    expect(document.querySelector('.consent-long')?.textContent).toContain('outside Australia');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
      await Promise.resolve();
    });
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p1.a1', expect.anything());
  });

  it('shows an Analytics switch only where the Market has an ID, with the disclosure', () => {
    withIntl(<CookieSettings initial={null} analyticsAvailable />);
    const toggle = screen.getByRole<HTMLInputElement>('switch', { name: /Analytics/ });
    expect(toggle.checked).toBe(false);
    expect(toggle.closest('label')?.textContent).toContain(
      'Analytics data is processed by Google outside Australia.',
    );
  });

  it('saves Personalization and Analytics separately', async () => {
    withIntl(<CookieSettings initial={null} analyticsAvailable />);
    fireEvent.click(screen.getByRole('switch', { name: /Analytics/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
      await Promise.resolve();
    });
    expect(jar.set).toHaveBeenCalledWith('sf-consent', 'v2.p0.a1', expect.anything());
  });
});
