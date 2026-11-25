'use client';

import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { useWidth } from './use-width.ts';
import { compactNumber, labelIndexes, niceTicksRange } from './chart-scale.ts';

export interface ChartPoint {
  /** The x label as shown ("12 Nov"). */
  readonly label: string;
  readonly value: number;
  /**
   * The list of this point's day (built by code, never from data): the point is a link, in the
   * chart (click, or Enter on the focused chart) and in the table. Named by `linkLabel`.
   */
  readonly href?: string;
  /** The link's accessible name ("View orders placed on 21 Nov"); required with `href`. */
  readonly linkLabel?: string;
}

export interface LineAreaChartProps {
  /** The text alternative and the table caption ("GMV incl. GST, last 30 days"). */
  readonly title: string;
  /** The current period, in time order. */
  readonly points: readonly ChartPoint[];
  /** The previous period, same length and order; drawn dashed. */
  readonly compare?: readonly ChartPoint[];
  readonly seriesLabel: string;
  readonly compareLabel?: string;
  /** Formats a value for the tooltip and the table ("A$1,204"). */
  readonly formatValue: (value: number) => string;
  /** Formats an axis tick; defaults to a compact figure. */
  readonly formatTick?: (value: number) => string;
  /** Fill the area under the current line. */
  readonly area?: boolean;
  readonly height?: number;
  readonly labels: {
    readonly viewAsTable: string;
    readonly viewAsChart: string;
    readonly dateColumn: string;
    /** Read after the active point when it links ("Press Enter to open its orders"). */
    readonly openPoint?: string;
    /** The visible line of the tooltip of a linked point ("View orders ›"). */
    readonly openPointLink?: string;
  };
}

const AXIS_W = 52;

/** The link of a point, or null when it has none (both the address and its name are needed). */
const linkOf = (point: ChartPoint | undefined) =>
  point?.href === undefined || point.linkLabel === undefined
    ? null
    : { href: point.href, label: point.linkLabel };
const PAD = { top: 8, right: 8, bottom: 22 };

/**
 * A line or area chart of one period with an optional dashed line for the previous one. It is
 * drawn at the card's real pixel width (axis text is always 12 px), uses chart tokens only, can
 * be read with arrow keys, and has a "View as table" switch that shows the same figures as text.
 */
export function LineAreaChart({
  title,
  points,
  compare,
  seriesLabel,
  compareLabel,
  formatValue,
  formatTick = compactNumber,
  area = true,
  height = 240,
  labels,
}: LineAreaChartProps) {
  const [boxRef, measured] = useWidth();
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const width = measured > 0 ? measured : 640;
  const n = points.length;
  // A non-finite value is drawn as zero; a compare series is cut to the length of the current one.
  const safe = (v: number) => (Number.isFinite(v) ? v : 0);
  const cur = points.map((p) => ({ ...p, value: safe(p.value) }));
  const cmp = compare?.slice(0, n).map((p) => ({ ...p, value: safe(p.value) }));

  const all = [...cur, ...(cmp ?? [])].map((p) => p.value);
  const ticks = niceTicksRange(Math.min(0, ...all), Math.max(0, ...all));
  const bottom = ticks[0]!;
  const top = ticks[ticks.length - 1]!;
  const plotW = Math.max(width - AXIS_W - PAD.right, 1);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (i: number) => AXIS_W + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - bottom) / (top - bottom)) * plotH;
  const path = (pts: readonly ChartPoint[]) =>
    pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`)
      .join(' ');

  // Touch: the first tap on a day only shows it (tooltip); a second tap on the same day, or the
  // tooltip's link, follows the link. `follow` is decided when the finger goes down.
  const tap = useRef<{ readonly follow: boolean } | null>(null);
  const [touched, setTouched] = useState(false);
  const indexAt = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left - AXIS_W) / plotW;
    return Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1))));
  };
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    setActive(indexAt(e));
  };
  const down = (e: PointerEvent<SVGSVGElement>) => {
    if (n === 0) return;
    const index = indexAt(e);
    const touch = e.pointerType === 'touch';
    tap.current = touch ? { follow: active === index } : null;
    setTouched(touch);
    setActive(index);
  };
  const follow = (e: MouseEvent) => {
    // A first tap only activates its day; mouse and keyboard follow at once.
    if (tap.current !== null && !tap.current.follow) e.preventDefault();
    tap.current = null;
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (n === 0) return;
    tap.current = null;
    setTouched(false);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      setActive((cur) => Math.min(n - 1, Math.max(0, (cur ?? (dir === 1 ? -1 : n)) + dir)));
    } else if (e.key === 'Escape') setActive(null);
    else if (e.key === 'Enter' && active === null) {
      // Nothing chosen yet: Enter reads the last day first (a second Enter follows its link).
      e.preventDefault();
      setActive(n - 1);
    } else if (e.key === 'Enter' && active !== null && linkOf(points[active]) !== null) {
      // The keyboard follows the same real link a click follows.
      e.preventDefault();
      e.currentTarget
        .querySelector(`[data-point-link="${active}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  };

  const shown = active === null ? undefined : cur[active];
  const shownLink = active === null ? null : linkOf(points[active]);
  const step = n <= 1 ? plotW : plotW / (n - 1);
  const shownCompare = active === null ? undefined : cmp?.[active];
  const xLabels = labelIndexes(n, Math.max(2, Math.floor(plotW / 72)));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-secondary">
          <li className="flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-5 rounded-full bg-chart-series" />
            {seriesLabel}
          </li>
          {compare === undefined || compareLabel === undefined ? null : (
            <li className="flex items-center gap-2">
              <svg aria-hidden="true" width="20" height="2" className="stroke-chart-compare">
                <line x1="0" y1="1" x2="20" y2="1" strokeWidth="2" strokeDasharray="4 3" />
              </svg>
              {compareLabel}
            </li>
          )}
        </ul>
        <button
          type="button"
          aria-controls={tableId}
          onClick={() => setTable((v) => !v)}
          className="inline-flex min-h-11 items-center text-sm font-medium text-link underline lg:min-h-0"
        >
          {table ? labels.viewAsChart : labels.viewAsTable}
        </button>
      </div>
      <div id={tableId}>
        {table ? (
          <div className="max-h-72 overflow-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <caption className="sr-only">{title}</caption>
              <thead className="sticky top-0 bg-muted text-fg-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    {labels.dateColumn}
                  </th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    {seriesLabel}
                  </th>
                  {compare === undefined ? null : (
                    <th scope="col" className="px-3 py-2 text-end font-medium">
                      {compareLabel ?? ''}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {cur.map((p, i) => (
                  <tr key={`${p.label}-${i}`} className="border-t border-line-row">
                    <th scope="row" className="px-3 py-2 text-start font-normal text-fg-secondary">
                      {linkOf(p) === null ? (
                        p.label
                      ) : (
                        <a
                          href={linkOf(p)?.href}
                          aria-label={linkOf(p)?.label}
                          className="font-medium text-link underline"
                        >
                          {p.label}
                        </a>
                      )}
                    </th>
                    <td className="px-3 py-2 text-end text-fg">{formatValue(p.value)}</td>
                    {compare === undefined ? null : (
                      <td className="px-3 py-2 text-end text-fg-secondary">
                        {cmp?.[i] === undefined ? '' : formatValue(cmp[i].value)}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div ref={boxRef} className="relative w-full" style={{ height }}>
            <svg
              role="img"
              aria-label={title}
              tabIndex={0}
              width={width}
              height={height}
              viewBox={`0 0 ${width} ${height}`}
              onPointerMove={pick}
              onPointerDown={down}
              // A finger "leaves" when it lifts: the tapped day stays shown until the next tap.
              onPointerLeave={(e) => {
                if (e.pointerType !== 'touch') setActive(null);
              }}
              onKeyDown={key}
              onBlur={() => setActive(null)}
              className="block overflow-visible focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              data-chart="line"
            >
              {ticks.map((t) => (
                <g key={t}>
                  <line
                    x1={AXIS_W}
                    x2={width - PAD.right}
                    y1={y(t)}
                    y2={y(t)}
                    className={t === 0 ? 'stroke-chart-axis' : 'stroke-chart-grid'}
                  />
                  <text
                    x={AXIS_W - 6}
                    y={y(t)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={12}
                    className="fill-fg-muted"
                  >
                    {formatTick(t)}
                  </text>
                </g>
              ))}
              {xLabels.map((i, k) => (
                <text
                  key={i}
                  x={x(i)}
                  y={height - 4}
                  fontSize={12}
                  textAnchor={k === 0 ? 'start' : k === xLabels.length - 1 ? 'end' : 'middle'}
                  className="fill-fg-muted"
                >
                  {points[i]?.label}
                </text>
              ))}
              {area && n > 1 ? (
                <path
                  d={`${path(cur)} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`}
                  className="fill-chart-series-soft"
                  opacity={0.5}
                />
              ) : null}
              {compare === undefined ? null : (
                <path
                  d={path(cmp ?? [])}
                  fill="none"
                  strokeWidth={1.5}
                  strokeDasharray="5 4"
                  className="stroke-chart-compare"
                />
              )}
              <path
                d={path(cur)}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                className="stroke-chart-series"
              />
              {n === 1 && cur[0] !== undefined ? (
                <circle cx={x(0)} cy={y(cur[0].value)} r={3} className="fill-chart-series" />
              ) : null}
              {points.map((p, i) => {
                const link = linkOf(p);
                // A column per day that is a real link for a pointer; the keyboard reaches it
                // through the focused chart (arrows, then Enter) and through the table.
                return link === null ? null : (
                  <a
                    key={`link-${i}`}
                    href={link.href}
                    aria-label={link.label}
                    tabIndex={-1}
                    data-point-link={i}
                    // Out of the tab order: a tap may focus it, but the chart's own ring is the
                    // keyboard's focus, so the column draws none.
                    className="cursor-pointer outline-none"
                    onClick={follow}
                  >
                    <rect
                      x={Math.max(AXIS_W, x(i) - step / 2)}
                      y={PAD.top}
                      width={Math.max(
                        1,
                        Math.min(x(i) + step / 2, width - PAD.right) -
                          Math.max(AXIS_W, x(i) - step / 2),
                      )}
                      height={plotH}
                      fill="transparent"
                    />
                  </a>
                );
              })}
              {active === null || shown === undefined ? null : (
                <g aria-hidden="true" className="pointer-events-none">
                  <line
                    x1={x(active)}
                    x2={x(active)}
                    y1={PAD.top}
                    y2={y(0)}
                    className="stroke-chart-axis"
                  />
                  <circle cx={x(active)} cy={y(shown.value)} r={4} className="fill-chart-series" />
                </g>
              )}
            </svg>
            <div role="status" className="sr-only">
              {shown === undefined
                ? ''
                : `${shown.label}: ${formatValue(shown.value)}${
                    shownCompare === undefined || compareLabel === undefined
                      ? ''
                      : `, ${compareLabel}: ${formatValue(shownCompare.value)}`
                  }${shownLink === null || labels.openPoint === undefined ? '' : `. ${labels.openPoint}`}`}
            </div>
            {active === null || shown === undefined ? null : (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-0 rounded-md bg-chart-tooltip px-2.5 py-1.5 text-xs text-chart-tooltip-fg shadow"
                style={{
                  left: Math.min(Math.max(x(active), 60), Math.max(width - 60, 60)),
                  transform: 'translateX(-50%)',
                }}
              >
                <div className="text-chart-tooltip-muted">{shown.label}</div>
                <div className="font-semibold">{formatValue(shown.value)}</div>
                {shownCompare === undefined || compareLabel === undefined ? null : (
                  <div className="text-chart-tooltip-muted">
                    {compareLabel}: {formatValue(shownCompare.value)}
                  </div>
                )}
                {shownLink === null || labels.openPointLink === undefined ? null : (
                  // Visible to sighted users that the day opens a list. A real link a finger can
                  // tap (the tooltip lets a touch through); a mouse uses the day's column, so the
                  // tooltip never takes the pointer from the chart.
                  <a
                    href={shownLink.href}
                    tabIndex={-1}
                    data-tooltip-link=""
                    className={`mt-0.5 block font-medium underline ${touched ? 'pointer-events-auto' : ''}`}
                  >
                    {labels.openPointLink}
                  </a>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
