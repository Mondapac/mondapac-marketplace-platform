// @vitest-environment jsdom
// The Deliver to modal's real map (ADR-0048): configuration, the policy it needs, and the map
// component on a fake Mapbox GL JS (jsdom has no WebGL; the library itself is Mapbox's to test).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { DEFAULT_MAP_STYLE, parseMapConfig } from '../src/delivery/map-config.ts';
import { DeliveryMap } from '../src/delivery/delivery-map.tsx';
import { MapboxMap, WORKER_URL } from '../src/delivery/mapbox-map.tsx';
import { storefrontCsp } from '../src/security/storefront-csp.ts';
import type { GeoPoint } from '../src/storefront/types.ts';

const PUBLIC = 'pk.eyJ1IjoibW9uZGFwYWMiLCJhIjoidGVzdCJ9.not-a-real-token';

describe('map configuration', () => {
  it('is off without a token and takes the default style with one', () => {
    expect(parseMapConfig({})).toBeNull();
    expect(parseMapConfig({ MAPBOX_MAP_TOKEN: PUBLIC })).toEqual({
      token: PUBLIC,
      style: DEFAULT_MAP_STYLE,
    });
    expect(
      parseMapConfig({ MAPBOX_MAP_TOKEN: PUBLIC, MAPBOX_MAP_STYLE: 'mapbox://styles/acme/x1' }),
    ).toEqual({ token: PUBLIC, style: 'mapbox://styles/acme/x1' });
  });

  it('refuses a secret token, a malformed one, a bad style and a style without a token', () => {
    expect(() =>
      parseMapConfig({ MAPBOX_MAP_TOKEN: 'sk.eyJ1Ijoic2VjcmV0In0.abcdefghijklmnop' }),
    ).toThrow(/never sk/);
    expect(() => parseMapConfig({ MAPBOX_MAP_TOKEN: 'pk.short' })).toThrow(/public Mapbox token/);
    expect(() =>
      parseMapConfig({ MAPBOX_MAP_TOKEN: PUBLIC, MAPBOX_MAP_STYLE: 'https://evil.example/s.json' }),
    ).toThrow(/mapbox:\/\/styles/);
    expect(() => parseMapConfig({ MAPBOX_MAP_STYLE: DEFAULT_MAP_STYLE })).toThrow(/needs/);
    expect(() =>
      parseMapConfig({ MAPBOX_MAP_TOKEN: PUBLIC, MAPBOX_SEARCH_TOKEN: ` ${PUBLIC} ` }),
    ).toThrow(/own token/);
  });
});

describe('map Content-Security-Policy', () => {
  const directive = (policy: string, name: string) =>
    policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

  it('adds the Mapbox hosts to connect-src only with the map, and keeps the worker this site', () => {
    const off = storefrontCsp('n', false, null, false, false);
    expect(off).not.toMatch(/mapbox/);
    const on = storefrontCsp('n', false, null, false, true);
    expect(directive(on, 'connect-src')).toContain(
      'https://api.mapbox.com https://events.mapbox.com',
    );
    expect(directive(on, 'worker-src')).toBe("worker-src 'self'");
    for (const name of ['script-src', 'img-src', 'style-src', 'frame-src'])
      expect(directive(on, name)).toBe(directive(off, name));
  });
});

// A fake of the parts of Mapbox GL JS the map uses.
const gl = vi.hoisted(() => {
  type Handler = (event?: unknown) => void;
  class FakeMarker {
    static last: FakeMarker | undefined;
    at: [number, number] = [0, 0];
    handlers = new Map<string, Handler>();
    constructor(readonly options: { element: HTMLElement; draggable: boolean }) {
      FakeMarker.last = this;
    }
    setLngLat(at: [number, number]) {
      this.at = at;
      return this;
    }
    getLngLat() {
      return { lng: this.at[0], lat: this.at[1] };
    }
    addTo(map: FakeMap) {
      map.container.append(this.options.element);
      return this;
    }
    on(type: string, handler: Handler) {
      this.handlers.set(type, handler);
      return this;
    }
  }
  class FakeMap {
    static last: FakeMap | undefined;
    container: HTMLElement;
    handlers = new Map<string, Handler>();
    sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
    layers = new Map<string, { layout?: Record<string, unknown> }>();
    removed = false;
    eased: unknown[] = [];
    touchZoomRotate = { disableRotation: vi.fn() };
    zoomIn = vi.fn();
    zoomOut = vi.fn();
    zoom = 14;
    getZoom() {
      return this.zoom;
    }
    constructor(readonly options: Record<string, unknown> & { container: HTMLElement }) {
      this.container = options.container;
      FakeMap.last = this;
    }
    on(type: string, handler: Handler) {
      this.handlers.set(type, handler);
      return this;
    }
    once(type: string, handler: Handler) {
      return this.on(type, handler);
    }
    fire(type: string, event?: unknown) {
      this.handlers.get(type)?.(event);
    }
    isStyleLoaded() {
      return this.layers.size > 0;
    }
    addSource(id: string, spec: { data: unknown }) {
      const source = {
        data: spec.data,
        setData: (data: unknown) => {
          source.data = data;
        },
      };
      this.sources.set(id, source);
    }
    getSource(id: string) {
      return this.sources.get(id);
    }
    addLayer(spec: { id: string; layout?: Record<string, unknown> }) {
      this.layers.set(spec.id, { layout: { ...spec.layout } });
    }
    getLayer(id: string) {
      return this.layers.get(id);
    }
    setLayoutProperty(id: string, name: string, value: unknown) {
      this.layers.get(id)!.layout![name] = value;
    }
    // 1 degree = 1000 px: enough to check the arrow keys.
    project([lng, lat]: [number, number]) {
      return { x: lng * 1000, y: -lat * 1000 };
    }
    unproject([x, y]: [number, number]) {
      return { lng: x / 1000, lat: -y / 1000 };
    }
    getBounds() {
      return { contains: ([lng]: [number, number]) => lng < 153.1 };
    }
    easeTo(options: unknown) {
      this.eased.push(options);
    }
    remove() {
      this.removed = true;
    }
  }
  const module = { Map: FakeMap, Marker: FakeMarker, workerUrl: '' };
  return { module, FakeMap, FakeMarker };
});
vi.mock('mapbox-gl/dist/mapbox-gl.css', () => ({}));
vi.mock('mapbox-gl/dist/mapbox-gl-csp.js', () => ({ default: gl.module }));

describe('the Mapbox map', () => {
  const start: GeoPoint = { lat: -27.47, lng: 153.02 };
  const boundary: GeoPoint[] = [
    { lat: -27.3, lng: 152.9 },
    { lat: -27.3, lng: 153.2 },
    { lat: -27.6, lng: 153.2 },
  ];
  const onMove = vi.fn<(point: GeoPoint) => void>();

  function draw(point = start, extra: { outside?: boolean; accuracy?: boolean } = {}) {
    return (
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MapboxMap
          token={PUBLIC}
          style={DEFAULT_MAP_STYLE}
          areaName="Greater Brisbane"
          boundary={boundary}
          bounds={{ north: -27, south: -28, west: 152.5, east: 153.5 }}
          labels={[]}
          point={point}
          outside={extra.outside ?? false}
          accuracy={extra.accuracy ?? false}
          onMove={onMove}
        />
      </NextIntlClientProvider>
    );
  }

  async function open(point = start, extra = {}) {
    const view = render(draw(point, extra));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    return view;
  }

  beforeEach(() => onMove.mockReset());
  afterEach(() => cleanup());

  it('starts at the pin with the public token and style, and serves its worker from this site', async () => {
    await open();
    const map = gl.FakeMap.last!;
    expect(map.options['accessToken']).toBe(PUBLIC);
    expect(map.options['style']).toBe(DEFAULT_MAP_STYLE);
    expect(map.options['center']).toEqual([153.02, -27.47]);
    expect(map.options['dragRotate']).toBe(false);
    expect(gl.module.workerUrl).toBe(WORKER_URL);
    expect(screen.getByRole('group', { name: /Map of Greater Brisbane/ })).toBeTruthy();
  });

  it('draws the delivery area from the props once the style loads', async () => {
    await open();
    const map = gl.FakeMap.last!;
    act(() => map.fire('load'));
    const area = map.getSource('lm-area')!.data as { geometry: { coordinates: number[][][] } };
    // Closed ring, longitude first.
    expect(area.geometry.coordinates[0]).toEqual([
      [152.9, -27.3],
      [153.2, -27.3],
      [153.2, -27.6],
      [152.9, -27.3],
    ]);
    expect(map.getLayer('lm-ring')!.layout!['visibility']).toBe('none');
  });

  it('moves by a tap, a drag and the arrow keys, through onMove', async () => {
    await open();
    const map = gl.FakeMap.last!;
    map.fire('click', { lngLat: { lat: -27.5, lng: 153.05 } });
    expect(onMove).toHaveBeenLastCalledWith({ lat: -27.5, lng: 153.05 });
    const marker = gl.FakeMarker.last!;
    expect(marker.options.draggable).toBe(true);
    marker.setLngLat([153.01, -27.4]);
    marker.handlers.get('drag')!();
    expect(onMove).toHaveBeenLastCalledWith({ lat: -27.4, lng: 153.01 });
    marker.setLngLat([153.0, -27.45]);
    marker.handlers.get('dragend')!();
    expect(onMove).toHaveBeenLastCalledWith({ lat: -27.45, lng: 153.0 });
    expect(map.options['doubleClickZoom']).toBe(false);
    expect(map.options['keyboard']).toBe(false);
    const pin = screen.getByRole('button', { name: 'Delivery pin. Use arrow keys to move it.' });
    fireEvent.keyDown(pin, { key: 'ArrowRight' });
    const moved = onMove.mock.calls.at(-1)![0];
    expect(moved.lat).toBeCloseTo(-27.47);
    expect(moved.lng).toBeCloseTo(153.044);
  });

  it('follows a new pick, marks it outside, and shows the ring for a device location', async () => {
    const view = await open();
    const map = gl.FakeMap.last!;
    act(() => map.fire('load'));
    view.rerender(draw({ lat: -27.6, lng: 153.3 }, { outside: true, accuracy: true }));
    expect(gl.FakeMarker.last!.at).toEqual([153.3, -27.6]);
    expect(map.eased).toEqual([{ center: [153.3, -27.6], offset: [0, 28] }]);
    expect(
      screen.getByRole('button', { name: 'Delivery pin. Use arrow keys to move it.' }).className,
    ).toContain('out');
    expect(map.getLayer('lm-ring')!.layout!['visibility']).toBe('visible');
  });

  it('zooms with its own buttons and removes the map when the modal closes', async () => {
    const view = await open();
    const map = gl.FakeMap.last!;
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(map.zoomIn).toHaveBeenCalled();
    map.zoom = 18;
    act(() => map.fire('zoomend'));
    expect(screen.getByRole('button', { name: 'Zoom in' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Zoom out' }).getAttribute('aria-disabled')).toBe(
      'false',
    );
    view.unmount();
    expect(map.removed).toBe(true);
  });

  it('gives way to the drawn map when its style or token fails, but not after it loads', async () => {
    await open();
    const failing = gl.FakeMap.last!;
    act(() => failing.fire('error'));
    expect(screen.getByRole('img', { name: /Map of Greater Brisbane/ })).toBeTruthy();
    expect(failing.removed).toBe(true);
    cleanup();
    await open();
    const map = gl.FakeMap.last!;
    act(() => map.fire('load'));
    act(() => map.fire('error'));
    expect(screen.queryByRole('img', { name: /Map of Greater Brisbane/ })).toBeNull();
    expect(screen.getByRole('group', { name: /Map of Greater Brisbane/ })).toBeTruthy();
  });
});

describe('the Mapbox map without WebGL', () => {
  afterEach(() => {
    cleanup();
    gl.module.Map = gl.FakeMap;
  });

  it('falls back to the drawn map', async () => {
    gl.module.Map = class {
      constructor() {
        throw new Error('WebGL is not supported');
      }
    } as unknown as typeof gl.FakeMap;
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MapboxMap
          token={PUBLIC}
          style={DEFAULT_MAP_STYLE}
          areaName="Greater Brisbane"
          boundary={[]}
          bounds={{ north: -27, south: -28, west: 152.5, east: 153.5 }}
          labels={[]}
          point={{ lat: -27.47, lng: 153.02 }}
          outside={false}
          accuracy={false}
          onMove={() => undefined}
        />
      </NextIntlClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The stub map draws an image of the area.
    expect(screen.getByRole('img', { name: /Map of Greater Brisbane/ })).toBeTruthy();
  });
});

describe('choosing the map', () => {
  afterEach(() => cleanup());
  const props = {
    areaName: 'Greater Brisbane',
    boundary: [],
    bounds: { north: -27, south: -28, west: 152.5, east: 153.5 },
    labels: [],
    point: { lat: -27.47, lng: 153.02 },
    outside: false,
    accuracy: false,
    onMove: () => undefined,
  };
  const show = (map?: { token: string; style: string }) =>
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DeliveryMap {...props} map={map} />
      </NextIntlClientProvider>,
    );

  it('keeps the drawn map without a map token', () => {
    show();
    expect(screen.getByRole('img', { name: /Map of Greater Brisbane/ })).toBeTruthy();
  });

  it('loads the Mapbox map with one, keeping the close button and a status while it loads', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <DeliveryMap {...props} map={{ token: PUBLIC, style: DEFAULT_MAP_STYLE }}>
          <button type="button">Close</button>
        </DeliveryMap>
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('status').textContent).toBe('Loading map…');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    expect(await screen.findByRole('group', { name: /Map of Greater Brisbane/ })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Map of Greater Brisbane/ })).toBeNull();
  });
});
