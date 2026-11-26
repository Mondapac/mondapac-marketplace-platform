// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import {
  MAX_OUTLINE_POINTS,
  fetchAreaOutline,
  forgetAreaOutline,
  joinedShape,
  outlineFromApi,
  outlineFromWire,
  outlineToWire,
} from '../src/delivery/area-outline.ts';
import { DeliverModal } from '../src/delivery/deliver-modal.tsx';
import { insideArea } from '../src/delivery/geo.ts';
import { Header } from '../src/shell/header.tsx';
import { StoreProvider } from '../src/shell/store-context.tsx';
import { SAMPLE_DELIVERY_LOCATOR as SOURCE } from '../src/storefront/sample-delivery.ts';
import type { ApiRead } from '../src/storefront/api.ts';

// The real outline of the areas open for delivery (ServiceArea, FE-098): the API's answer is
// checked before it is drawn, the buyer site's route hands it to the modal only when the modal
// opens, and the map draws it with its credit.

const api = vi.hoisted(() => ({ read: vi.fn<() => Promise<ApiRead<unknown>>>() }));
vi.mock('server-only', () => ({}));
vi.mock('../src/storefront/api.ts', () => ({ apiGetWith: api.read }));
vi.mock('../src/checkout/actions.ts', () => ({ deliveryAreaFor: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
}));

const ring = [
  [152.9, -27.3],
  [153.2, -27.3],
  [153.2, -27.6],
  [152.9, -27.6],
  [152.9, -27.3],
];
const hole = [
  [153.0, -27.4],
  [153.1, -27.4],
  [153.1, -27.5],
  [153.0, -27.5],
  [153.0, -27.4],
];
const ANSWER = {
  areas: [
    {
      code: 'greater-brisbane',
      names: { en: 'Greater Brisbane' },
      boundary: { type: 'MultiPolygon', coordinates: [[ring, hole]] },
    },
  ],
  bounds: { north: -27.3, south: -27.6, west: 152.9, east: 153.2 },
  source: { name: 'Postal areas', licence: 'CC BY 4.0', attribution: 'Based on test data' },
};

describe('the outline of the areas open for delivery', () => {
  it('reads the API answer as points, with holes and a credit line', () => {
    const outline = outlineFromApi(ANSWER)!;
    expect(outline.credit).toBe('Based on test data, CC BY 4.0');
    expect(outline.areas[0]!.shape[0]![0]![0]).toEqual({ lat: -27.3, lng: 152.9 });
    const shape = joinedShape(outline);
    expect(insideArea({ lat: -27.35, lng: 152.95 }, shape)).toBe(true);
    // In the hole, and outside the outer ring: both outside.
    expect(insideArea({ lat: -27.45, lng: 153.05 }, shape)).toBe(false);
    expect(insideArea({ lat: -27.7, lng: 153.0 }, shape)).toBe(false);
    expect(outlineFromWire(outlineToWire(outline))).toEqual(outline);
  });

  it('draws nothing from a malformed or oversized answer', () => {
    const area = ANSWER.areas[0]!;
    const withArea = (patch: Record<string, unknown>) => ({
      ...ANSWER,
      areas: [{ ...area, ...patch }],
    });
    for (const bad of [
      null,
      {},
      { ...ANSWER, areas: 'x' },
      { ...ANSWER, bounds: { north: 1 } },
      withArea({ code: 'Not A Code' }),
      withArea({ names: { fa: 'بی‌نام' } }),
      withArea({ boundary: { type: 'Polygon', coordinates: [ring] } }),
      withArea({ boundary: { type: 'MultiPolygon', coordinates: [[[[200, 0], ...ring]]] } }),
      withArea({ boundary: { type: 'MultiPolygon', coordinates: [[ring.slice(0, 3)]] } }),
    ]) {
      expect(outlineFromApi(bad)).toBeUndefined();
    }
    const many = Array.from({ length: MAX_OUTLINE_POINTS + 1 }, () => [153, -27.4]);
    expect(
      outlineFromApi(withArea({ boundary: { type: 'MultiPolygon', coordinates: [[many]] } })),
    ).toBeUndefined();
    // No area open: an empty outline, not a failure.
    expect(outlineFromApi({ areas: [], bounds: null, source: null })).toEqual({
      areas: [],
      bounds: null,
      credit: null,
    });
  });
});

describe('the buyer site route', () => {
  const config = { apiBaseUrl: 'http://api.test' } as never;
  const incoming = new Headers({ host: 'storefront.localhost:3003' });
  beforeEach(() => {
    api.read.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('is 404 while the API is off, 502 when it fails or answers badly', async () => {
    const { answerArea } = await import('../src/delivery/area-server.ts');
    expect((await answerArea(null, incoming)).status).toBe(404);
    api.read.mockResolvedValue({ kind: 'failed', status: 500 });
    expect((await answerArea(config, incoming)).status).toBe(502);
    api.read.mockResolvedValue({ kind: 'ok', body: { areas: 'x' } });
    const bad = await answerArea(config, incoming);
    expect(bad.status).toBe(502);
    expect(bad.headers.get('cache-control')).toBe('no-store');
  });

  it('hands the checked outline on, reusable for a few minutes', async () => {
    const { answerArea } = await import('../src/delivery/area-server.ts');
    api.read.mockResolvedValue({ kind: 'ok', body: ANSWER });
    const answer = await answerArea(config, incoming);
    expect(api.read).toHaveBeenCalledWith(
      config,
      incoming,
      'shipping/delivery-area-map',
      expect.any(Function),
    );
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toBe('public, max-age=300');
    expect(outlineFromWire(await answer.json())).toEqual(outlineFromApi(ANSWER));
  });
});

describe('the browser read', () => {
  beforeEach(() => forgetAreaOutline());

  it('reads once per page, and tries again after a failure', async () => {
    const wire = outlineToWire(outlineFromApi(ANSWER)!);
    const read = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('no', { status: 502 }))
      .mockImplementation(() => Promise.resolve(Response.json(wire)));
    expect(await fetchAreaOutline(read)).toBeNull();
    expect((await fetchAreaOutline(read))?.areas[0]?.code).toBe('greater-brisbane');
    await fetchAreaOutline(read);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith('/api/deliver-to/area', expect.anything());
  });
});

describe('the Deliver to modal with the API on', () => {
  const browserFetch = vi.fn<typeof fetch>();
  beforeEach(() => {
    forgetAreaOutline();
    browserFetch.mockReset();
    vi.stubGlobal('fetch', browserFetch);
    window.matchMedia = (() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function openModal() {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <StoreProvider initialDeliverTo={null}>
          <Header delivery={{ label: 'Brisbane 4000' }} />
          <DeliverModal
            source={{
              ...SOURCE,
              area: { ...SOURCE.area, name: 'Sample name', boundary: [] },
              outlineFromApi: true,
            }}
          />
        </StoreProvider>
      </NextIntlClientProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Delivery area/ }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('reads the outline only when it opens, and draws it with its credit and name', async () => {
    browserFetch.mockImplementation(() =>
      Promise.resolve(Response.json(outlineToWire(outlineFromApi(ANSWER)!))),
    );
    expect(browserFetch).not.toHaveBeenCalled();
    await openModal();
    expect(browserFetch).toHaveBeenCalledWith('/api/deliver-to/area', expect.anything());
    const area = document.querySelector('.marea');
    // One path, two rings: the hole stays empty.
    expect(area?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(area?.getAttribute('fill-rule')).toBe('evenodd');
    expect(screen.getByText('Outline: Based on test data, CC BY 4.0')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Greater Brisbane/ })).toBeTruthy();
  });

  it('draws no outline, never the sample one, when the read fails', async () => {
    browserFetch.mockImplementation(() => Promise.resolve(new Response('no', { status: 502 })));
    await openModal();
    expect(document.querySelector('.marea')).toBeNull();
    expect(screen.queryByText(/^Outline:/)).toBeNull();
  });
});
