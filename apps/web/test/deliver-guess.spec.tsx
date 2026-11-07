// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { DeliverModal } from '../src/delivery/deliver-modal.tsx';
import { geoGuessOf, parseGeoGuessConfig } from '../src/delivery/geo-guess.ts';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SAMPLE_DELIVERY_LOCATOR as SOURCE } from '../src/storefront/sample-delivery.ts';
import type { DeliverTo } from '../src/delivery/deliver-to.ts';

vi.mock('../src/checkout/actions.ts', () => ({ deliveryAreaFor: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

const CLOUDFLARE = {
  EDGE_GEO_CITY_HEADER: 'CF-IPCity',
  EDGE_GEO_POSTCODE_HEADER: 'cf-postal-code',
};

describe('first-visit area guess configuration', () => {
  it('is off when neither header is named', () => {
    expect(parseGeoGuessConfig({})).toBeNull();
  });

  it('refuses one header without the other and malformed names', () => {
    expect(() => parseGeoGuessConfig({ EDGE_GEO_CITY_HEADER: 'cf-ipcity' })).toThrow(/together/);
    expect(() =>
      parseGeoGuessConfig({ EDGE_GEO_CITY_HEADER: 'cf ipcity', EDGE_GEO_POSTCODE_HEADER: 'x' }),
    ).toThrow();
  });

  it('reads the names in lower case', () => {
    expect(parseGeoGuessConfig(CLOUDFLARE)).toEqual({
      cityHeader: 'cf-ipcity',
      postcodeHeader: 'cf-postal-code',
    });
  });
});

describe('first-visit area guess', () => {
  const config = parseGeoGuessConfig(CLOUDFLARE);

  it('names the area the edge headers give', () => {
    const incoming = new Headers({ 'cf-ipcity': 'Brisbane', 'cf-postal-code': '4000' });
    expect(geoGuessOf(config, incoming)).toEqual({ suburb: 'Brisbane', postcode: '4000' });
  });

  it('decodes a percent-encoded city', () => {
    const incoming = new Headers({ 'cf-ipcity': 'S%C3%A3o%20Paulo', 'cf-postal-code': '01000' });
    expect(geoGuessOf(config, incoming)).toEqual({ suburb: 'São Paulo', postcode: '01000' });
  });

  it('guesses nothing when off, missing or implausible', () => {
    expect(
      geoGuessOf(null, new Headers({ 'cf-ipcity': 'Brisbane', 'cf-postal-code': '4000' })),
    ).toBeNull();
    expect(geoGuessOf(config, new Headers({ 'cf-ipcity': 'Brisbane' }))).toBeNull();
    for (const [city, postcode] of [
      ['<script>', '4000'],
      ['Brisbane', '4000|x'],
      ['%E0%A4%A', '4000'],
      ['x'.repeat(61), '4000'],
    ])
      expect(
        geoGuessOf(config, new Headers({ 'cf-ipcity': city!, 'cf-postal-code': postcode! })),
        city,
      ).toBeNull();
  });
});

describe('header and modal with a guessed area', () => {
  beforeEach(() => {
    document.cookie = 'sf-deliver-to=; Max-Age=0; Path=/';
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    Element.prototype.getClientRects = function () {
      return [{}] as unknown as DOMRectList;
    };
  });
  afterEach(() => cleanup());

  function renderWith(deliverTo: DeliverTo | null, deliverGuess: DeliverTo | null) {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider initialDeliverTo={deliverTo} deliverGuess={deliverGuess}>
          <Header delivery={{ label: 'Brisbane 4000' }} />
          <DeliverModal source={SOURCE} />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
  }
  const deliverButton = () => screen.getByRole('button', { name: /^Delivery area/ });

  it('shows "Near" the guessed area, stores nothing, and says how it was found', async () => {
    renderWith(null, { suburb: 'Kedron', postcode: '4031' });
    expect(deliverButton().textContent).toContain('Near Kedron 4031');
    expect(document.cookie).not.toContain('sf-deliver-to');
    await act(() => {
      fireEvent.click(deliverButton());
      return Promise.resolve();
    });
    expect(screen.getByText(/We guessed your area from your internet connection/)).toBeTruthy();
    // The modal starts at the guessed suburb, for the buyer to confirm.
    const dialog = screen.getByRole('dialog', { name: 'Choose where to deliver' });
    expect(dialog.querySelector('.lmsel')?.textContent).toContain('Kedron');
  });

  it('prefers a confirmed location and drops the estimate line', async () => {
    renderWith({ suburb: 'Mt Gravatt', postcode: '4122' }, { suburb: 'Kedron', postcode: '4031' });
    expect(deliverButton().textContent).toContain('Mt Gravatt 4122');
    expect(deliverButton().textContent).not.toContain('Near');
    await act(() => {
      fireEvent.click(deliverButton());
      return Promise.resolve();
    });
    expect(screen.queryByText(/We guessed your area/)).toBeNull();
  });

  it('confirming the guess stores it like any other choice', async () => {
    renderWith(null, { suburb: 'Kedron', postcode: '4031' });
    await act(() => {
      fireEvent.click(deliverButton());
      return Promise.resolve();
    });
    await act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm location' }));
      return Promise.resolve();
    });
    expect(document.cookie).toContain('sf-deliver-to=Kedron|4031');
    expect(deliverButton().textContent).not.toContain('Near');
  });
});
