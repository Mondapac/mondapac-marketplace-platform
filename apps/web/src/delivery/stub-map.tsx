'use client';

import { useTranslations } from 'next-intl';
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../icons/icon.tsx';
import type { GeoPoint, MapBounds, Place } from '../storefront/types.ts';
import { PLANE, clampToPlane, fromPlane, toPlane, type PlanePoint } from './geo.ts';

/** What the modal gives a map. A real map provider takes the same props. */
export interface DeliveryMapProps {
  readonly areaName: string;
  readonly boundary: readonly GeoPoint[];
  readonly bounds: MapBounds;
  /** Suburb names drawn on the map. */
  readonly labels: readonly Place[];
  readonly point: GeoPoint;
  /** The pin is outside the delivery area (it turns red). */
  readonly outside: boolean;
  /** Shows the accuracy ring of a device location. */
  readonly accuracy: boolean;
  readonly onMove: (point: GeoPoint) => void;
  /** The close button over the map on narrow screens. */
  readonly children?: ReactNode;
}

const ZOOM_MAX = 4;
const ZOOM_STEP = 1.5;
/** Plane units an arrow key moves the pin at zoom 1. */
const KEY_STEP = 6;
/** How close (screen px) the pin's point may come to an edge before the map pans; the top
 * leaves room for the pin's 44px head. */
const EDGE = 36;
const EDGE_TOP = 56;
const RING = 26;
/** Suburb names keep one screen size at every zoom. */
const LABEL_PX = 12;

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/**
 * The stubbed map of the Deliver to modal: a drawn plane, not real map data. The pin is a button
 * that can be dragged, set by tapping the map, or moved with the arrow keys; the map pans to keep
 * it in view.
 */
export function StubMap({
  areaName,
  boundary,
  bounds,
  labels,
  point,
  outside,
  accuracy,
  onMove,
  children,
}: DeliveryMapProps) {
  const t = useTranslations('deliver');
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const view = useRef<PlanePoint>({ x: 0, y: 0 });
  const recentre = useRef(true);
  const dragging = useRef(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pin = clampToPlane(toPlane(point, bounds));
  const scale = size.w && size.h ? (zoom * Math.max(size.w, size.h)) / PLANE : 1;
  const vw = size.w ? size.w / scale : PLANE;
  const vh = size.h ? size.h / scale : PLANE;
  // Pan so the pin stays in view: centre it when it comes close to an edge (or after a zoom).
  const edge = Math.min(EDGE / scale, vw / 4, vh / 4);
  const top = Math.min(EDGE_TOP / scale, vh / 3);
  let { x: vx, y: vy } = view.current;
  if (recentre.current || pin.x < vx + edge || pin.x > vx + vw - edge) vx = pin.x - vw / 2;
  if (recentre.current || pin.y < vy + top || pin.y > vy + vh - edge) vy = pin.y - vh / 2 + top / 2;
  vx = Math.max(0, Math.min(PLANE - vw, vx));
  vy = Math.max(0, Math.min(PLANE - vh, vy));
  view.current = { x: vx, y: vy };
  if (size.w) recentre.current = false;

  const fromEvent = (event: PointerEvent): GeoPoint => {
    const rect = box.current!.getBoundingClientRect();
    return fromPlane(
      clampToPlane({
        x: vx + (event.clientX - rect.left) / scale,
        y: vy + (event.clientY - rect.top) / scale,
      }),
      bounds,
    );
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('.lmzoom, .lmx')) return;
    event.preventDefault();
    dragging.current = true;
    box.current?.setPointerCapture?.(event.pointerId);
    onMove(fromEvent(event));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current) onMove(fromEvent(event));
  };
  const endDrag = () => {
    dragging.current = false;
  };
  const onPinKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = ARROWS[event.key];
    if (!step) return;
    event.preventDefault();
    const by = KEY_STEP / zoom;
    onMove(fromPlane(clampToPlane({ x: pin.x + step[0] * by, y: pin.y + step[1] * by }), bounds));
  };
  const zoomTo = (next: number) => {
    recentre.current = true;
    setZoom(Math.min(ZOOM_MAX, Math.max(1, next)));
  };

  const area = boundary.map((p) => toPlane(p, bounds));
  return (
    <div
      className="lmmap"
      ref={box}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {children}
      <svg
        className="m"
        viewBox={`${vx} ${vy} ${vw} ${vh}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('map', { area: areaName })}
      >
        <rect className="mland" width={PLANE} height={PLANE} />
        <path
          className="mwater"
          d="M0 220C60 190 90 250 150 215S230 150 270 190 360 230 400 200V260C350 280 300 240 260 250S170 300 120 260 40 290 0 280Z"
        />
        <path
          className="mroad"
          d="M0 100L400 140M0 330L400 310M120 0L150 400M300 0L270 400M0 40L400 60"
        />
        <polygon className="marea" points={area.map((p) => `${p.x},${p.y}`).join(' ')} />
        {labels.map((label) => {
          const at = toPlane(label.point, bounds);
          return (
            <text
              className="mlabel"
              key={label.id}
              x={at.x}
              y={at.y + LABEL_PX / 3 / scale}
              fontSize={LABEL_PX / scale}
              textAnchor="middle"
            >
              {label.suburb}
            </text>
          );
        })}
        {accuracy ? <circle className="mring" cx={pin.x} cy={pin.y} r={RING} /> : null}
      </svg>
      <button
        className={outside ? 'lmpin out' : 'lmpin'}
        type="button"
        aria-label={t('pin')}
        style={{ left: `${(pin.x - vx) * scale}px`, top: `${(pin.y - vy) * scale}px` }}
        onKeyDown={onPinKey}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11z" />
          <circle cx="12" cy="10" r="2.5" />
        </svg>
      </button>
      <div className="lmhint">{t('hint')}</div>
      <div className="lmzoom">
        <button
          type="button"
          aria-label={t('zoom-in')}
          aria-disabled={zoom >= ZOOM_MAX}
          onClick={() => zoomTo(zoom * ZOOM_STEP)}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          aria-label={t('zoom-out')}
          aria-disabled={zoom <= 1}
          onClick={() => zoomTo(zoom / ZOOM_STEP)}
        >
          <Icon name="minus" />
        </button>
      </div>
      <div className="lmlegend">
        <i aria-hidden="true" />
        {t('legend')}
      </div>
      <div className="lmatt">{t('attribution')}</div>
    </div>
  );
}
