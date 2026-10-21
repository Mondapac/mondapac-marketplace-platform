// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { SellerPage } from '../src/seller/seller-page.tsx';
import { StoreCard } from '../src/sellers/store-card.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import type { ApiRead } from '../src/storefront/api.ts';
import {
  listingOf,
  publicStoreOf,
  shopOf,
  StoreAnswerRefused,
} from '../src/storefront/real-sellers.ts';
import { loadStoreImage } from '../src/storefront/source.ts';
import { GET } from '../app/s/[slug]/images/[imageId]/[size]/route.ts';

// The store's About text, logo and banner on the buyer site: the strict reading of the API's
// answer, the picture read and its route, and the pages with and without them.

const reads = vi.hoisted(() => ({ answers: [] as ApiRead<unknown>[], paths: [] as string[] }));

vi.mock('../src/storefront/api.ts', () => ({
  apiGet: () => Promise.resolve({ kind: 'failed' }),
  apiGetBytes: (path: string) => {
    reads.paths.push(path);
    return Promise.resolve(reads.answers.shift() ?? { kind: 'failed' });
  },
}));

afterEach(cleanup);
beforeEach(() => {
  reads.answers = [];
  reads.paths = [];
});

const ID = '0b6c1e0e-52a1-4d6e-9c27-7d0a4a1f2b11';
const ID2 = '1c7d2f1f-63b2-4e7f-8d38-8e1b5b2a3c22';
const STORE = {
  slug: 'kedron-halal',
  name: 'Kedron Halal Meats',
  serviceAreaCode: 'greater-brisbane',
  sellingSince: 2026,
  minimumOrder: null,
};
const LOGO = { id: ID, width: 512, height: 512 };
const BANNER = { id: ID2, width: 1536, height: 384 };

describe('reading the About text and pictures of a store', () => {
  it('reads them present, null or absent', () => {
    const full = publicStoreOf({ ...STORE, about: 'Hello', logo: LOGO, banner: BANNER });
    expect(full.about).toBe('Hello');
    expect(full.logo).toEqual(LOGO);
    expect(full.banner).toEqual(BANNER);
    const none = publicStoreOf({ ...STORE, about: null, logo: null, banner: null });
    expect(none.about).toBeNull();
    expect(none.logo).toBeNull();
    const absent = publicStoreOf(STORE);
    expect('about' in absent || 'logo' in absent || 'banner' in absent).toBe(false);
  });

  it.each([
    ['a numeric about', { about: 5 }],
    ['an about over the cap', { about: 'x'.repeat(8001) }],
    ['a logo that is not an object', { logo: 'x' }],
    ['a logo id that is not a UUID', { logo: { ...LOGO, id: '../x' } }],
    ['a logo side of zero', { logo: { ...LOGO, width: 0 } }],
    ['a banner side that is fractional', { banner: { ...BANNER, height: 1.5 } }],
    ['a banner side that is huge', { banner: { ...BANNER, width: 10001 } }],
  ])('refuses %s whole', (_name, extra) => {
    expect(() => publicStoreOf({ ...STORE, ...extra })).toThrow(StoreAnswerRefused);
  });

  it('points pictures at the buyer site own route and trims the About text', () => {
    const shop = shopOf(
      publicStoreOf({ ...STORE, about: '  Line one\n\nLine two  ', logo: LOGO, banner: BANNER }),
      'Greater Brisbane',
    );
    expect(shop.about).toBe('Line one\n\nLine two');
    expect(shop.logoImage?.src).toBe(`/s/kedron-halal/images/${ID}/large`);
    expect(shop.banner).toEqual({
      src: `/s/kedron-halal/images/${ID2}/large`,
      width: 1536,
      height: 384,
    });
    const listing = listingOf(publicStoreOf({ ...STORE, logo: LOGO }), 'Greater Brisbane');
    expect(listing.logoImage).toEqual({
      src: `/s/kedron-halal/images/${ID}/small`,
      width: 128,
      height: 128,
    });
  });

  it('leaves out a blank About text and a missing picture', () => {
    const shop = shopOf(publicStoreOf({ ...STORE, about: '   ', logo: null }), 'x');
    expect('about' in shop).toBe(false);
    expect(shop.logoImage).toBeUndefined();
    expect(shop.banner).toBeUndefined();
  });
});

describe('loading a store picture', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
  const ok = (contentType: string, bytes = jpeg): ApiRead<unknown> => ({
    kind: 'ok',
    body: { bytes, contentType },
  });

  it('reads the API route and returns a JPEG', async () => {
    reads.answers = [ok('image/jpeg')];
    const read = await loadStoreImage('kedron-halal', ID, 'small');
    expect(read).toEqual({ kind: 'ok', bytes: jpeg });
    expect(reads.paths).toEqual([`sellers/stores/kedron-halal/images/${ID}/small`]);
  });

  it('refuses a bad slug, id or size without a read', async () => {
    expect(await loadStoreImage('../x', ID, 'small')).toEqual({ kind: 'none' });
    expect(await loadStoreImage('kedron-halal', 'nope', 'small')).toEqual({ kind: 'none' });
    expect(await loadStoreImage('kedron-halal', ID, 'huge')).toEqual({ kind: 'none' });
    expect(reads.paths).toEqual([]);
  });

  it('tells a missing picture from a fault, and refuses other types', async () => {
    reads.answers = [{ kind: 'failed', status: 404, code: 'image.not-found' }];
    expect(await loadStoreImage('kedron-halal', ID, 'large')).toEqual({ kind: 'none' });
    reads.answers = [{ kind: 'failed', status: 404 }];
    expect(await loadStoreImage('kedron-halal', ID, 'large')).toEqual({ kind: 'unavailable' });
    reads.answers = [{ kind: 'failed', status: 503 }];
    expect(await loadStoreImage('kedron-halal', ID, 'large')).toEqual({ kind: 'unavailable' });
    reads.answers = [ok('text/html')];
    expect(await loadStoreImage('kedron-halal', ID, 'large')).toEqual({ kind: 'unavailable' });
    reads.answers = [ok('image/jpeg', new Uint8Array())];
    expect(await loadStoreImage('kedron-halal', ID, 'large')).toEqual({ kind: 'unavailable' });
    reads.answers = [{ kind: 'off' }];
    expect(await loadStoreImage('kedron-halal', ID, 'large')).toEqual({ kind: 'none' });
  });
});

describe('the store picture route', () => {
  const call = (size = 'small', imageId = ID) =>
    GET(new Request('http://x/'), {
      params: Promise.resolve({ slug: 'kedron-halal', imageId, size }),
    });

  it('serves the JPEG with safe headers and a short cache', async () => {
    reads.answers = [
      { kind: 'ok', body: { bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg' } },
    ];
    const response = await call();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('answers 404 for a missing picture and 503 for a fault, never cached', async () => {
    reads.answers = [{ kind: 'failed', status: 404, code: 'image.not-found' }];
    const missing = await call();
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    reads.answers = [{ kind: 'failed', status: 500 }];
    const fault = await call();
    expect(fault.status).toBe(503);
    expect(fault.headers.get('cache-control')).toBe('no-store');
  });
});

describe('seller pages with pictures', () => {
  const wrap = (node: React.ReactNode) =>
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider>{node}</StoreProvider>
      </NextIntlClientProvider>,
    );
  const shopWith = (extra: Record<string, unknown>) =>
    shopOf(publicStoreOf({ ...STORE, ...extra }), 'Greater Brisbane');

  it('shows banner, logo and the About text with its line breaks kept', () => {
    wrap(
      <SellerPage
        shop={shopWith({ about: 'Line one\n\nLine two <b>x</b>', logo: LOGO, banner: BANNER })}
        ratingsShown={false}
      />,
    );
    const images = Array.from(document.querySelectorAll('img'));
    const banner = images.find((i) => i.getAttribute('src')?.includes(ID2));
    const logo = images.find((i) => i.getAttribute('src')?.includes(ID));
    expect(banner?.getAttribute('alt')).toBe('');
    expect(banner?.getAttribute('width')).toBe('1536');
    expect(logo?.getAttribute('alt')).toBe('');
    const about = document.querySelector('.shop-about');
    expect(about?.textContent).toBe('Line one\n\nLine two <b>x</b>');
    expect(about?.querySelector('b')).toBeNull();
  });

  it('shows no picture box or About paragraph when there are none', () => {
    wrap(<SellerPage shop={shopWith({})} ratingsShown={false} />);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('.shop-about')).toBeNull();
    expect(document.querySelector('.has-image')).toBeNull();
  });

  it('shows the logo on a store card, with no alt since the name is beside it', () => {
    wrap(
      <StoreCard
        store={listingOf(publicStoreOf({ ...STORE, logo: LOGO }), 'Greater Brisbane')}
        location="unknown"
        ratingsShown={false}
      />,
    );
    const img = document.querySelector('img');
    expect(img?.getAttribute('src')).toBe(`/s/kedron-halal/images/${ID}/small`);
    expect(img?.getAttribute('alt')).toBe('');
  });

  it('falls back to the default store tile when the logo does not load, on the page and on a card', () => {
    wrap(<SellerPage shop={shopWith({ logo: LOGO, banner: BANNER })} ratingsShown={false} />);
    const logoImg = document.querySelector('.lg-img img')!;
    fireEvent.error(logoImg);
    expect(document.querySelector('.lg-img')).toBeNull();
    expect(document.querySelector('.shop-id .lg svg')).not.toBeNull();
    cleanup();

    wrap(
      <StoreCard
        store={listingOf(publicStoreOf({ ...STORE, logo: LOGO }), 'Greater Brisbane')}
        location="unknown"
        ratingsShown={false}
      />,
    );
    fireEvent.error(document.querySelector('img')!);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('.slc-lg .lg svg')).not.toBeNull();
  });

  it('drops the banner back to the neutral one when it does not load', () => {
    wrap(<SellerPage shop={shopWith({ banner: BANNER })} ratingsShown={false} />);
    expect(document.querySelector('.shop-banner.has-image')).not.toBeNull();
    fireEvent.error(document.querySelector('.shop-banner img')!);
    expect(document.querySelector('.shop-banner.has-image')).toBeNull();
    expect(document.querySelector('.shop-banner img')).toBeNull();
    expect(document.querySelector('.shop-banner')).not.toBeNull();
  });
});
