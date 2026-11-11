'use client';

// The Deliver to modal's real map (ADR-0048): Mapbox GL JS behind the same props as the stub map.
// The library (its CSP build, with the worker served from this site) is one chunk loaded only when
// the modal opens. The pin is our own button so it keeps its label and arrow-key moves (Mapbox's
// draggable marker has neither); the area, the accuracy ring and the colours come from the props
// and the site's tokens, not from code. If the map cannot start (no WebGL, the chunk fails), the
// drawn stub map takes its place.

import 'mapbox-gl/dist/mapbox-gl.css';
import type { Feature, Point, Polygon } from 'geojson';
import type mapboxgl from 'mapbox-gl';
import type { GeoJSONSource, Map as GlMap, Marker as GlMarker } from 'mapbox-gl';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/icon.tsx';
import type { GeoPoint } from '../storefront/types.ts';
import { StubMap, type DeliveryMapProps } from './stub-map.tsx';

type Gl = typeof mapboxgl & { workerUrl: string };

export interface MapboxMapProps extends DeliveryMapProps {
  /** Public Mapbox token (MAPBOX_MAP_TOKEN). */
  readonly token: string;
  /** Mapbox style URL (MAPBOX_MAP_STYLE). */
  readonly style: string;
}

/** Served from public/vendor/, copied there by scripts/copy-map-worker.mjs when server.mjs starts. */
export const WORKER_URL = '/vendor/mapbox-gl-csp-worker.js';
const START_ZOOM = 14;
const MIN_ZOOM = 8;
const MAX_ZOOM = 18;
/** Screen pixels an arrow key moves the pin. */
const KEY_STEP = 24;
/** The accuracy ring of a device location, in screen pixels (as on the stub map). */
const RING_PX = 26;
/** When the map follows the pin, the tip sits this far below the centre, leaving room for its head. */
const FOLLOW_OFFSET: [number, number] = [0, 28];
const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

let library: Promise<Gl> | undefined;

/** The CSP build of Mapbox GL JS, loaded once. */
export function loadMapbox(): Promise<Gl> {
  library ??= import('mapbox-gl/dist/mapbox-gl-csp.js').then(({ default: gl }) => {
    gl.workerUrl = WORKER_URL;
    return gl;
  });
  return library;
}

const lngLat = (point: GeoPoint): [number, number] => [point.lng, point.lat];

/** A site colour token for the map's paint, which cannot read CSS variables itself. */
function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function areaShape(boundary: readonly GeoPoint[]): Feature<Polygon> {
  const ring = boundary.map(lngLat);
  if (ring.length > 0) ring.push(ring[0]!);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

function pointShape(point: GeoPoint): Feature<Point> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: lngLat(point) },
  };
}

/** Runs `then` once the style is ready (now, or on its load). */
function whenStyled(map: GlMap, then: () => void) {
  if (map.isStyleLoaded()) then();
  else map.once('load', then);
}

export function MapboxMap(props: MapboxMapProps) {
  const { token: accessToken, style, areaName, boundary, point, outside, accuracy, onMove } = props;
  const t = useTranslations('deliver');
  const canvas = useRef<HTMLDivElement>(null);
  const map = useRef<GlMap | null>(null);
  const marker = useRef<GlMarker | null>(null);
  const pin = useRef<HTMLButtonElement | null>(null);
  // The latest props for the map's own event handlers, which are bound once.
  const latest = useRef({ point, onMove, boundary, accuracy });
  useEffect(() => {
    latest.current = { point, onMove, boundary, accuracy };
  });
  const latestLabel = useRef(t('pin'));
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(START_ZOOM);
  const pinLabel = t('pin');

  useEffect(() => {
    let gone = false;
    let created: GlMap | null = null;
    loadMapbox().then(
      (gl) => {
        if (gone || !canvas.current) return;
        const start = latest.current.point;
        try {
          created = new gl.Map({
            container: canvas.current,
            accessToken,
            style,
            center: lngLat(start),
            zoom: START_ZOOM,
            minZoom: MIN_ZOOM,
            maxZoom: MAX_ZOOM,
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            // A double tap would also move the pin twice; the zoom buttons and pinch still zoom.
            doubleClickZoom: false,
            // The pin and the zoom buttons take the keys; the canvas is not a second tab stop.
            keyboard: false,
          });
        } catch {
          setFailed(true);
          return;
        }
        const live = created;
        live.touchZoomRotate.disableRotation();
        // The pin: a real button, so it has a name and takes the arrow keys.
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'lmpin gl';
        button.setAttribute('aria-label', latestLabel.current);
        button.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
        button.addEventListener('keydown', (event) => {
          const step = ARROWS[event.key];
          if (!step) return;
          event.preventDefault();
          event.stopPropagation();
          const at = live.project(lngLat(latest.current.point));
          const next = live.unproject([at.x + step[0] * KEY_STEP, at.y + step[1] * KEY_STEP]);
          latest.current.onMove({ lat: next.lat, lng: next.lng });
        });
        pin.current = button;
        const placed = new gl.Marker({ element: button, draggable: true, anchor: 'bottom' })
          .setLngLat(lngLat(start))
          .addTo(live);
        // Live while dragged, so the pin turns red as it leaves the area (as on the stub map).
        const dragged = () => {
          const at = placed.getLngLat();
          latest.current.onMove({ lat: at.lat, lng: at.lng });
        };
        placed.on('drag', dragged);
        placed.on('dragend', dragged);
        marker.current = placed;
        live.on('click', (event) => {
          latest.current.onMove({ lat: event.lngLat.lat, lng: event.lngLat.lng });
        });
        live.on('zoomend', () => setZoom(live.getZoom()));
        // A bad token or style fails before the map loads: the drawn map takes its place. Later
        // errors (one tile) leave the map as it is.
        let started = false;
        live.on('error', () => {
          if (started || gone) return;
          // Free the WebGL context before the drawn map takes its place.
          live.remove();
          created = null;
          map.current = null;
          setFailed(true);
        });
        live.on('load', () => {
          started = true;
          const area = token('--sf-teal', '#0e5a57');
          live.addSource('lm-area', { type: 'geojson', data: areaShape(latest.current.boundary) });
          live.addLayer({
            id: 'lm-area-fill',
            type: 'fill',
            source: 'lm-area',
            paint: { 'fill-color': area, 'fill-opacity': 0.12 },
          });
          live.addLayer({
            id: 'lm-area-line',
            type: 'line',
            source: 'lm-area',
            // Dashed, as on the stub map and the legend.
            paint: { 'line-color': area, 'line-width': 2, 'line-dasharray': [3, 2.5] },
          });
          live.addSource('lm-ring', { type: 'geojson', data: pointShape(latest.current.point) });
          live.addLayer({
            id: 'lm-ring',
            type: 'circle',
            source: 'lm-ring',
            layout: { visibility: latest.current.accuracy ? 'visible' : 'none' },
            paint: {
              'circle-radius': RING_PX,
              'circle-color': token('--sf-lagoon', '#237a72'),
              'circle-opacity': 0.15,
              'circle-stroke-color': token('--sf-lagoon', '#237a72'),
              'circle-stroke-width': 1,
            },
          });
        });
        map.current = live;
      },
      () => {
        if (!gone) setFailed(true);
      },
    );
    return () => {
      gone = true;
      created?.remove();
      map.current = null;
      marker.current = null;
      pin.current = null;
    };
  }, [accessToken, style]);

  // A new language relabels the pin without rebuilding the map.
  useEffect(() => {
    latestLabel.current = pinLabel;
    pin.current?.setAttribute('aria-label', pinLabel);
  }, [pinLabel]);

  // A new pick moves the pin and, when it leaves the view, the map.
  useEffect(() => {
    const live = map.current;
    marker.current?.setLngLat(lngLat(point));
    if (!live) return;
    // Not `essential`, so Mapbox jumps without animation when the buyer asks for reduced motion.
    if (!live.getBounds()?.contains(lngLat(point)))
      live.easeTo({ center: lngLat(point), offset: FOLLOW_OFFSET });
    whenStyled(live, () => {
      live.getSource<GeoJSONSource>('lm-ring')?.setData(pointShape(point));
    });
  }, [point]);

  useEffect(() => {
    pin.current?.classList.toggle('out', outside);
  }, [outside]);

  useEffect(() => {
    const live = map.current;
    if (!live) return;
    whenStyled(live, () => {
      if (live.getLayer('lm-ring'))
        live.setLayoutProperty('lm-ring', 'visibility', accuracy ? 'visible' : 'none');
    });
  }, [accuracy]);

  useEffect(() => {
    const live = map.current;
    if (!live) return;
    whenStyled(live, () => {
      live.getSource<GeoJSONSource>('lm-area')?.setData(areaShape(boundary));
    });
  }, [boundary]);

  if (failed) return <StubMap {...props} />;

  return (
    <div className="lmmap gl" role="group" aria-label={t('map', { area: areaName })}>
      {props.children}
      <div className="lmgl" ref={canvas} />
      <div className="lmhint">{t('hint')}</div>
      <div className="lmzoom">
        <button
          type="button"
          aria-label={t('zoom-in')}
          aria-disabled={zoom >= MAX_ZOOM}
          onClick={() => map.current?.zoomIn()}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          aria-label={t('zoom-out')}
          aria-disabled={zoom <= MIN_ZOOM}
          onClick={() => map.current?.zoomOut()}
        >
          <Icon name="minus" />
        </button>
      </div>
      <div className="lmlegend">
        <i aria-hidden="true" />
        {t('legend')}
      </div>
    </div>
  );
}
