import type { ReactNode } from 'react';

export interface BarListItem {
  readonly id: string;
  readonly label: string;
  /** The figure the bar is drawn from. */
  readonly value: number;
  /** The figure as shown ("A$18,420"). */
  readonly display: string;
  /** A muted second line or figure ("311 orders"). */
  readonly detail?: string;
  /** Makes the row a link to the list it comes from. */
  readonly href?: string;
}

const pct = (value: number, max: number) =>
  max > 0 && Number.isFinite(value) ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;

/**
 * Ranked horizontal bars ("top categories"). A list of text first: the figure is always printed,
 * the bar is a scale cue, so it needs no separate text alternative.
 */
export function BarList({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly BarListItem[];
}) {
  const max = Math.max(0, ...items.map((i) => i.value).filter(Number.isFinite));
  return (
    <ul aria-label={label} className="flex flex-col gap-3">
      {items.map((item) => {
        const body: ReactNode = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 break-words text-fg">{item.label}</span>
              <span className="shrink-0 font-medium text-fg">{item.display}</span>
            </span>
            <span
              aria-hidden="true"
              className="block h-2 w-full overflow-hidden rounded-full bg-chart-track"
            >
              <span
                className="block h-full rounded-full bg-chart-series"
                style={{ width: `${pct(item.value, max)}%` }}
              />
            </span>
            {item.detail === undefined ? null : (
              <span className="text-xs text-fg-muted">{item.detail}</span>
            )}
          </>
        );
        return (
          <li key={item.id}>
            {item.href === undefined ? (
              <div className="flex flex-col gap-1">{body}</div>
            ) : (
              <a href={item.href} className="flex flex-col gap-1 rounded-md hover:bg-muted">
                {body}
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface FunnelStep {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly display: string;
}

/**
 * Order flow as steps whose bars share one left edge (aligned, not centred) and one scale: the
 * first step is the whole. Each later step prints its share of the first.
 */
export function Funnel({
  label,
  steps,
}: {
  readonly label: string;
  readonly steps: readonly FunnelStep[];
}) {
  const first = steps[0]?.value ?? 0;
  return (
    <ol aria-label={label} className="flex flex-col gap-2">
      {steps.map((step, i) => {
        const share = pct(step.value, first);
        return (
          <li key={step.id} className="flex flex-col gap-1">
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 break-words text-fg">{step.label}</span>
              <span className="shrink-0 font-medium text-fg">
                {step.display}
                {i === 0 ? null : (
                  <span className="ms-2 text-xs font-normal text-fg-muted">
                    {Math.round(share)}%
                  </span>
                )}
              </span>
            </span>
            <span
              aria-hidden="true"
              className="block h-3 w-full overflow-hidden rounded-sm bg-chart-track"
            >
              <span
                className={`block h-full rounded-sm ${i === 0 ? 'bg-chart-series' : 'bg-chart-split'}`}
                style={{ width: `${share}%` }}
              />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
