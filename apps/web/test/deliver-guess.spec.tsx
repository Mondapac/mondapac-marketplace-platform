// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { DeliverModal } from '../src/delivery/deliver-modal.tsx';
import { geoGuessOf, parseGeoGuessConfig } from '../src/delivery/geo-guess.ts';
import { Footer } from '../src/shell/footer.tsx';
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
  CLIENT_ADDRESS_SOURCE: 'edge',
  EDGE_GEO_CITY_HEADER: 'CF-IPCity',
  EDGE_GEO_POSTCODE_HEADER: 'cf-postal-code',
  EDGE_GEO_COUNTRY_HEADER: 'cf-ipcountry',
};

describe('first-visit area guess configuration', () => {
  it('is off when neither header is named', () => {
    expect(parseGeoGuessConfig({})).toBeNull();
  });

  it('refuses some headers without the others and malformed names', () => {
    expect(() => parseGeoGuessConfig({ ...CLOUDFLARE, EDGE_GEO_COUNTRY_HEADER: '' })).toThrow(
      /together/,
    );
    expect(() => parseGeoGuessConfig({ ...CLOUDFLARE, EDGE_GEO_CITY_HEADER: 'cf ipcity' })).toThrow(
      /not a header name/,
    );
  });

  it('refuses a guess without an edge in front, where only the visitor sets the headers', () => {
    expect(() => parseGeoGuessConfig({ ...CLOUDFLARE, CLIENT_ADDRESS_SOURCE: 'socket' })).toThrow(
      /CLIENT_ADDRESS_SOURCE=edge/,
    );
    expect(() => parseGeoGuessConfig({ ...CLOUDFLARE, CLIENT_ADDRESS_SOURCE: undefined })).toThrow(
      /CLIENT_ADDRESS_SOURCE=edge/,
    );
  });

  it('reads the names in lower case', () => {
    expect(parseGeoGuessConfig(CLOUDFLARE)).toEqual({
      cityHeader: 'cf-ipcity',
      postcodeHeader: 'cf-postal-code',
      countryHeader: 'cf-ipcountry',
    });
  });
});

describe('first-visit area guess', () => {
  const config = parseGeoGuessConfig(CLOUDFLARE);

  const edge = (city: string, postcode: string, country = 'AU') =>
    new Headers({ 'cf-ipcity': city, 'cf-postal-code': postcode, 'cf-ipcountry': country });

  it('names the area the edge headers give, in the Market of each host', () => {
    expect(geoGuessOf(config, edge('Brisbane', '4000'), 'au')).toEqual({
      suburb: 'Brisbane',
      postcode: '4000',
    });
    // The synthetic second Market: another country, another guess.
    expect(geoGuessOf(config, edge('Auckland', '1010', 'NZ'), 'nz')).toEqual({
      suburb: 'Auckland',
      postcode: '1010',
    });
  });

  it("guesses nothing for a visitor outside the host Market's country", () => {
    expect(geoGuessOf(config, edge('Auckland', '1010', 'NZ'), 'au')).toBeNull();
    expect(
      geoGuessOf(config, new Headers({ 'cf-ipcity': 'Brisbane', 'cf-postal-code': '4000' }), 'au'),
    ).toBeNull();
    // No country for this host (lookup off): no guess.
    expect(geoGuessOf(config, edge('Brisbane', '4000'), null)).toBeNull();
  });

  it('decodes a percent-encoded city', () => {
    expect(geoGuessOf(config, edge('S%C3%A3o%20Paulo', '01000', 'BR'), 'br')).toEqual({
      suburb: 'São Paulo',
      postcode: '01000',
    });
  });

  it('guesses nothing when off, missing or implausible', () => {
    expect(geoGuessOf(null, edge('Brisbane', '4000'), 'au')).toBeNull();
    expect(
      geoGuessOf(config, new Headers({ 'cf-ipcity': 'Brisbane', 'cf-ipcountry': 'AU' }), 'au'),
    ).toBeNull();
    for (const [city, postcode] of [
      ['<script>', '4000'],
      ['Brisbane', '4000|x'],
      ['%E0%A4%A', '4000'],
      ['x'.repeat(61), '4000'],
    ])
      expect(geoGuessOf(config, edge(city!, postcode!), 'au'), city).toBeNull();
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
          <Footer area="Brisbane 4000" />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
  }
  const deliverButton = () => screen.getByRole('button', { name: /^Delivery area/ });

  it('shows "Near" the guessed area, stores nothing, and says how it was found', async () => {
    renderWith(null, { suburb: 'Kedron', postcode: '4031' });
    // The suburb only in the header (320px); the footer and the modal say it is an estimate.
    expect(deliverButton().textContent).toContain('Near Kedron');
    expect(deliverButton().textContent).not.toContain('4031');
    expect(screen.getByText('Delivering near Kedron 4031')).toBeTruthy();
    expect(document.cookie).not.toContain('sf-deliver-to');
    await act(() => {
      fireEvent.click(deliverButton());
      return Promise.resolve();
    });
    expect(screen.getByText(/We estimated your area from your internet connection/)).toBeTruthy();
    // The modal starts at the guessed suburb, for the buyer to confirm, and says it is a guess.
    const dialog = screen.getByRole('dialog', { name: 'Choose where to deliver' });
    expect(dialog.querySelector('.lmsel')?.textContent).toContain('Kedron');
    expect(screen.getByText(/Estimated from your connection/)).toBeTruthy();
  });

  it('prefers a confirmed location and drops the estimate line', async () => {
    renderWith({ suburb: 'Mt Gravatt', postcode: '4122' }, { suburb: 'Kedron', postcode: '4031' });
    expect(deliverButton().textContent).toContain('Mt Gravatt 4122');
    expect(deliverButton().textContent).not.toContain('Near');
    await act(() => {
      fireEvent.click(deliverButton());
      return Promise.resolve();
    });
    expect(screen.queryByText(/We estimated your area/)).toBeNull();
    expect(screen.queryByText(/Estimated from your connection/)).toBeNull();
    expect(screen.getByText('Delivering to Mt Gravatt 4122')).toBeTruthy();
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
    // Without a reload: the header and footer drop the estimate at once.
    expect(deliverButton().textContent).not.toContain('Near');
    expect(screen.getByText('Delivering to Kedron 4031')).toBeTruthy();
    await act(() => {
      fireEvent.click(deliverButton());
      return Promise.resolve();
    });
    expect(screen.queryByText(/Estimated from your connection/)).toBeNull();
  });
});
